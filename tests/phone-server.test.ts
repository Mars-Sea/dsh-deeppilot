import assert from 'node:assert/strict'
import test from 'node:test'
import { request } from 'node:http'
import { closeServer, createPhoneServer, listen } from '../src/phone-server.ts'

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.once('error', reject)
    req.end()
  })
}

test('independent phone server exposes only the three DeepPilot routes', async () => {
  const server = createPhoneServer({
    health(_req, res) {
      res.statusCode = 200
      res.end('{"ok":true}')
    },
    pair(_req, res) {
      res.statusCode = 405
      res.end('POST required')
    },
    upgrade(_req, socket) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    },
  })
  try {
    await listen(server, 0, '127.0.0.1')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const health = await get(address.port, '/phone/health')
    assert.deepEqual(health, { status: 200, body: '{"ok":true}' })
    const pair = await get(address.port, '/phone/pair')
    assert.deepEqual(pair, { status: 405, body: 'POST required' })
    const dshRoute = await get(address.port, '/api/sessions')
    assert.deepEqual(dshRoute, { status: 404, body: 'not found' })
  } finally {
    await closeServer(server)
  }
})
