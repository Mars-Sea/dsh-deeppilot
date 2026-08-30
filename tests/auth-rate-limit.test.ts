import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthRateLimiter, type AuthRatePolicy } from '../src/auth-rate-limit.ts'

const policy: AuthRatePolicy = {
  windowMs: 1_000,
  attemptsPerSource: 3,
  globalAttempts: 10,
  maxUnauthenticatedPerSource: 2,
  failureWindowMs: 10_000,
  failuresBeforeBlock: 3,
  blockMs: 5_000,
  maxSources: 8,
}

test('limits concurrent anonymous handshakes per source and releases exactly once', () => {
  const limiter = new AuthRateLimiter(policy)
  const first = limiter.admit('a', 0)
  const second = limiter.admit('a', 1)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(limiter.admit('a', 2).ok, false)
  first.release()
  first.release()
  assert.equal(limiter.admit('a', 3).ok, true)
})

test('blocks a source after repeated authentication failures', () => {
  const limiter = new AuthRateLimiter(policy)
  assert.equal(limiter.recordFailure('a', 0).blocked, false)
  assert.equal(limiter.recordFailure('a', 1).blocked, false)
  const blocked = limiter.recordFailure('a', 2)
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.newlyBlocked, true)
  assert.equal(limiter.admit('a', 3).ok, false)

  limiter.recordSuccess('a', 4)
  assert.equal(limiter.admit('a', 5).ok, true)
})

test('enforces the rolling attempt limit', () => {
  const limiter = new AuthRateLimiter(policy)
  for (const now of [0, 1, 2]) limiter.admit('a', now).release()
  assert.equal(limiter.admit('a', 3).ok, false)
  assert.equal(limiter.admit('a', 1_001).ok, true)
})
