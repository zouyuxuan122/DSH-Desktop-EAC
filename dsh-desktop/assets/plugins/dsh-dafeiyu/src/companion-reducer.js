import {
  CompanionMessageKind,
  CompanionState,
  createMessage,
} from './protocol.js'
import {
  activityCopy,
  activityStage,
  statusCopy,
  taskCopy,
} from './status-copy.js'

const statePriority = Object.freeze({
  [CompanionState.WAITING]: 60,
  [CompanionState.ERROR]: 50,
  [CompanionState.WORKING]: 30,
  [CompanionState.THINKING]: 20,
  [CompanionState.IDLE]: 0,
  [CompanionState.DISCONNECTED]: -1,
})

function toolActivity(name) {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value)) return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value)) return 'editing'
  if (/test|check|lint|build|verify/.test(value)) return 'testing'
  if (/shell|bash|exec|command|terminal|powershell/.test(value)) return 'commanding'
  return 'using-tool'
}

function toolCallIdOf(event, fallback = '') {
  const content = event?.data?.message?.content
  const contentCallId = Array.isArray(content)
    ? content.find((item) => item?.toolCallId)?.toolCallId
    : undefined
  return String(event?.data?.message?.source?.callId
    ?? contentCallId
    ?? event?.data?.message?.toolCallId
    ?? event?.data?.message?.callId
    ?? event?.data?.callId
    ?? fallback)
}

function isUserQuestionTool(name) {
  // Operate on whole name tokens instead of substring regexes: `_` is a word
  // character so `\b` does not delimit snake_case, and bare substrings like
  // "review", "allow" or "permission" turn ordinary tools (code_review,
  // allowlist_files, permission_scan) into fake "waiting for user" states.
  const value = String(name || '').toLowerCase()
  const tokens = value.split(/[^a-z0-9]+/u).filter(Boolean)

  const asks = new Set(['ask', 'asking', 'request', 'requests', 'requesting', 'require', 'requires', 'prompt', 'needs', 'need', 'seek', 'seeks', 'get', 'gets'])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set(['question', 'questions', 'input', 'answer', 'answers', 'decision', 'decisions', 'confirmation', 'approval', 'permission', 'authorization', 'authorisation', 'consent', 'clarify', 'clarification', 'help'])

  // user/human <noun> or <noun> from user/human
  const hasUserNoun = tokens.some((token, index) =>
    userWords.has(token) && nouns.has(tokens[index + 1] ?? '')
  )
  const hasNounFromUser = tokens.some((token, index) =>
    nouns.has(token) && tokens[index + 1] === 'from' && userWords.has(tokens[index + 2] ?? '')
  )
  // verb [for/the] [user] <noun>, or verb followed by user (optionally + noun)
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token)) return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })
  // Unambiguous approval words that always mean "waiting for the human".
  const strong = tokens.some((token) =>
    token === 'authorize' || token === 'authorise' || token === 'consent'
  )
  // Plan mode submits its completed plan through exit_plan_mode and then
  // blocks until the user approves or rejects it. Treat only that exact token
  // sequence as a question so enter_plan_mode and ordinary planning tools do
  // not produce false waiting states.
  const submitsPlanForApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode'
  )
  return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval
}

function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown-session')
}

function isSubagent(session) {
  return session?.header?.origin === 'subagent'
    || Number(session?.header?.delegationDepth ?? 0) > 0
}

function cleanProjectName(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const pathParts = text.split(/[\\/]/u).filter(Boolean)
  const candidate = pathParts.length > 1 ? pathParts.at(-1) : text
  return candidate.replace(/\s+/gu, ' ').slice(0, 40) || undefined
}

function projectNameOf(session, event) {
  // Prefer the freshest "what am I working on" signal. The session header
  // (title/name/cwd) is frozen when the session starts, so after a project
  // folder is renamed mid-run the header still reports the old path/name while
  // the live working directory (or the step's own cwd/projectName) already
  // points at the new folder. Keeping the stale header at the front is why the
  // bubble kept showing the old name. Order: explicit step projectName, the
  // session's live cwd, then progressively older cwd snapshots, and only then
  // the human labels which can lag behind a rename.
  const candidates = [
    event?.data?.projectName,
    session?.cwd,
    session?.context?.cwd,
    session?.header?.cwd,
    event?.data?.cwd,
    session?.title,
    session?.name,
    session?.header?.title,
    session?.header?.name,
  ]
  return candidates.map(cleanProjectName).find(Boolean)
}

function progressOf(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const completed = todos.filter((todo) => ['completed', 'complete', 'done'].includes(todo?.status)).length
  const currentIndex = todos.findIndex((todo) => todo?.status === 'in_progress')
  return {
    completed,
    total: todos.length,
    current: currentIndex >= 0 ? currentIndex + 1 : undefined,
  }
}

