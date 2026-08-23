import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  compactStatus,
  resolvePolicy,
  sanitizeConfig,
  toBasicResolvedConfig,
} from '../assets/plugins/dsh-compact/lib/policy.js'

test('dsh-compact policy: defaults are safe and enabled', () => {
  assert.deepEqual(sanitizeConfig({}), DEFAULT_CONFIG)
})

test('dsh-compact policy: validates ratios, retries, duplicates and target identity', () => {
  assert.throws(() => sanitizeConfig({ thresholdRatio: 0.49 }), /thresholdRatio/)
  assert.throws(() => sanitizeConfig({ retainRatio: 0.51 }), /retainRatio/)
  assert.throws(() => sanitizeConfig({ thresholdRatio: 0.5, retainRatio: 0.5 }), /less/)
  assert.throws(() => sanitizeConfig({ maxOverflowRetries: 2 }), /0 or 1/)
  assert.throws(() => sanitizeConfig({ enabled: 'yes' }), /boolean/)
  assert.throws(() => sanitizeConfig({ recoverOnOverflow: 1 }), /boolean/)
  assert.throws(() => sanitizeConfig({ modelPolicies: {} }), /array/)
  assert.throws(() => sanitizeConfig({ modelPolicies: [{ provider: '', model: 'x' }] }), /provider/)
  assert.throws(() => sanitizeConfig({
    modelPolicies: [{ provider: 'p', model: 'm', enabled: 'yes' }],
  }), /boolean/)
  assert.throws(() => sanitizeConfig({
    modelPolicies: [
      { provider: 'deepseek', model: 'chat' },
      { provider: 'deepseek', model: 'chat' },
    ],
  }), /duplicate/)
})

test('dsh-compact policy: exact provider/model override wins without affecting defaults', () => {
  const config = sanitizeConfig({
    thresholdRatio: 0.75,
    retainRatio: 0.2,
    modelPolicies: [{
      provider: 'openai',
      model: 'gpt-x',
      enabled: false,
      thresholdRatio: 0.9,
      retainRatio: 0.3,
      recoverOnOverflow: false,
      maxOverflowRetries: 0,
    }],
  })
  assert.deepEqual(resolvePolicy(config, { provider: 'openai', model: 'gpt-x' }), {
    enabled: false,
    thresholdRatio: 0.9,
    retainRatio: 0.3,
    recoverOnOverflow: false,
    maxOverflowRetries: 0,
  })
  assert.equal(resolvePolicy(config, { provider: 'openai', model: 'other' }).thresholdRatio, 0.75)
})

test('dsh-compact policy: parent engine performs one compaction attempt per pressure check', () => {
  const config = toBasicResolvedConfig({
    thresholdRatio: 0.7,
    retainRatio: 0.1,
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.8 }],
  })
  assert.equal(config.auto, false)
  assert.equal(config.compactionRetries, 0)
  assert.equal(config.modelPolicies[0].thresholdRatio, 0.8)
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.modelPolicies))
})

test('dsh-compact status: session state is isolated', () => {
  compactStatus.clear('a')
  compactStatus.clear('b')
  compactStatus.set('a', { state: 'measuring', active: true })
  compactStatus.set('b', { state: 'failed', active: false, error: 'x' })
  assert.equal(compactStatus.get('a').state, 'measuring')
  assert.equal(compactStatus.get('b').state, 'failed')
  assert.equal(compactStatus.get('missing').state, 'idle')
})
