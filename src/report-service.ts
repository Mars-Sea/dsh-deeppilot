import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceScope } from './device-auth.ts'
import type { DeepPilotReport, PairingGrantSnapshot, PushTestResult, RelayTestResult } from './report-wire.ts'

/** Async snapshot source wired by the plugin entry. */
export type ReportSnapshot = () => Promise<DeepPilotReport>

export type PairingStarter = () => Promise<PairingGrantSnapshot>
export type DeviceRevoker = (deviceId: string) => Promise<boolean>
export type DeviceScopeUpdater = (deviceId: string, scopes: DeviceScope[]) => Promise<DeviceScope[]>

/** Runs the relay connectivity self-test (health + enrollment round-trip). */
export type RelayTester = () => Promise<RelayTestResult>

/** Forces one synthetic notification down the active push pathway. */
export type PushTester = () => Promise<PushTestResult>

/**
 * The Typert receiver the Gateway resolves for the DeepPilot Bridge report.
 * Snapshot data stays non-secret; the token crosses the boundary only through
 * the explicit, user-triggered revealToken/rotateToken invocations.
 */
export class DeepPilotReportService extends TypertRemoteService {
  private readonly snapshot: ReportSnapshot
  private readonly pairingStarter: PairingStarter
  private readonly deviceRevoker: DeviceRevoker
  private readonly deviceScopeUpdater: DeviceScopeUpdater

  private readonly relayTester: RelayTester
  private readonly pushTester: PushTester

  constructor(
    ctx: Context,
    snapshot: ReportSnapshot,
    pairingStarter: PairingStarter,
    deviceRevoker: DeviceRevoker,
    deviceScopeUpdater: DeviceScopeUpdater,
    relayTester: RelayTester,
    pushTester: PushTester,
  ) {
    super(ctx, 'deeppilotReport', { namespace: 'deeppilot' })
    this.snapshot = snapshot
    this.pairingStarter = pairingStarter
    this.deviceRevoker = deviceRevoker
    this.deviceScopeUpdater = deviceScopeUpdater
    this.relayTester = relayTester
    this.pushTester = pushTester
  }

  async report(): Promise<DeepPilotReport> {
    return this.snapshot()
  }

  async beginPairing(): Promise<PairingGrantSnapshot> {
    return this.pairingStarter()
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.deviceRevoker(deviceId)
  }

  async setDeviceScopes(deviceId: string, scopes: DeviceScope[]): Promise<DeviceScope[]> {
    return this.deviceScopeUpdater(deviceId, scopes)
  }

  async testRelay(): Promise<RelayTestResult> {
    return this.relayTester()
  }

  async testPush(): Promise<PushTestResult> {
    return this.pushTester()
  }
}