function reasoningEffortOf(event) {
  const value = event?.data?.header?.config?.reasoningEffort
  if (typeof value !== 'string') return undefined
  return value.trim().replace(/\s+/gu, ' ').slice(0, 24) || undefined
}

function detailFor(record, stage = record.payload.stage) {
  const parts = []
  if (record.project) parts.push(record.project)
  if (record.reasoningEffort) parts.push(`推理 ${record.reasoningEffort}`)
  if (record.progress?.total) parts.push(`已完成 ${record.progress.completed}/${record.progress.total} 步`)
  if (record.task) parts.push(record.task)
  else if (stage) parts.push(stage)
  return parts.join(' · ') || stage || 'DSH 任务'
}

export class CompanionReducer {
  constructor({ includeSubagents = false, maxSessions = 256 } = {}) {
    this.includeSubagents = includeSubagents
    this.sessions = new Map()
    this.maxSessions = maxSessions
    this.clock = 0
    this.selectedSessionId = undefined
    this.outputSignature = undefined
    this.tasksSignature = undefined
  }

  setIncludeSubagents(value) {
    const includeSubagents = value === true
    if (includeSubagents === this.includeSubagents) return []
    this.includeSubagents = includeSubagents
    if (!includeSubagents) {
      for (const [sessionId, record] of this.sessions) {
        if (record.subagent) this.sessions.delete(sessionId)
      }
    }
    return this.#render()
  }

  handle(session, event) {
    if (!event || typeof event.type !== 'string') return []
    const subagent = isSubagent(session)
    if (!this.includeSubagents && subagent) return []

    const sessionId = sessionIdOf(session)
    const record = this.#record(sessionId)
    record.subagent = subagent
    record.lastSeq = Number(event.seq ?? record.lastSeq)
    record.project = projectNameOf(session, event) ?? record.project

    switch (event.type) {
      case 'turn/start':
        record.turnActive = true
        record.openTools.clear()
        record.waitingCallId = undefined
        record.waitingApprovalId = undefined
        record.task = undefined
        record.progress = undefined
        this.#update(record, CompanionState.THINKING, {
          phase: 'turn-start',
          stage: '准备阶段',
          message: statusCopy('preparing', event.seq),
        })
        return this.#render()

