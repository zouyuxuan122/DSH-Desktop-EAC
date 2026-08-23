export const PROTOCOL_VERSION = 1

export const CompanionState = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
})

export const CompanionMessageKind = Object.freeze({
  READY: 'ready',
  HELLO: 'hello',
  STATE: 'state',
  PULSE: 'pulse',
  TASK: 'task',
  PING: 'ping',
  PONG: 'pong',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
})

const states = new Set(Object.values(CompanionState))
const kinds = new Set(Object.values(CompanionMessageKind))

export function createMessage(kind, payload = {}) {
  if (!kinds.has(kind)) throw new TypeError(`Unknown companion message kind: ${kind}`)
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind,
    timestamp: Date.now(),
    ...payload,
  }
}

export function assertCompanionMessage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Companion message must be an object')
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported protocol version: ${String(value.protocolVersion)}`)
  }
  if (!kinds.has(value.kind)) throw new TypeError(`Unknown companion message kind: ${String(value.kind)}`)
  if ((value.kind === CompanionMessageKind.STATE || value.kind === CompanionMessageKind.PULSE)
    && !states.has(value.state)) {
    throw new TypeError(`Unknown companion state: ${String(value.state)}`)
  }
  return value
}

export function encodeMessage(message) {
  assertCompanionMessage(message)
  return `${JSON.stringify(message)}\n`
}
