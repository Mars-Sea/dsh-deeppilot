/**
 * Relay connectivity self-test used by the settings page "测试中继" button.
 *
 * Two steps mirror what zero-touch enrollment actually does:
 *   1. health  — GET {url}/healthz        → is the relay reachable?
 *   2. enroll  — POST {url}/v1/enroll     → does the shared key grant a token?
 *
 * The enroll step doubles as a repair path: a token it issues is handed back
 * via `onEnrolled` so the bridge caches it and flips push readiness without
 * waiting for the next app registration.
 *
 * Transport is injectable (`fetchImpl`) so tests never touch the network.
 */

import { normalizeRelayBaseUrl } from './relay-url.ts'

export interface RelayTestStep {
  id: 'health' | 'enroll'
  ok: boolean
  /** Human-readable, user-facing (zh) outcome; safe to render verbatim. */
  message: string
  latencyMs?: number
}

export interface RelayTestResult {
  url: string
  overall: 'ok' | 'failed'
  /** True when the probe produced/cached a usable relay token. */
  tokenIssued: boolean
  steps: RelayTestStep[]
}

export interface RelayProbeOptions {
  url: string
  /** Stable per-bridge identity for enrollment; generated upstream if absent. */
  clientId?: string
  /** Distributor's shared key; absent → enroll step reports why it cannot run. */
  enrollKey?: string
  /** True when the user configured relayToken manually (enroll unnecessary). */
  manualToken?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Called with an issued token so the caller can persist it. */
  onEnrolled?: (token: string) => void
}

const DEFAULT_TIMEOUT_MS = 6_000

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // non-JSON body keeps body null; status still drives the verdict
  }
  return { status: response.status, body }
}

export async function runRelayProbe(options: RelayProbeOptions): Promise<RelayTestResult> {
  const base = normalizeRelayBaseUrl(options.url)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const steps: RelayTestStep[] = []
  let tokenIssued = false

  // ---- step 1: reachability ----
  try {
    const startedAt = Date.now()
    const { status, body } = await requestJson(
      fetchImpl,
      `${base}/healthz`,
      { method: 'GET' },
      timeoutMs,
    )
    const latencyMs = Date.now() - startedAt
    if (status === 200 && (body as { ok?: unknown })?.ok === true) {
      steps.push({ id: 'health', ok: true, message: '中继服务可达', latencyMs })
    } else {
      steps.push({ id: 'health', ok: false, message: `中继响应异常（HTTP ${status}）`, latencyMs })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    steps.push({ id: 'health', ok: false, message: '无法连接中继：' + reason })
  }

  // ---- step 2: enrollment ----
  if ((options.manualToken ?? false)) {
    steps.push({ id: 'enroll', ok: true, message: '已手动配置 relayToken，跳过注册验证' })
  } else if (!options.enrollKey) {
    steps.push({ id: 'enroll', ok: false, message: '尚无注册密钥：等待分发版 App 首次注册后才能验证注册' })
  } else {
    const clientId = options.clientId ?? 'u_' + Math.random().toString(36).slice(2)
    try {
      const startedAt = Date.now()
      const { status, body } = await requestJson(
        fetchImpl,
        `${base}/v1/enroll`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId, enrollKey: options.enrollKey }),
        },
        timeoutMs,
      )
      const latencyMs = Date.now() - startedAt
      const token = (body as { token?: unknown })?.token
      if (status === 200 && typeof token === 'string' && token.startsWith('rl_')) {
        tokenIssued = true
        options.onEnrolled?.(token)
        steps.push({ id: 'enroll', ok: true, message: '注册成功，已取得推送凭证', latencyMs })
      } else if (status === 403) {
        steps.push({ id: 'enroll', ok: false, message: '注册被拒：注册密钥不匹配（检查 App 内 DSPushEnrollKey 与服务器 RELAY_ENROLL_KEY）', latencyMs })
      } else if (status === 429) {
        steps.push({ id: 'enroll', ok: false, message: '尝试过于频繁，稍后再试', latencyMs })
      } else {
        steps.push({ id: 'enroll', ok: false, message: `注册失败（HTTP ${status}）`, latencyMs })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      steps.push({ id: 'enroll', ok: false, message: '注册请求失败：' + reason })
    }
  }

  const overall: RelayTestResult['overall'] =
    steps.length > 0 && steps.some((step) => step.id === 'health' && step.ok) &&
    steps.every((step) => step.ok)
      ? 'ok'
      : 'failed'
  return { url: base, overall, tokenIssued, steps }
}
