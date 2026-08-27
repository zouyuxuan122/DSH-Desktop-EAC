import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CompanionMessageKind,
  createMessage,
  encodeMessage,
} from './protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const defaultHelperPath = resolve(here, '..', 'runtime', 'helper.py')
const bundledHelperPath = resolve(here, '..', 'runtime', 'bin', 'win32-x64', 'dsh-dafeiyu-helper.exe')
const linuxBundledHelperPath = resolve(here, '..', 'runtime', 'bin', 'linux-x64', 'dsh-dafeiyu-helper')
const darwinBundledHelperPath = resolve(
  here,
  '..',
  'runtime',
  'bin',
  'darwin',
  'dsh-dafeiyu-helper.app',
  'Contents',
  'MacOS',
  'dsh-dafeiyu-helper',
)
const packageVersion = JSON.parse(
  readFileSync(resolve(here, '..', 'package.json'), 'utf8'),
).version
const snapshotMessageKinds = new Set([
  CompanionMessageKind.HELLO,
  CompanionMessageKind.STATE,
  CompanionMessageKind.TASK,
  CompanionMessageKind.TASKS,
  CompanionMessageKind.CONFIG,
])
const coalescibleMessageKinds = new Set([
  ...snapshotMessageKinds,
  CompanionMessageKind.PULSE,
])

function isWsl() {
  if (process.platform !== 'linux') return false
  try {
    return readFileSync('/proc/sys/fs/binfmt_misc/WSLInterop', 'utf8').includes('enabled')
  } catch {
    try {
      return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
    } catch {
      return false
    }
  }
}

function shouldUseBundledHelper() {
  if (process.platform === 'win32' || isWsl()) return existsSync(bundledHelperPath)
  if (process.platform === 'linux') return existsSync(linuxBundledHelperPath)
  return process.platform === 'darwin' && existsSync(darwinBundledHelperPath)
}

function isBundledHelperCommand(command) {
  if (!command) return false
  const filename = String(command).replaceAll('\\', '/').split('/').pop()
  return filename === 'dsh-dafeiyu-helper' || filename === 'dsh-dafeiyu-helper.exe'
}

function ensureExecutable(filePath) {
  try {
    chmodSync(filePath, 0o755)
  } catch {
    // npm archives assembled on another OS may lose the executable bit. The
    // following spawn will surface a useful error if the best-effort repair fails.
  }
}

function toWindowsPath(path) {
  return execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim()
}

function defaultCmdExe({ wslpath = defaultWslPath, fileExists = existsSync } = {}) {
  // WSL visual mode launches the bundled EXE through Windows cmd.exe. cmd.exe
  // is usually NOT on the WSL PATH (System32 is not appended by default), so
  // never rely on `cmd.exe` being resolvable: convert the Windows absolute path
  // with wslpath and only fall back to the bare name as a last resort.
  try {
    const candidate = wslpath('C:\\Windows\\System32\\cmd.exe')
    if (candidate && fileExists(candidate)) return candidate
  } catch {
    // Fall through to the bare-name fallback below.
  }
  return 'cmd.exe'
}

function defaultWslPath(...args) {
  return execFileSync('wslpath', args, { encoding: 'utf8' }).trim()
}

