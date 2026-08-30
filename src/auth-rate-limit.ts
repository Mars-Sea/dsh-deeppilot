export interface AuthRatePolicy {
  windowMs: number
  attemptsPerSource: number
  globalAttempts: number
  maxUnauthenticatedPerSource: number
  failureWindowMs: number
  failuresBeforeBlock: number
  blockMs: number
  maxSources: number
}

export const DEFAULT_AUTH_RATE_POLICY: AuthRatePolicy = {
  windowMs: 60_000,
  attemptsPerSource: 12,
  globalAttempts: 120,
  maxUnauthenticatedPerSource: 2,
  failureWindowMs: 10 * 60_000,
  failuresBeforeBlock: 5,
  blockMs: 15 * 60_000,
  maxSources: 4_096,
}

interface SourceState {
  attempts: number[]
  failures: number[]
  blockedUntil: number
  active: number
  lastSeen: number
}

export interface AuthAdmission {
  ok: boolean
  retryAfterMs: number
  release: () => void
}

export interface AuthFailureResult {
  blocked: boolean
  newlyBlocked: boolean
  retryAfterMs: number
}

const noop = (): void => {}

/** Bounded in-memory protection for anonymous authentication attempts. */
export class AuthRateLimiter {
  private readonly sources = new Map<string, SourceState>()
  private globalAttempts: number[] = []

  constructor(private readonly policy: AuthRatePolicy = DEFAULT_AUTH_RATE_POLICY) {}

  admit(source: string, now = Date.now()): AuthAdmission {
    const state = this.source(source, now)
    if (state === null) return { ok: false, retryAfterMs: this.policy.windowMs, release: noop }
    this.prune(state, now)
    state.lastSeen = now

    if (state.blockedUntil > now) {
      return { ok: false, retryAfterMs: state.blockedUntil - now, release: noop }
    }
    if (state.active >= this.policy.maxUnauthenticatedPerSource) {
      return { ok: false, retryAfterMs: this.policy.windowMs, release: noop }
    }
    if (state.attempts.length >= this.policy.attemptsPerSource) {
      return { ok: false, retryAfterMs: state.attempts[0]! + this.policy.windowMs - now, release: noop }
    }
    this.globalAttempts = this.globalAttempts.filter((ts) => ts > now - this.policy.windowMs)
    if (this.globalAttempts.length >= this.policy.globalAttempts) {
      return { ok: false, retryAfterMs: this.globalAttempts[0]! + this.policy.windowMs - now, release: noop }
    }

    state.attempts.push(now)
    this.globalAttempts.push(now)
    state.active += 1
    let released = false
    return {
      ok: true,
      retryAfterMs: 0,
      release: () => {
        if (released) return
        released = true
        state.active = Math.max(0, state.active - 1)
      },
    }
  }

  recordFailure(source: string, now = Date.now()): AuthFailureResult {
    const state = this.source(source, now)
    if (state === null) return { blocked: true, newlyBlocked: false, retryAfterMs: this.policy.blockMs }
    this.prune(state, now)
    state.lastSeen = now
    const wasBlocked = state.blockedUntil > now
    state.failures.push(now)
    if (state.failures.length >= this.policy.failuresBeforeBlock) {
      state.blockedUntil = Math.max(state.blockedUntil, now + this.policy.blockMs)
    }
    return {
      blocked: state.blockedUntil > now,
      newlyBlocked: !wasBlocked && state.blockedUntil > now,
      retryAfterMs: Math.max(0, state.blockedUntil - now),
    }
  }

  recordSuccess(source: string, now = Date.now()): void {
    const state = this.sources.get(source)
    if (state === undefined) return
    state.failures = []
    state.blockedUntil = 0
    state.lastSeen = now
  }

  private source(source: string, now: number): SourceState | null {
    const existing = this.sources.get(source)
    if (existing !== undefined) return existing
    if (this.sources.size >= this.policy.maxSources) this.pruneSources(now)
    if (this.sources.size >= this.policy.maxSources) return null
    const state: SourceState = { attempts: [], failures: [], blockedUntil: 0, active: 0, lastSeen: now }
    this.sources.set(source, state)
    return state
  }

  private prune(state: SourceState, now: number): void {
    state.attempts = state.attempts.filter((ts) => ts > now - this.policy.windowMs)
    state.failures = state.failures.filter((ts) => ts > now - this.policy.failureWindowMs)
    if (state.blockedUntil <= now) state.blockedUntil = 0
  }

  private pruneSources(now: number): void {
    const staleBefore = now - Math.max(this.policy.failureWindowMs, this.policy.blockMs)
    for (const [source, state] of this.sources) {
      this.prune(state, now)
      if (state.active === 0 && state.blockedUntil === 0 && state.lastSeen < staleBefore) {
        this.sources.delete(source)
      }
    }
  }
}
