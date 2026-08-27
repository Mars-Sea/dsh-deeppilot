import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UpdateChecker,
  compareSemver,
  parseStableTag,
} from '../src/update-check.ts'

/** Quiet logger for tests — keeps the output clean. */
const silentLog = (): void => {}

test('parseStableTag accepts v-prefixed and bare X.Y.Z', () => {
  assert.deepEqual(parseStableTag('0.2.1'), { major: 0, minor: 2, patch: 1 })
  assert.deepEqual(parseStableTag('v1.0.0'), { major: 1, minor: 0, patch: 0 })
  assert.deepEqual(parseStableTag('  v10.20.30  '), { major: 10, minor: 20, patch: 30 })
})

test('parseStableTag rejects pre-release and malformed tags', () => {
  assert.equal(parseStableTag('0.3.0-rc.1'), null)
  assert.equal(parseStableTag('0.3'), null)
  assert.equal(parseStableTag('0.3.0.4'), null)
  assert.equal(parseStableTag('v0'), null)
  assert.equal(parseStableTag(''), null)
})

test('compareSemver orders patch, minor, major correctly', () => {
  assert.equal(compareSemver('0.2.0', '0.2.1'), -1)
  assert.equal(compareSemver('0.2.1', '0.2.0'), 1)
  assert.equal(compareSemver('0.2.0', '0.2.0'), 0)
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1)
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1)
})

test('compareSemver treats unparseable inputs as smaller than parseable ones', () => {
  // A malformed remote tag must not claim a false "newer" status.
  assert.equal(compareSemver('garbage', '0.2.0'), -1)
  assert.equal(compareSemver('0.2.0', 'garbage'), 1)
  assert.equal(compareSemver('garbage', 'also-garbage'), 0)
})

test('UpdateChecker: cold start reports no update before the network answers', () => {
  const checker = new UpdateChecker({
    log: silentLog,
    currentVersion: '0.2.1',
    initialDelayMs: 0,
    fetchImpl: async () => null,
  })
  const info = checker.get()
  assert.equal(info.currentVersion, '0.2.1')
  assert.equal(info.available, false)
  assert.equal(info.releaseUrl, null)
  assert.equal(info.latestVersion, null)
})

test('UpdateChecker: network answer newer than current flips available to true', async () => {
  let calls = 0
  const checker = new UpdateChecker({
    log: silentLog,
    currentVersion: '0.2.1',
    initialDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      return { tag: 'v0.3.0', url: 'https://example/0.3.0' }
    },
  })
  // scheduleInitial with delay 0 fires immediately; await the inflight task
  // through get() settling on the next microtask.
  checker.scheduleInitial()
  await new Promise((resolve) => setImmediate(resolve))
  const info = checker.get()
  assert.equal(calls, 1)
  assert.equal(info.available, true)
  assert.equal(info.latestVersion, 'v0.3.0')
  assert.equal(info.releaseUrl, 'https://example/0.3.0')
})

test('UpdateChecker: network answer equal/older than current keeps available false', async () => {
  const checker = new UpdateChecker({
    log: silentLog,
    currentVersion: '0.2.1',
    initialDelayMs: 0,
    fetchImpl: async () => ({ tag: 'v0.2.1', url: 'https://example/0.2.1' }),
  })
  checker.scheduleInitial()
  await new Promise((resolve) => setImmediate(resolve))
  const info = checker.get()
  assert.equal(info.available, false)
  assert.equal(info.latestVersion, null)
  assert.equal(info.releaseUrl, null)
})

test('UpdateChecker: GitHub returning no stable releases keeps available false', async () => {
  let calls = 0
  const checker = new UpdateChecker({
    log: silentLog,
    currentVersion: '0.2.1',
    initialDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      return null
    },
  })
  checker.scheduleInitial()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(checker.get().available, false)
})

test('UpdateChecker: network failure logs once and leaves snapshot in the "unknown" state', async () => {
  const lines: string[] = []
  const checker = new UpdateChecker({
    log: (message) => lines.push(message),
    currentVersion: '0.2.1',
    initialDelayMs: 0,
    fetchImpl: async () => {
      throw new Error('github rate limit')
    },
  })
  checker.scheduleInitial()
  await new Promise((resolve) => setImmediate(resolve))
  const info = checker.get()
  assert.equal(info.available, false)
  assert.equal(info.latestVersion, null)
  assert.equal(lines.length, 1, 'exactly one log line on failure')
  assert.match(lines[0]!, /update check failed.*github rate limit/)
})

test('UpdateChecker: concurrent scheduleInitial calls produce one network round-trip', async () => {
  let calls = 0
  const checker = new UpdateChecker({
    log: silentLog,
    currentVersion: '0.2.1',
    initialDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { tag: 'v0.3.0', url: 'https://example/0.3.0' }
    },
  })
  checker.scheduleInitial()
  checker.scheduleInitial()
  checker.scheduleInitial()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 1, 'inflight dedupes concurrent checks')
  assert.equal(checker.get().available, true)
})
