import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientRemoteLike, ReportRemote } from '../src/client/report-mount.ts'
import { mountReportRemote } from '../src/client/report-mount.ts'

const reportRemote: ReportRemote = {
  async report() {
    return {
      ok: true,
      value: {
        protocolVersion: 2,
        pluginVersion: '0.3.0',
        serverVersion: '0.1.0',
        enabled: true,
        identityPath: '/tmp/devices-v2.json',
        pairingReady: true,
        activeConnections: 0,
        historyBufferMax: 2000,
        debug: false,
        lanAddresses: [],
        local: {
          phase: 'online',
          port: 3098,
          endpoints: [],
          updatedAt: 0,
        },
        remote: {
          provider: 'tailscale-funnel',
          phase: 'disabled',
          updatedAt: 0,
        },
        devices: [],
      },
    }
  },
  async beginPairing() {
    return { ok: true, value: { code: 'a'.repeat(43), expiresAt: Date.now() + 60_000, audience: 'deeppilot:test' } }
  },
  async revokeDevice() {
    return { ok: true, value: true }
  },
  async setDeviceScopes(_deviceId, scopes) {
    return { ok: true, value: scopes }
  },
}

test('mountReportRemote resolves the namespace installed by $mount', async () => {
  let disposed = false
  let mountedNamespace: ReportRemote | undefined
  const remote: ClientRemoteLike = {
    async $mount() {
      mountedNamespace = reportRemote
      return async () => { disposed = true }
    },
  }

  const mounted = await mountReportRemote(remote, () => mountedNamespace)
  assert.equal(mounted.namespace, reportRemote)
  await mounted.dispose()
  assert.equal(disposed, true)
})

test('mountReportRemote disposes a contribution with no namespace service', async () => {
  let disposed = false
  const remote: ClientRemoteLike = {
    async $mount() {
      return async () => { disposed = true }
    },
  }

  await assert.rejects(() => mountReportRemote(remote, () => undefined), /remote\.deeppilot 未注册/)
  assert.equal(disposed, true)
})
