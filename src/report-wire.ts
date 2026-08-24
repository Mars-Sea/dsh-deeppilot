/**
 * Wire contract for the DeepPilot report Remote (`deeppilot/report`).
 *
 * The web settings page needs the bridge's live facts (paired devices,
 * connections, token state) — those live Host-side. This module is the single
 * source both halves share: the strict result codec (hand-rolled, so the
 * client bundle needs no schema library) and the exact descriptor object.
 *
 * @module dsh-deeppilot/report-wire
 */

import type { InvocationDescriptor, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/** One paired device row in the report. */
export interface ReportDevice {
  deviceId: string
  deviceName: string
  appVersion: string
  firstSeenTs: number
  lastSeenTs: number
  /** Present once the device registered an APNs token (token itself never leaves the host). */
  apns?: { environment: 'development' | 'production'; updatedAt: number }
}

/** One step of the relay connectivity self-test. */
export interface RelayTestStep {
  id: 'health' | 'enroll'
  ok: boolean
  message: string
  latencyMs?: number
}

/** Result of deeppilot/testRelay. */
export interface RelayTestResult {
  url: string
  overall: 'ok' | 'failed'
  tokenIssued: boolean
  steps: RelayTestStep[]
}

/** Per-device delivery result of deeppilot/testPush. */
export interface PushTestDeviceResult {
  name: string
  environment: string
  /** sent | invalid-token | failed — mirrors the dispatch outcome contract. */
  outcome: string
  /** Apple's raw rejection reason when present (BadDeviceToken, …). */
  reason?: string
  /** First 10 hex chars of the stored token, for freshness verification. */
  tokenFingerprint?: string
}

export interface PushTestResult {
  transport: 'apns' | 'relay' | 'none'
  /** sent = at least one accepted delivery; no-targets / not-configured / failed. */
  overall: 'sent' | 'failed' | 'no-targets' | 'not-configured'
  message?: string
  results: PushTestDeviceResult[]
}

/** Everything the settings page renders for the bridge. */
export interface DeepPilotReport {
  protocolVersion: number
  serverVersion: string
  /** Whether the master bridge switch is on. */
  enabled: boolean
  /** Absolute token file path (never the token itself). */
  tokenPath: string
  /** Whether the token file exists and is readable. */
  tokenReady: boolean
  /** Currently connected phone sockets. */
  activeConnections: number
  historyBufferMax: number
  debug: boolean
  /** Private IPv4 candidates for local QR pairing. */
  lanAddresses: string[]
  remote: {
    provider: 'tailscale-funnel'
    phase: 'disabled' | 'starting' | 'login_required' | 'online' | 'error' | 'unavailable' | 'stopped'
    publicURL?: string
    authURL?: string
    message?: string
    updatedAt: number
  }
  devices: ReportDevice[]
}

/** The npm package identity both contribution registrations claim. */
export const REPORT_REMOTE_PACKAGE = 'dsh-deeppilot'

/** Canonical `<namespace>/<method>` endpoint of the report Remote. */
export const REPORT_ENDPOINT = 'deeppilot/report'

/** Explicit, user-triggered endpoint for revealing the pairing secret. */
export const REVEAL_TOKEN_ENDPOINT = 'deeppilot/revealToken'

/**
 * Explicit, user-triggered endpoint that replaces the pairing secret. The old
 * token stops working immediately; the fresh one is returned so the page can
 * show/QR it right away.
 */
export const ROTATE_TOKEN_ENDPOINT = 'deeppilot/rotateToken'

function reject(field: string): never {
  throw new TypeError(`deeppilot/report result: invalid ${field}`)
}

function str(source: Record<string, unknown>, key: string, field: string): string {
  const value = source[key]
  if (typeof value !== 'string') reject(field)
  return value
}
function num(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) reject(field)
  return value
}
function bool(source: Record<string, unknown>, key: string, field: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') reject(field)
  return value
}
function rec(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject(field)
  return value as Record<string, unknown>
}

