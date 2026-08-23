const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  thresholdRatio: 0.75,
  retainRatio: 0.20,
  recoverOnOverflow: true,
  maxOverflowRetries: 1,
  modelPolicies: Object.freeze([]),
})

const MIN_THRESHOLD_RATIO = 0.50
const MAX_THRESHOLD_RATIO = 0.95
const MIN_RETAIN_RATIO = 0.05
const MAX_RETAIN_RATIO = 0.50

let sharedConfig = DEFAULT_CONFIG

function freezeConfig(value) {
  const modelPolicies = Object.freeze(value.modelPolicies.map((policy) => Object.freeze({ ...policy })))
  return Object.freeze({ ...value, modelPolicies })
}

function finiteRatio(value, fallback, min, max, label) {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new TypeError(`${label} must be between ${min} and ${max}`)
  }
  return resolved
}

function normalizePolicy(input, index) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`modelPolicies[${index}] must be an object`)
  }
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!provider || !model) throw new TypeError(`modelPolicies[${index}] requires provider and model`)
  const policy = { provider, model }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new TypeError(`modelPolicies[${index}].enabled must be a boolean`)
    policy.enabled = input.enabled
  }
  if (input.recoverOnOverflow !== undefined) {
    if (typeof input.recoverOnOverflow !== 'boolean') {
      throw new TypeError(`modelPolicies[${index}].recoverOnOverflow must be a boolean`)
    }
    policy.recoverOnOverflow = input.recoverOnOverflow
  }
  if (input.thresholdRatio !== undefined) {
    policy.thresholdRatio = finiteRatio(
      input.thresholdRatio,
      DEFAULT_CONFIG.thresholdRatio,
      MIN_THRESHOLD_RATIO,
      MAX_THRESHOLD_RATIO,
      `modelPolicies[${index}].thresholdRatio`,
    )
  }
  if (input.retainRatio !== undefined) {
    policy.retainRatio = finiteRatio(
      input.retainRatio,
      DEFAULT_CONFIG.retainRatio,
      MIN_RETAIN_RATIO,
      MAX_RETAIN_RATIO,
      `modelPolicies[${index}].retainRatio`,
    )
  }
  if (input.maxOverflowRetries !== undefined) {
    if (input.maxOverflowRetries !== 0 && input.maxOverflowRetries !== 1) {
      throw new TypeError(`modelPolicies[${index}].maxOverflowRetries must be 0 or 1`)
    }
    policy.maxOverflowRetries = input.maxOverflowRetries
  }
  return policy
}

export function sanitizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-compact config must be an object')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean')
  }
  if (input.recoverOnOverflow !== undefined && typeof input.recoverOnOverflow !== 'boolean') {
    throw new TypeError('recoverOnOverflow must be a boolean')
  }
  if (input.modelPolicies !== undefined && !Array.isArray(input.modelPolicies)) {
    throw new TypeError('modelPolicies must be an array')
  }
  const thresholdRatio = finiteRatio(
    input.thresholdRatio,
    DEFAULT_CONFIG.thresholdRatio,
    MIN_THRESHOLD_RATIO,
    MAX_THRESHOLD_RATIO,
    'thresholdRatio',
  )
  const retainRatio = finiteRatio(
    input.retainRatio,
    DEFAULT_CONFIG.retainRatio,
    MIN_RETAIN_RATIO,
    MAX_RETAIN_RATIO,
    'retainRatio',
  )
  if (retainRatio >= thresholdRatio) throw new TypeError('retainRatio must be less than thresholdRatio')
  const maxOverflowRetries = input.maxOverflowRetries ?? DEFAULT_CONFIG.maxOverflowRetries
  if (maxOverflowRetries !== 0 && maxOverflowRetries !== 1) {
    throw new TypeError('maxOverflowRetries must be 0 or 1')
  }
  const modelPolicies = (input.modelPolicies ?? []).map(normalizePolicy)
  const seen = new Set()
  for (const [index, policy] of modelPolicies.entries()) {
    const effectiveThreshold = policy.thresholdRatio ?? thresholdRatio
    const effectiveRetain = policy.retainRatio ?? retainRatio
    if (effectiveRetain >= effectiveThreshold) {
      throw new TypeError(`modelPolicies[${index}].retainRatio must be less than thresholdRatio`)
    }
    const key = `${policy.provider}\0${policy.model}`
    if (seen.has(key)) throw new TypeError(`duplicate model policy for ${policy.provider}/${policy.model}`)
    seen.add(key)
  }
  return freezeConfig({
    enabled: input.enabled !== false,
    thresholdRatio,
    retainRatio,
    recoverOnOverflow: input.recoverOnOverflow !== false,
    maxOverflowRetries,
    modelPolicies,
  })
}

export function resolvePolicy(config, target) {
  const base = sanitizeConfig(config)
  const override = target
    ? base.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model)
    : undefined
  return Object.freeze({
    enabled: override?.enabled ?? base.enabled,
    thresholdRatio: override?.thresholdRatio ?? base.thresholdRatio,
    retainRatio: override?.retainRatio ?? base.retainRatio,
    recoverOnOverflow: override?.recoverOnOverflow ?? base.recoverOnOverflow,
    maxOverflowRetries: override?.maxOverflowRetries ?? base.maxOverflowRetries,
  })
}

export function toBasicResolvedConfig(config) {
  const resolved = sanitizeConfig(config)
  return Object.freeze({
    thresholdRatio: resolved.thresholdRatio,
    retainRatio: resolved.retainRatio,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 8192,
    // BasicCompactionEngine counts this as extra attempts after the first one.
    // Keep one pressure check to one durable summary; a later turn can compact again.
    compactionRetries: 0,
    maxOverflowRetries: resolved.maxOverflowRetries,
    modelPolicies: Object.freeze(resolved.modelPolicies.map((policy) => Object.freeze({
      provider: policy.provider,
      model: policy.model,
      ...(policy.thresholdRatio === undefined ? {} : { thresholdRatio: policy.thresholdRatio }),
      ...(policy.retainRatio === undefined ? {} : { retainRatio: policy.retainRatio }),
      ...(policy.maxOverflowRetries === undefined ? {} : { maxOverflowRetries: policy.maxOverflowRetries }),
    }))),
    auto: false,
  })
}

export function setSharedConfig(config) {
  sharedConfig = sanitizeConfig(config)
  return sharedConfig
}

export function getSharedConfig() {
  return sharedConfig
}

export function resetSharedConfig() {
  sharedConfig = DEFAULT_CONFIG
}

export function sessionIdOf(agent) {
  return String(agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id ?? '')
}

export function routedTargetOf(agent) {
  const requestConfig = agent?.session?.requestHeader?.()?.config
  if (requestConfig?.provider && requestConfig?.model) {
    return { provider: requestConfig.provider, model: requestConfig.model }
  }
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

class StatusStore {
  #values = new Map()

  get(sessionId) {
    const id = String(sessionId ?? '')
    return this.#values.get(id) ?? Object.freeze({
      sessionId: id,
      state: 'idle',
      active: false,
      updatedAt: null,
    })
  }

  set(sessionId, patch) {
    const id = String(sessionId ?? '')
    if (!id) return this.get(id)
    const next = Object.freeze({
      ...this.get(id),
      ...patch,
      sessionId: id,
      updatedAt: new Date().toISOString(),
    })
    this.#values.set(id, next)
    return next
  }

  clear(sessionId) {
    this.#values.delete(String(sessionId ?? ''))
  }
}

export const compactStatus = new StatusStore()
export { DEFAULT_CONFIG }
