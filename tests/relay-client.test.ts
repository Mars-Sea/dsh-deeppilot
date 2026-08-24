import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RelayClient } from '../src/relay-client.ts'
import type { PushNotification } from '../src/protocol.ts'

const NOTIFICATION: PushNotification = {
  notificationId: 'n-1',
  category: 'turn.completed',
  sessionId: 'session-x',
  title: '任务完成',
  body: '测试通过',
}

/** One-shot mock relay returning the given response for /v1/push. */
async function withMockRelay(
  respond: (req: { authorization: string | undefined; body: any }) => { status: number; body: unknown },
  run: (port: number, seen: Array<{ authorization: string | undefined; body: any }>) => Promise<void>,
): Promise<void> {
  const seen: Array<{ authorization: string | undefined; body: any }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const entry = {
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      }
      seen.push(entry)
      const result = respond(entry)
      res.statusCode = result.status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run((server.address() as AddressInfo).port, seen)
  } finally {
    server.close()
  }
}

const clientAt = (port: number) =>
  new RelayClient({ url: `http://127.0.0.1:${port}`, token: 'rl_test', log: () => {} })

test('relay client posts the full wire shape and maps sent/invalid-token', async () => {
  await withMockRelay(() => ({ status: 200, body: { outcome: 'sent' } }), async (port, seen) => {
    assert.deepEqual(await clientAt(port).send({ deviceToken: 'a'.repeat(64), environment: 'production', notification: NOTIFICATION }), { outcome: 'sent' })
    assert.equal(seen[0].authorization, 'Bearer rl_test')
    assert.equal(seen[0].body.deviceToken, 'a'.repeat(64))
    assert.equal(seen[0].body.environment, 'production')
    assert.deepEqual(seen[0].body.notification, NOTIFICATION)
  })

  await withMockRelay(() => ({ status: 200, body: { outcome: 'invalid-token', reason: 'Unregistered' } }), async (port) => {
    assert.deepEqual(await clientAt(port).send({ deviceToken: 'a'.repeat(64), environment: 'development', notification: NOTIFICATION }), { outcome: 'invalid-token', reason: 'Unregistered' })
  })
})

test('auth/quota rejections and transport failures degrade to failed (never prune)', async () => {
  for (const status of [401, 429, 500]) {
    await withMockRelay(() => ({ status, body: { error: 'nope' } }), async (port) => {
      const result = await clientAt(port).send({ deviceToken: 'a'.repeat(64), environment: 'production', notification: NOTIFICATION })
      assert.equal(result.outcome, 'failed')
    })
  }

  // Connection refused → failed, not a throw.
  const deadPortClient = new RelayClient({ url: 'http://127.0.0.1:9', token: 'rl_x', timeoutMs: 1500, log: () => {} })
  assert.equal((await deadPortClient.send({ deviceToken: 'a'.repeat(64), environment: 'development', notification: NOTIFICATION })).outcome, 'failed')
})