function parseDevice(value: unknown): ReportDevice {
  const s = rec(value, 'device')
  let apns: ReportDevice['apns']
  if (s.apns !== undefined) {
    const a = rec(s.apns, 'device.apns')
    const environment = str(a, 'environment', 'device.apns.environment')
    if (environment !== 'development' && environment !== 'production') reject('device.apns.environment')
    apns = { environment, updatedAt: num(a, 'updatedAt', 'device.apns.updatedAt') }
  }
  return {
    deviceId: str(s, 'deviceId', 'device.deviceId'),
    deviceName: str(s, 'deviceName', 'device.deviceName'),
    appVersion: str(s, 'appVersion', 'device.appVersion'),
    firstSeenTs: num(s, 'firstSeenTs', 'device.firstSeenTs'),
    lastSeenTs: num(s, 'lastSeenTs', 'device.lastSeenTs'),
    ...(apns ? { apns } : {}),
  }
}

function parseRemote(value: unknown): DeepPilotReport['remote'] {
  const s = rec(value, 'remote')
  const provider = str(s, 'provider', 'remote.provider')
  const phase = str(s, 'phase', 'remote.phase')
  if (provider !== 'tailscale-funnel') reject('remote.provider')
  const phases = ['disabled', 'starting', 'login_required', 'online', 'error', 'unavailable', 'stopped']
  if (!phases.includes(phase)) reject('remote.phase')
  const publicURL = s.publicURL
  const authURL = s.authURL
  const message = s.message
  if (publicURL !== undefined && typeof publicURL !== 'string') reject('remote.publicURL')
  if (authURL !== undefined && typeof authURL !== 'string') reject('remote.authURL')
  if (message !== undefined && typeof message !== 'string') reject('remote.message')
  return {
    provider,
    phase: phase as DeepPilotReport['remote']['phase'],
    ...(typeof publicURL === 'string' ? { publicURL } : {}),
    ...(typeof authURL === 'string' ? { authURL } : {}),
    ...(typeof message === 'string' ? { message } : {}),
    updatedAt: num(s, 'updatedAt', 'remote.updatedAt'),
  }
}

function parseRelayTestStep(value: unknown): RelayTestStep {
  const st = rec(value, 'step')
  const id = str(st, 'id', 'step.id')
  if (id !== 'health' && id !== 'enroll') reject('step.id')
  const latencyMs = st.latencyMs
  if (latencyMs !== undefined && typeof latencyMs !== 'number') reject('step.latencyMs')
  return {
    id,
    ok: bool(st, 'ok', 'step.ok'),
    message: str(st, 'message', 'step.message'),
    ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
  }
}

function parseRelayTestResult(value: unknown): RelayTestResult {
  const s = rec(value, 'result')
  const overall = str(s, 'overall', 'overall')
  if (overall !== 'ok' && overall !== 'failed') reject('overall')
  const stepsRaw = s.steps
  if (!Array.isArray(stepsRaw)) reject('steps')
  return {
    url: str(s, 'url', 'url'),
    overall,
    tokenIssued: bool(s, 'tokenIssued', 'tokenIssued'),
    steps: (stepsRaw as unknown[]).map(parseRelayTestStep),
  }
}

function parsePushTestResult(value: unknown): PushTestResult {
  const s = rec(value, 'result')
  const transport = str(s, 'transport', 'transport')
  if (transport !== 'apns' && transport !== 'relay' && transport !== 'none') reject('transport')
  const overall = str(s, 'overall', 'overall')
  const overalls = ['sent', 'failed', 'no-targets', 'not-configured']
  if (!overalls.includes(overall)) reject('overall')
  const resultsRaw = s.results
  if (!Array.isArray(resultsRaw)) reject('results')
  const results = (resultsRaw as unknown[]).map((value) => {
    const r = rec(value, 'device result')
    const reason = r.reason
    const tokenFingerprint = r.tokenFingerprint
    return {
      name: str(r, 'name', 'result.name'),
      environment: str(r, 'environment', 'result.environment'),
      outcome: str(r, 'outcome', 'result.outcome'),
      ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
      ...(typeof tokenFingerprint === 'string' && /^[0-9a-f]{1,32}$/.test(tokenFingerprint)
        ? { tokenFingerprint }
        : {}),
    }
  })
  const message = s.message
  return {
    transport,
    overall: overall as PushTestResult['overall'],
    ...(typeof message === 'string' && message.length > 0 ? { message } : {}),
    results,
  }
}

