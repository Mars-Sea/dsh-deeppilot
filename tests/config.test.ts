import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, normalizeOptions, plainConfig } from '../src/config.ts'

/** Stand-in for the 0.1.7 volatile reference ({ get() }). */
const ref = (value: unknown): { get: () => unknown } => ({ get: () => value })

test('plainConfig unwraps volatile references at any depth', () => {
  assert.equal(plainConfig(ref('hello')), 'hello')
  assert.equal(plainConfig(ref(true)), true)
  assert.deepEqual(
    plainConfig({
      enabled: ref(true),
      devicesPath: '/tmp/devices.json',
      local: { enabled: ref(false), port: ref(3098) },
      list: [ref(1), 2, ref('three')],
    }),
    {
      enabled: true,
      devicesPath: '/tmp/devices.json',
      local: { enabled: false, port: 3098 },
      list: [1, 2, 'three'],
    },
  )
  // Scalars and null pass through untouched.
  assert.equal(plainConfig(null), null)
  assert.equal(plainConfig(42), 42)
  // A reference whose snapshot carries plain data resolves fully plain.
  assert.deepEqual(plainConfig(ref({ nested: { flag: ref('x') } })), { nested: { flag: 'x' } })
})

test('plainConfig never mistakes plain config values for references', () => {
  // JSON-shaped config values cannot carry functions, so a `get` key with a
  // non-function value must stay data.
  const value = { get: 'not-a-function', enabled: true }
  assert.deepEqual(plainConfig(value), value)
})

test('normalizeOptions unwraps references from apply() options', () => {
  const config = normalizeOptions({
    enabled: ref(true),
    devicesPath: '/tmp/devices.json',
    local: { enabled: ref(true), port: ref(4000) },
    remote: ref({ enabled: false }),
  })
  // The bridge compares plain values (=== true, numeric bounds); a surviving
  // reference object would silently fail every one of those checks.
  assert.equal(config.enabled, true)
  assert.equal(typeof config.enabled, 'boolean')
  assert.equal(config.local?.port, 4000)
  assert.equal(config.local?.enabled, true)
  assert.deepEqual(config.remote, { enabled: false })
})

test('normalizeOptions unwraps a reactive options getter result', () => {
  const config = normalizeOptions(() => ({ enabled: ref(false), historyBufferMax: ref(1500) }))
  assert.equal(config.enabled, false)
  assert.equal(config.historyBufferMax, 1500)
})

test('normalizeOptions(undefined) returns plain defaults', () => {
  const config = normalizeOptions(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.debug, false)
  assert.equal(config.local?.enabled, true)
  assert.equal(typeof config.local?.port, 'number')
  assert.equal(config.remote?.enabled, false)
  // Every leaf must be plain data — a stray reference would read as undefined
  // through the strict comparisons the bridge uses.
  const leaves: unknown[] = []
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') { leaves.push(value); return }
    if (typeof (value as { get?: unknown }).get === 'function') { leaves.push('REFERENCE'); return }
    if (Array.isArray(value)) { value.forEach(walk); return }
    Object.values(value).forEach(walk)
  }
  walk(config)
  assert.ok(!leaves.includes('REFERENCE'), 'defaults contain no volatile references')
})

test('the dev schemastery really wraps volatile fields, and unwrap hides them', () => {
  // The rc.1 schema carries { get() } references for volatile fields.
  const raw = Config({}) as { local?: unknown; enabled?: unknown }
  const isRef = (value: unknown): boolean =>
    value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
  assert.equal(isRef(raw.local), true, 'Config({}) must wrap the volatile local object in a reference')
  assert.equal(isRef(raw.enabled), true, 'Config({}) must wrap the volatile enabled flag in a reference')

  const normalized = normalizeOptions(raw)
  assert.equal(isRef(normalized.local), false)
  assert.equal(normalized.local?.enabled, true)
  assert.equal(normalized.enabled, true)
})
