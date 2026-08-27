import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientRemoteLike, ReportRemote } from '../src/client/report-mount.ts'
import { mountReportRemote } from '../src/client/report-mount.ts'

const reportRemote: ReportRemote = {
  async report() {
    return {
      ok: true,
      value: {
        protocolVersion: 1,
        pluginVersion: '0.3.0',
        serverVersion: '0.1.0',
        enabled: true,
        tokenPath: '/tmp/auth-token',
        tokenReady: true,
        activeConnections: 0,
        historyBufferMax: 2000,
        debug: false,
        lanAddresses: [],
        remote: {
          provider: 'tailscale-funnel',
          phase: 'disabled',
          updatedAt: 0,
        },
        devices: [],
      },
    }
  },
  async revealToken() {
    return { ok: true, value: 'a'.repeat(43) }
  },
  async rotateToken() {
    return { ok: true, value: 'b'.repeat(43) }
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
