/**
 * welcome.routes（能力 routeHints）：手机据此在同一 Wi-Fi 下先走局域网、在外走 Funnel。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { welcomeRoutes } from '../src/welcome-routes.ts'

const onlineLan = { phase: 'online', port: 3098, tlsFingerprint: 'sha256:abc' }
const onlineRemote = { phase: 'online', publicURL: 'https://dsh.example.ts.net' }

test('both routes are advertised when the LAN listener and Funnel are online', () => {
  assert.deepEqual(welcomeRoutes(onlineLan, onlineRemote, ['192.168.1.20', '10.0.0.5']), {
    lan: { urls: ['https://192.168.1.20:3098', 'https://10.0.0.5:3098'], tlsFingerprint: 'sha256:abc' },
    remote: { url: 'https://dsh.example.ts.net' },
  })
})

test('tailnet (100.64/10) addresses are not offered as LAN routes', () => {
  assert.deepEqual(welcomeRoutes(onlineLan, { phase: 'disabled' }, ['100.101.1.2', '192.168.1.20']), {
    lan: { urls: ['https://192.168.1.20:3098'], tlsFingerprint: 'sha256:abc' },
  })
  assert.equal(welcomeRoutes(onlineLan, { phase: 'disabled' }, ['100.101.1.2']), undefined)
})

test('routes that are not online are omitted', () => {
  assert.deepEqual(welcomeRoutes({ phase: 'starting', port: 3098 }, onlineRemote, ['192.168.1.20']), {
    remote: { url: 'https://dsh.example.ts.net' },
  })
  assert.equal(welcomeRoutes({ phase: 'online', port: 3098 }, { phase: 'starting' }, ['192.168.1.20']), undefined,
    'a LAN listener without a fingerprint cannot be pinned, so it is not advertised')
})