function parseReport(value: unknown): DeepPilotReport {
  const s = rec(value, 'report')
  const devices = s.devices
  const lanAddresses = s.lanAddresses
  if (!Array.isArray(devices)) reject('devices')
  if (!Array.isArray(lanAddresses) || lanAddresses.some((value) => typeof value !== 'string')) reject('lanAddresses')
  return {
    protocolVersion: num(s, 'protocolVersion', 'protocolVersion'),
    serverVersion: str(s, 'serverVersion', 'serverVersion'),
    enabled: bool(s, 'enabled', 'enabled'),
    tokenPath: str(s, 'tokenPath', 'tokenPath'),
    tokenReady: bool(s, 'tokenReady', 'tokenReady'),
    activeConnections: num(s, 'activeConnections', 'activeConnections'),
    historyBufferMax: num(s, 'historyBufferMax', 'historyBufferMax'),
    debug: bool(s, 'debug', 'debug'),
    lanAddresses: lanAddresses as string[],
    remote: parseRemote(s.remote),
    devices: (devices as unknown[]).map(parseDevice),
  }
}

export const reportSchema: TypertSchema<DeepPilotReport> = { parse: parseReport }

export const relayTestSchema: TypertSchema<RelayTestResult> = { parse: parseRelayTestResult }

export const pushTestSchema: TypertSchema<PushTestResult> = { parse: parsePushTestResult }

export const pairingTokenSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== 'string' || value.length < 32) {
      throw new TypeError('deeppilot/revealToken result: invalid token')
    }
    return value
  },
}

/**
 * Connectivity self-test for the push relay: health probe plus (when an
 * enroll key is on file) a real enrollment round-trip. Doubles as repair —
 * a token it issues is cached by the bridge.
 */
export const TEST_RELAY_ENDPOINT = 'deeppilot/testRelay'

/**
 * Real-delivery push test: forces one synthetic notification down the active
 * push pathway to every registered device, ignoring connected/muted filters —
 * an explicit user action must always be able to prove the pipeline works.
 */
export const TEST_PUSH_ENDPOINT = 'deeppilot/testPush'

export const REPORT_DESCRIPTOR: InvocationDescriptor = {
  id: `${REPORT_REMOTE_PACKAGE}#${REPORT_ENDPOINT}`,
  service: 'deeppilotReport',
  namespace: 'deeppilot',
  method: 'report',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: `${REPORT_REMOTE_PACKAGE}#DeepPilotReport`,
    schema: reportSchema,
  },
}

export const REVEAL_TOKEN_DESCRIPTOR: InvocationDescriptor = {
  id: `${REPORT_REMOTE_PACKAGE}#${REVEAL_TOKEN_ENDPOINT}`,
  service: 'deeppilotReport',
  namespace: 'deeppilot',
  method: 'revealToken',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: `${REPORT_REMOTE_PACKAGE}#PairingToken`,
    schema: pairingTokenSchema,
  },
}

export const ROTATE_TOKEN_DESCRIPTOR: InvocationDescriptor = {
  id: `${REPORT_REMOTE_PACKAGE}#${ROTATE_TOKEN_ENDPOINT}`,
  service: 'deeppilotReport',
  namespace: 'deeppilot',
  method: 'rotateToken',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: `${REPORT_REMOTE_PACKAGE}#PairingToken`,
    schema: pairingTokenSchema,
  },
}

export const TEST_RELAY_DESCRIPTOR: InvocationDescriptor = {
  id: `${REPORT_REMOTE_PACKAGE}#${TEST_RELAY_ENDPOINT}`,
  service: 'deeppilotReport',
  namespace: 'deeppilot',
  method: 'testRelay',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: `${REPORT_REMOTE_PACKAGE}#RelayTestResult`,
    schema: relayTestSchema,
  },
}

export const TEST_PUSH_DESCRIPTOR: InvocationDescriptor = {
  id: `${REPORT_REMOTE_PACKAGE}#${TEST_PUSH_ENDPOINT}`,
  service: 'deeppilotReport',
  namespace: 'deeppilot',
  method: 'testPush',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: `${REPORT_REMOTE_PACKAGE}#PushTestResult`,
    schema: pushTestSchema,
  },
}

const INVOCATION_DESCRIPTORS = [
  REPORT_DESCRIPTOR,
  REVEAL_TOKEN_DESCRIPTOR,
  ROTATE_TOKEN_DESCRIPTOR,
  TEST_RELAY_DESCRIPTOR,
  TEST_PUSH_DESCRIPTOR,
]

export const REPORT_HOST_CONTRIBUTION = {
  package: REPORT_REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: INVOCATION_DESCRIPTORS,
}

export const REPORT_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: REPORT_REMOTE_PACKAGE,
  descriptors: INVOCATION_DESCRIPTORS,
}