function defaultWindowsLocalAppData({
  cmdExe = defaultCmdExe,
  wslpath = defaultWslPath,
  run = execFileSync,
} = {}) {
  const windowsPath = run(
    cmdExe(),
    ['/d', '/c', 'echo %LOCALAPPDATA%'],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  if (!windowsPath || windowsPath.includes('%LOCALAPPDATA%')) {
    throw new Error('Windows LOCALAPPDATA is unavailable')
  }
  return wslpath('-u', windowsPath)
}

function cacheWslBundledHelper({
  bundledPath,
  version = packageVersion,
  localAppData = defaultWindowsLocalAppData,
  fileExists = existsSync,
  makeDirectory = mkdirSync,
  copyFile = copyFileSync,
  fileStat = statSync,
  moveFile = renameSync,
  removeFile = unlinkSync,
} = {}) {
  const sourceSize = fileStat(bundledPath).size
  const safeVersion = String(version || 'unknown').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
  const cacheDirectory = resolve(localAppData(), 'dsh-dafeiyu', safeVersion)
  // Published versions are immutable. Including the source size also keeps
  // local/repacked builds with the same package version from reusing a stale
  // executable without hashing the large PyInstaller archive on every start.
  const cachedPath = resolve(cacheDirectory, `dsh-dafeiyu-helper-${sourceSize}.exe`)
  if (fileExists(cachedPath) && fileStat(cachedPath).size === sourceSize) return cachedPath
  makeDirectory(cacheDirectory, { recursive: true })
  const temporaryPath = `${cachedPath}.${process.pid}.tmp`
  try {
    copyFile(bundledPath, temporaryPath)
    if (fileExists(cachedPath) && fileStat(cachedPath).size === sourceSize) return cachedPath
    if (fileExists(cachedPath)) removeFile(cachedPath)
    try {
      moveFile(temporaryPath, cachedPath)
    } catch (error) {
      // Another DSH profile may have populated the same immutable cache while
      // this process was copying. Its complete file is safe to reuse.
      if (!fileExists(cachedPath) || fileStat(cachedPath).size !== sourceSize) throw error
    }
  } finally {
    if (fileExists(temporaryPath)) removeFile(temporaryPath)
  }
  return cachedPath
}

function resolveHelperLaunch({
  platform,
  isWslEnv,
  bundledPath,
  linuxBundledPath = linuxBundledHelperPath,
  darwinBundledPath = darwinBundledHelperPath,
  helperPath,
  pythonEnv,
  headless = false,
  fileExists = existsSync,
  windowsPath = toWindowsPath,
  cmdExe = defaultCmdExe,
  wslHelperCache = cacheWslBundledHelper,
}) {
  if (platform === 'win32' && fileExists(bundledPath)) {
    return { command: bundledPath, args: [] }
  }
  if (platform === 'darwin' && fileExists(darwinBundledPath)) {
    return { command: darwinBundledPath, args: [] }
  }
  if (platform === 'linux' && isWslEnv && !headless && fileExists(bundledPath)) {
    // npm archives created on Windows store ordinary files as 0644. Launching
    // the EXE directly from WSL can therefore fail with EACCES. cmd.exe opens
    // the Windows path without relying on the Linux executable bit and keeps
    // stdin/stdout attached for the companion protocol.
    let launchPath = bundledPath
    try {
      // Running a PyInstaller one-file EXE directly from \\wsl.localhost makes
      // Windows read and unpack the archive through the WSL file bridge. That
      // can saturate the WSL VM whenever the plugin starts or is re-enabled.
      // Cache one immutable copy on the Windows filesystem and reuse it.
      launchPath = wslHelperCache({ bundledPath })
    } catch {
      // Cache preparation is an optimization. Keep the existing UNC launch as
      // a compatibility fallback for locked-down or unusual WSL installs.
    }
    return {
      command: cmdExe(),
      args: ['/d', '/c', windowsPath(launchPath)],
    }
  }
  if (platform === 'linux' && fileExists(linuxBundledPath)) {
    return { command: linuxBundledPath, args: [] }
  }
  const command = pythonEnv || (platform === 'win32' ? 'py' : 'python3')
  return { command, args: defaultArgs(command, helperPath) }
}

function defaultLaunch(headless = false) {
  return resolveHelperLaunch({
    platform: process.platform,
    isWslEnv: isWsl(),
    bundledPath: bundledHelperPath,
    linuxBundledPath: linuxBundledHelperPath,
    darwinBundledPath: darwinBundledHelperPath,
    helperPath: defaultHelperPath,
    pythonEnv: process.env.DSH_DAFEIYU_PYTHON,
    headless,
  })
}

function defaultCommand(headless = false) {
  return defaultLaunch(headless).command
}

function defaultArgs(command, helperPath) {
  if (isBundledHelperCommand(command)) return []
  if (process.platform === 'win32' && /(^|[\\/])py(?:\.exe)?$/i.test(command)) {
    return ['-3', helperPath]
  }
  return [helperPath]
}

export class HelperProcess {
  constructor(options = {}, logger = console) {
    this.options = options
    this.logger = logger
    this.child = undefined
    this.queue = []
    this.snapshot = new Map()
    this.spawned = false
    this.hasEverSpawned = false
    this.stopping = false
    this.restartSuppressed = false
    this.startFailures = 0
    this.restartTimer = undefined
    this.heartbeatTimer = undefined
    this.startupTimer = undefined
    this.lastPongAt = 0
    this.readyAt = 0
    this.writeBlocked = false
    this.queueDropWarned = false
  }

  start() {
    if (this.child || this.stopping || this.restartSuppressed) return this.child
    // Resolving the launch command can throw synchronously (e.g. WSL interop
    // probing). Never let that escape: it would crash the host when it happens
    // inside the restart timer. Treat it like any other start failure instead.
    let child
    try {
      const headless = this.options.headless ?? process.env.DSH_DAFEIYU_HEADLESS === '1'
      const helperPath = this.options.helperPath || defaultHelperPath
      const launch = this.options.command
        ? { command: this.options.command, args: defaultArgs(this.options.command, helperPath) }
        : defaultLaunch(headless)
      const command = launch.command
      const args = this.options.args || launch.args
      if (process.platform !== 'win32' && isBundledHelperCommand(command)) {
        ensureExecutable(command)
      }
      const extraArgs = []
      const eventLog = this.options.eventLog || process.env.DSH_DAFEIYU_EVENT_LOG
      const snapshot = this.options.snapshot || process.env.DSH_DAFEIYU_SNAPSHOT
      if (headless) extraArgs.push('--headless')
      if (eventLog) extraArgs.push('--event-log', eventLog)
      if (snapshot) extraArgs.push('--snapshot', snapshot)

      child = spawn(command, [...args, ...extraArgs], {
        cwd: this.options.cwd || resolve(here, '..'),
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.child = undefined
      this.spawned = false
      this.logger.error?.(`dsh-dafeiyu helper failed to start: ${error.message}`)
      if (!this.stopping && !this.restartSuppressed) {
        this.#countStartFailure(`launch error: ${error.message}`)
      }
      return undefined
    }
    this.child = child
    // A broken pipe on any child channel must never crash the DSH host.
    // EPIPE on stdin is expected after the helper dies before we flush.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.once('spawn', () => {
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 60000
      this.startupTimer = setTimeout(() => {
        if (this.child === child && !this.spawned) {
          this.logger.warn?.('dsh-dafeiyu helper readiness timed out')
          child.kill()
        }
      }, startupTimeoutMs)
      this.startupTimer.unref?.()
    })
    child.once('error', (error) => {
      this.logger.error?.(`dsh-dafeiyu helper failed to start: ${error.message}`)
      if (this.child !== child) return
      this.child = undefined
      this.spawned = false
      this.readyAt = 0
      this.writeBlocked = false
      this.#clearHeartbeat()
      this.#clearStartupTimer()
      if (!this.stopping && !this.restartSuppressed) {
        this.#countStartFailure(`spawn error: ${error.message}`)
      }
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      const wasReady = this.spawned
      const readyAt = this.readyAt
      this.spawned = false
      this.readyAt = 0
      this.writeBlocked = false
      this.#clearHeartbeat()
      this.#clearStartupTimer()
      if (!this.stopping && !this.restartSuppressed) {
        if (!wasReady) {
          // The helper never became ready during this attempt (crashed before
          // READY or timed out). Count it as a failed start so a broken
          // helper cannot restart forever.
          this.#countStartFailure(`exited before ready (code=${String(code)}, signal=${String(signal)})`)
          return
        }
        const stableRuntimeMs = this.options.stableRuntimeMs ?? 30000
        const runtimeMs = readyAt > 0 ? Date.now() - readyAt : 0
        if (runtimeMs < stableRuntimeMs) {
          this.#countStartFailure(`exited ${runtimeMs}ms after ready (code=${String(code)}, signal=${String(signal)})`)
          return
        }
        this.startFailures = 0
        this.logger.warn?.(`dsh-dafeiyu helper exited (code=${String(code)}, signal=${String(signal)}); restarting`)
        this.#scheduleRestart()
      }
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.#handleReply(line))
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) this.logger.warn?.(`dsh-dafeiyu helper: ${line}`)
    })
    return child
  }

  send(message) {
    this.#remember(message)
    const line = encodeMessage(message)
    if (!this.child || !this.spawned || !this.child.stdin.writable || this.child.stdin.destroyed) {
      if (!this.hasEverSpawned
        || !coalescibleMessageKinds.has(message.kind)) {
        this.#enqueue(message.kind, line)
      }
      return
    }
    if (this.writeBlocked) {
      this.#enqueue(message.kind, line)
      return
    }
    this.#writePayload(this.child, line)
  }

  stop(reason = 'plugin-disposed') {
    this.stopping = true
    this.#clearHeartbeat()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    if (!child) return
    this.#enqueue(
      CompanionMessageKind.SHUTDOWN,
      encodeMessage(createMessage(CompanionMessageKind.SHUTDOWN, { reason })),
    )
    if (this.spawned) {
      this.#flushQueue()
      this.#endInput(child)
    }
    const timer = setTimeout(() => {
      if (this.child === child) child.kill()
    }, this.options.shutdownTimeoutMs ?? 10000)
    timer.unref?.()
  }

  #remember(message) {
    if (message.kind === CompanionMessageKind.HELLO) this.snapshot.set('hello', encodeMessage(message))
    if (message.kind === CompanionMessageKind.STATE) this.snapshot.set('state', encodeMessage(message))
    if (message.kind === CompanionMessageKind.TASK) this.snapshot.set('task', encodeMessage(message))
    if (message.kind === CompanionMessageKind.TASKS) this.snapshot.set('tasks', encodeMessage(message))
    if (message.kind === CompanionMessageKind.CONFIG) this.snapshot.set('config', encodeMessage(message))
  }

  #flushSnapshot() {
    const child = this.child
    if (this.writeBlocked || !this.spawned || !child?.stdin.writable || child.stdin.destroyed) return
    const payload = [...this.snapshot.values()].join('')
    if (payload) this.#writePayload(child, payload)
  }

  #flushQueue() {
    const child = this.child
    if (this.writeBlocked || !this.spawned || !child?.stdin.writable || child.stdin.destroyed) return
    const payload = this.queue.splice(0).map((item) => item.line).join('')
    if (payload) this.#writePayload(child, payload)
  }

  #enqueue(kind, line) {
    if (kind === CompanionMessageKind.PING) return
    const maxPendingMessages = Math.max(1, this.options.maxPendingMessages ?? 128)
    if (this.queue.length >= maxPendingMessages) {
      const sameKind = coalescibleMessageKinds.has(kind)
        ? this.queue.findIndex((item) => item.kind === kind)
        : -1
      this.queue.splice(sameKind >= 0 ? sameKind : 0, 1)
      if (!this.queueDropWarned) {
        this.queueDropWarned = true
        this.logger.warn?.(`dsh-dafeiyu helper message queue reached ${maxPendingMessages}; dropping stale updates`)
      }
    }
    this.queue.push({ kind, line })
  }

  #writePayload(child, payload) {
    if (!payload || this.child !== child || !child.stdin.writable || child.stdin.destroyed) return
    if (child.stdin.write(payload)) return
    this.writeBlocked = true
    child.stdin.once('drain', () => {
      if (this.child !== child || !this.spawned) return
      this.writeBlocked = false
      this.queueDropWarned = false
      this.#flushQueue()
    })
  }

  #handleReply(line) {
    if (!line.trim()) return
    try {
      const reply = JSON.parse(line)
      if (reply?.protocolVersion === 1 && reply.kind === CompanionMessageKind.READY) {
        if (this.spawned) return
        const firstSpawn = !this.hasEverSpawned
        this.hasEverSpawned = true
        this.spawned = true
        this.readyAt = Date.now()
        this.lastPongAt = Date.now()
        this.#clearStartupTimer()
        if (firstSpawn) this.#flushQueue()
        else {
          this.#flushSnapshot()
          this.#flushQueue()
        }
        this.#startHeartbeat()
        if (this.stopping) this.#endInput(this.child)
        return
      }
      if (reply?.protocolVersion === 1 && reply.kind === CompanionMessageKind.PONG) {
        this.lastPongAt = Date.now()
        return
      }
      if (reply?.protocolVersion === 1 && reply.kind === CompanionMessageKind.CLOSED) {
        this.restartSuppressed = true
        return
      }
      if (reply?.protocolVersion === 1 && reply.kind === CompanionMessageKind.SETTINGS) {
        this.options.onSettingsChange?.(reply)
        return
      }
    } catch {
      // Non-protocol stdout is still useful in development logs.
    }
    this.logger.debug?.(`dsh-dafeiyu helper: ${line}`)
  }

  #startHeartbeat() {
    const heartbeatMs = this.options.heartbeatMs ?? 5000
    if (heartbeatMs <= 0) return
    const timeoutMs = this.options.heartbeatTimeoutMs ?? Math.max(heartbeatMs * 3, 12000)
    this.heartbeatTimer = setInterval(() => {
      const child = this.child
      if (!child || !this.spawned) return
      if (Date.now() - this.lastPongAt > timeoutMs) {
        this.logger.warn?.('dsh-dafeiyu helper heartbeat timed out')
        child.kill()
        return
      }
      this.send(createMessage(CompanionMessageKind.PING))
    }, heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  #clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  #clearStartupTimer() {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  #countStartFailure(reason) {
    this.startFailures += 1
    const maxFailures = this.options.maxStartFailures ?? 5
    if (this.startFailures >= maxFailures) {
      this.restartSuppressed = true
      this.logger.error?.(`dsh-dafeiyu helper failed to start ${this.startFailures} times; giving up (${reason})`)
      return
    }
    this.logger.warn?.(`dsh-dafeiyu helper failed to start; scheduling restart (${this.startFailures}/${maxFailures}) (${reason})`)
    this.#scheduleRestart()
  }

  #scheduleRestart() {
    if (this.restartTimer || this.stopping || this.restartSuppressed) return
    const delay = this.options.restartDelayMs ?? 750
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  #endInput(child) {
    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
  }
}

export {
  bundledHelperPath,
  darwinBundledHelperPath,
  linuxBundledHelperPath,
  defaultHelperPath,
  defaultArgs,
  defaultCmdExe,
  defaultCommand,
  defaultLaunch,
  defaultWindowsLocalAppData,
  cacheWslBundledHelper,
  isBundledHelperCommand,
  isWsl,
  resolveHelperLaunch,
  shouldUseBundledHelper,
  toWindowsPath,
}
