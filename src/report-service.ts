import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DeepPilotReport, PushTestResult, RelayTestResult } from './report-wire.ts'

/** Async snapshot source wired by the plugin entry. */
export type ReportSnapshot = () => Promise<DeepPilotReport>

/** Reads the pairing secret only for an explicit reveal action. */
export type PairingTokenSnapshot = () => Promise<string>

/**
 * Replaces the pairing secret for an explicit rotation action: persists the
 * new token, invalidates the old one, and drops live phone connections.
 */
export type PairingTokenRotator = () => Promise<string>

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
  private readonly pairingToken: PairingTokenSnapshot
  private readonly rotatePairingToken: PairingTokenRotator

  private readonly relayTester: RelayTester
  private readonly pushTester: PushTester

  constructor(
    ctx: Context,
    snapshot: ReportSnapshot,
    pairingToken: PairingTokenSnapshot,
    rotatePairingToken: PairingTokenRotator,
    relayTester: RelayTester,
    pushTester: PushTester,
  ) {
    super(ctx, 'deeppilotReport', { namespace: 'deeppilot' })
    this.snapshot = snapshot
    this.pairingToken = pairingToken
    this.rotatePairingToken = rotatePairingToken
    this.relayTester = relayTester
    this.pushTester = pushTester
  }

  async report(): Promise<DeepPilotReport> {
    return this.snapshot()
  }

  async revealToken(): Promise<string> {
    return this.pairingToken()
  }

  async rotateToken(): Promise<string> {
    return this.rotatePairingToken()
  }

  async testRelay(): Promise<RelayTestResult> {
    return this.relayTester()
  }

  async testPush(): Promise<PushTestResult> {
    return this.pushTester()
  }
}