      case 'step/start':
      case 'assistant/chunk':
      case 'assistant/message':
        if (!record.turnActive || record.openTools.size > 0) return []
        if (record.state === CompanionState.THINKING && record.payload.phase === 'thinking') return []
        this.#update(record, CompanionState.THINKING, {
          phase: 'thinking',
          stage: '分析阶段',
          message: statusCopy('thinking', event.seq),
        })
        return this.#render()

      case 'request/header': {
        const reasoningEffort = reasoningEffortOf(event)
        if (reasoningEffort === record.reasoningEffort) return []
        record.reasoningEffort = reasoningEffort
        record.updatedAt = ++this.clock
        return this.#render()
      }

      case 'tool/call': {
        const callId = toolCallIdOf(event, `seq-${String(event.seq ?? 'unknown')}`)
        const name = String(event.data?.name ?? event.data?.message?.name ?? 'tool')
        record.openTools.set(callId, name)
        if (isUserQuestionTool(name)) {
          record.waitingCallId = callId
          this.#update(record, CompanionState.WAITING, {
            phase: 'user-question',
            stage: '等待确认',
            toolName: name,
            message: statusCopy('waiting', event.seq),
          })
          return this.#render()
        }
        const activity = toolActivity(name)
        this.#update(record, CompanionState.WORKING, {
          phase: 'tool-call',
          activity,
          stage: activityStage(activity),
          toolName: name,
          message: activityCopy(activity, event.seq),
        })
        return this.#render()
      }

      case 'tool/result':
        return this.#toolResult(record, event)

      case 'user/message':
        return this.#userMessage(record, event)

      case 'todo/write':
        return this.#todo(record, event)

      case 'turn/end':
        return this.#turnEnd(record, event)

      case 'approval/asked': {
        const id = String(event.data?.id ?? '')
        const toolName = String(event.data?.toolName ?? 'approval')
        record.waitingApprovalId = id
        this.#update(record, CompanionState.WAITING, {
          phase: 'approval',
          stage: '等待审批',
          toolName,
          message: statusCopy('approval', event.seq),
        })
        return this.#render()
      }

      case 'approval/decided':
        return this.#approvalDecided(record, event)

      default:
        return []
    }
  }

  disposeSession(session) {
    const sessionId = sessionIdOf(session)
    const existed = this.sessions.delete(sessionId)
    if (!existed) return []
    return this.#render()
  }

  #toolResult(record, event) {
    const callId = toolCallIdOf(event)
    if (callId) record.openTools.delete(callId)
    if (callId && callId === record.waitingCallId) record.waitingCallId = undefined
    return this.#resumeAfterTool(record, event)
  }

  #userMessage(record, event) {
    if (!record.waitingCallId) return []
    record.openTools.delete(record.waitingCallId)
    record.waitingCallId = undefined
    return this.#resumeAfterTool(record, event)
  }


  #approvalDecided(record, event) {
    const id = String(event.data?.id ?? '')
    if (!record.waitingApprovalId || id !== record.waitingApprovalId) return []
    record.waitingApprovalId = undefined
    return this.#resumeAfterTool(record, event)
  }

  #resumeAfterTool(record, event) {
    if (record.waitingCallId && record.openTools.has(record.waitingCallId)) {
      return this.#render()
    }
    const next = record.openTools.size > 0 ? CompanionState.WORKING : CompanionState.THINKING
    const nextPayload = {
      phase: 'tool-result',
      activity: next === CompanionState.WORKING
        ? toolActivity(record.openTools.values().next().value)
        : undefined,
      stage: next === CompanionState.WORKING
        ? activityStage(toolActivity(record.openTools.values().next().value))
        : '整理阶段',
      message: next === CompanionState.WORKING
        ? activityCopy(toolActivity(record.openTools.values().next().value), event.seq)
        : statusCopy('result', event.seq),
    }
    this.#update(record, next, nextPayload)
    if (!event.data?.error) return this.#render()

    const selection = this.#select()
    if (selection.record.state === CompanionState.WAITING || selection.record.state === CompanionState.ERROR) {
      return this.#render(selection)
    }
    this.#remember(selection)
    return this.#withTasks([createMessage(CompanionMessageKind.PULSE, {
      sessionId: record.id,
      sourceSeq: event.seq,
      state: CompanionState.ERROR,
      ttlMs: 1800,
      resumeState: selection.record.state,
      resumeActivity: selection.record.payload.activity,
      resumeMessage: selection.record.payload.message,
      resumeDetail: detailFor(selection.record),
      message: statusCopy('toolError', event.seq),
      detail: detailFor(record),
      errorCode: event.data.error.code,
    })])
  }

  #todo(record, event) {
    const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
    const current = todos.find((todo) => todo?.status === 'in_progress')
      ?? todos.find((todo) => todo?.status === 'pending')
    const progress = progressOf(todos)
    if (!current?.content && !progress) return []
    const nextTask = current?.content ? String(current.content) : record.task
    const unchanged = nextTask === record.task
      && progress?.completed === record.progress?.completed
      && progress?.total === record.progress?.total
    if (unchanged) return []
    record.task = nextTask
    record.progress = progress
    record.updatedAt = ++this.clock
    const selection = this.#select()
    if (selection.record.id !== record.id) return this.#render(selection)
    return this.#withTasks([createMessage(CompanionMessageKind.TASK, {
      sessionId: record.id,
      sourceSeq: event.seq,
      task: record.task,
      progress: record.progress,
      project: record.project,
      message: taskCopy(record.task),
      detail: detailFor(record, '执行阶段'),
    })])
  }

  #turnEnd(record, event) {
    record.turnActive = false
    record.openTools.clear()
    record.waitingCallId = undefined
    record.waitingApprovalId = undefined
    const kind = String(event.data?.reason?.kind ?? 'completed')

    if (kind === 'blocked') {
      this.#update(record, CompanionState.WAITING, {
        phase: 'turn-end',
        stage: '等待确认',
        message: statusCopy('waiting', event.seq),
      })
      return this.#render()
    }

    if (kind === 'aborted') {
      this.#update(record, CompanionState.IDLE, {
        phase: 'turn-end',
        stage: '已停止',
        message: statusCopy('stopped', event.seq),
      })
      return this.#render()
    }

    if (kind !== 'completed') {
      this.#update(record, CompanionState.ERROR, {
        phase: 'turn-end',
        stage: '需要处理',
        reasonKind: kind,
        message: kind === 'max-tokens'
          ? statusCopy('limit', event.seq)
          : statusCopy('error', event.seq),
      })
      return this.#render()
    }

    this.#update(record, CompanionState.IDLE, {
      phase: 'turn-end',
      stage: '已完成',
      message: statusCopy('idle', event.seq),
    })
    const selection = this.#select()
    if ([CompanionState.WAITING, CompanionState.ERROR].includes(selection.record.state)) {
      return this.#render(selection)
    }
    this.#remember(selection)
    return this.#withTasks([createMessage(CompanionMessageKind.PULSE, {
      sessionId: record.id,
      sourceSeq: event.seq,
      state: CompanionState.SUCCESS,
      resumeState: selection.record.state,
      resumeActivity: selection.record.payload.activity,
      resumeMessage: selection.record.payload.message,
      resumeDetail: detailFor(selection.record),
      ttlMs: 2200,
      phase: 'turn-end',
      message: statusCopy('success', event.seq),
      detail: detailFor(record, '本轮已完成'),
    })])
  }

  #record(sessionId) {
    let record = this.sessions.get(sessionId)
    if (record) return record
    record = {
      id: sessionId,
      state: CompanionState.IDLE,
      payload: { phase: 'session-created', message: 'DSH 空闲中' },
      turnActive: false,
      openTools: new Map(),
      waitingCallId: undefined,
      waitingApprovalId: undefined,
      task: undefined,
      progress: undefined,
      project: undefined,
      reasoningEffort: undefined,
      subagent: false,
      lastSeq: -1,
      updatedAt: ++this.clock,
    }
    this.sessions.set(sessionId, record)
    // DSH normally disposes sessions, but never rely on it: cap the map so a
    // host that stops emitting `session/disposed` cannot leak memory forever.
    // The freshly-inserted record is still IDLE at this point, so keep it and
    // evict the oldest existing idle record (or the oldest overall).
    if (this.sessions.size > this.maxSessions && this.maxSessions > 0) this.#evictSessions(record)
    return record
  }

  #evictSessions(keep) {
    const records = [...this.sessions.values()].filter((record) => record !== keep)
    const idle = records
      .filter((record) => record.state === CompanionState.IDLE)
      .sort((left, right) => left.updatedAt - right.updatedAt)
    const victim = idle[0] ?? records.sort((left, right) => left.updatedAt - right.updatedAt)[0]
    if (victim) this.sessions.delete(victim.id)
  }

  #update(record, state, payload) {
    record.state = state
    record.payload = payload
    record.updatedAt = ++this.clock
  }

  #select() {
    const records = [...this.sessions.values()]
    if (records.length === 0) {
      return {
        record: {
          id: 'dsh-host',
          state: CompanionState.IDLE,
          payload: { phase: 'no-session', message: 'DSH 空闲中' },
          updatedAt: ++this.clock,
        },
      }
    }
    records.sort((left, right) => {
      const priority = (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0)
      return priority || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
    })
    return { record: records[0] }
  }

  #render(selection = this.#select()) {
    const messages = []
    const signature = this.#signature(selection.record)
    if (signature !== this.outputSignature) {
      this.#remember(selection)
      messages.push(createMessage(CompanionMessageKind.STATE, {
        sessionId: selection.record.id,
        state: selection.record.state,
        ...selection.record.payload,
        task: selection.record.task,
        progress: selection.record.progress,
        project: selection.record.project,
        reasoningEffort: selection.record.reasoningEffort,
        detail: detailFor(selection.record),
      }))
    }
    messages.push(...this.#taskMessages())
    return messages
  }

  #taskMessages() {
    const tasks = this.#activeTaskList()
    if (tasks.length < 2) {
      if (this.tasksSignature !== undefined) {
        this.tasksSignature = undefined
        return [createMessage(CompanionMessageKind.TASKS, { tasks: [] })]
      }
      return []
    }
    const signature = tasks.map((task) => [
      task.sessionId,
      task.state,
      task.project ?? '',
      task.task ?? '',
      task.message ?? '',
      task.detail ?? '',
    ].join('|')).join('~')
    if (signature === this.tasksSignature) return []
    this.tasksSignature = signature
    return [createMessage(CompanionMessageKind.TASKS, { tasks })]
  }

  #activeTaskList() {
    return [...this.sessions.values()]
      .filter((record) => record.state !== CompanionState.IDLE && record.state !== CompanionState.DISCONNECTED)
      .sort((left, right) => {
        const priority = (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0)
        return priority || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
      })
      .map((record) => ({
        sessionId: record.id,
        state: record.state,
        project: record.project,
        task: record.task,
        reasoningEffort: record.reasoningEffort,
        message: record.payload.message,
        detail: detailFor(record),
      }))
  }

  #withTasks(messages) {
    return [...messages, ...this.#taskMessages()]
  }

  #remember(selection) {
    this.selectedSessionId = selection.record.id
    this.outputSignature = this.#signature(selection.record)
  }

  #signature(record) {
    return [
      record.id,
      record.state,
      record.payload.activity ?? '',
      record.payload.toolName ?? '',
      record.payload.message ?? '',
      record.project ?? '',
      record.task ?? '',
      record.progress?.completed ?? '',
      record.progress?.total ?? '',
      record.reasoningEffort ?? '',
    ].join('|')
  }
}

export { isUserQuestionTool, statePriority, toolActivity, toolCallIdOf }
