import type { DeepPilotReport, PushTestResult, RelayTestResult } from '../report-wire.ts'
import { REPORT_REMOTE_CONTRIBUTION } from '../report-wire.ts'

export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message?: string } }

export interface ReportRemote {
  report(): Promise<RemoteResult<DeepPilotReport>>
  revealToken(): Promise<RemoteResult<string>>
  /** Replaces the pairing secret; resolves with the fresh token. */
  rotateToken(): Promise<RemoteResult<string>>
  /** Optional so an older host never breaks a newer client (and vice versa). */
  testRelay?(): Promise<RemoteResult<RelayTestResult>>
  /** Forces one real push delivery to every registered device. */
  testPush?(): Promise<RemoteResult<PushTestResult>>
}

export interface ClientRemoteLike {
  $mount(contribution: unknown): Promise<() => Promise<void>>
}

export interface MountedReportRemote {
  namespace: ReportRemote
  dispose: () => Promise<void>
}

/** Mount the contribution and resolve the namespace service it installs. */
export async function mountReportRemote(
  remote: ClientRemoteLike,
  resolveNamespace: () => ReportRemote | undefined,
): Promise<MountedReportRemote> {
  const dispose = await remote.$mount(REPORT_REMOTE_CONTRIBUTION)
  const namespace = resolveNamespace()
  if (namespace === undefined) {
    await dispose()
    throw new Error('remote.deeppilot 未注册')
  }
  return { namespace, dispose }
}
