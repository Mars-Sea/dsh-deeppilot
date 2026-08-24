import type { Context } from '@deepseek-ai/cordis'
import { DeepPilotReportService } from './report-service.ts'
import type { PairingTokenRotator, PairingTokenSnapshot, PushTester, RelayTester, ReportSnapshot } from './report-service.ts'
import { REPORT_HOST_CONTRIBUTION } from './report-wire.ts'

interface TypertContributionRegistry {
  register(contribution: typeof REPORT_HOST_CONTRIBUTION): () => void | Promise<void>
}

/**
 * Provide the report service and register its Remote descriptor. Rides an
 * optional `typert` inject: profiles without the web stack never activate it.
 */
export function applyReportRemote(
  ctx: Context,
  snapshot: ReportSnapshot,
  pairingToken: PairingTokenSnapshot,
  rotatePairingToken: PairingTokenRotator,
  relayTester: RelayTester,
  pushTester: PushTester,
): void {
  ctx.inject(['typert'], (remoteCtx) => {
    new DeepPilotReportService(remoteCtx, snapshot, pairingToken, rotatePairingToken, relayTester, pushTester)
    const registry = remoteCtx.typert as unknown as TypertContributionRegistry
    const unregister = registry.register(REPORT_HOST_CONTRIBUTION)
    remoteCtx.effect(() => () => void unregister(), 'dsh-deeppilot: report remote')
  })
}
