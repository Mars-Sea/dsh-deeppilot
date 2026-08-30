import type { DeviceScope } from '../device-auth.ts'
import type { DeepPilotReport, PairingGrantSnapshot, PushTestResult, RelayTestResult } from '../report-wire.ts'
import { REPORT_REMOTE_CONTRIBUTION } from '../report-wire.ts'

export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message?: string } }

export interface ReportRemote {
  report(): Promise<RemoteResult<DeepPilotReport>>
  beginPairing(): Promise<RemoteResult<PairingGrantSnapshot>>
  revokeDevice(deviceId: string): Promise<RemoteResult<boolean>>
  setDeviceScopes(deviceId: string, scopes: DeviceScope[]): Promise<RemoteResult<DeviceScope[]>>
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
