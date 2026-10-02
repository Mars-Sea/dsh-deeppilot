import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DispatchJournal,
  promptDeliveryCodec,
  type DeliveryReceipt,
} from '../src/dispatch-journal.ts'
const id = (time = Date.now()) => `${time}-${randomUUID()}`
const RETENTION_MS = 7 * 24 * 3600 * 1000

/** prompt 实例：request 形状 { sessionId, content }，与 wire 层调用一致。 */
function makeJournal(path?: string, capacity?: number): DispatchJournal<{ sessionId: string; content: unknown }, DeliveryReceipt> {
  return new DispatchJournal({
    path,
    codec: promptDeliveryCodec,
    joinInFlight: true,
    maxFileBytes: 8 * 1024 * 1024,
    ...(capacity !== undefined ? { capacity } : {}),
  })
}

test('concurrent duplicates share one dispatch and reject changed payload', async () => {
  const journal = makeJournal()
  const sendID = id()
  let calls = 0
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  const operation = async () => { calls++; await wait; return { ok: true as const, value: 7 } }
  const first = journal.dispatch('device', sendID, { sessionId: 'session', content: { text: 'hi' } }, operation)
  const second = journal.dispatch('device', sendID, { sessionId: 'session', content: { text: 'hi' } }, operation)
  assert.equal(journal.lookup('device', sendID, 'session')!.status, 'unknown')
  finish()
  assert.deepEqual(await first, await second)
  assert.equal(calls, 1)
  assert.equal((await journal.dispatch('device', sendID, { sessionId: 'session', content: { text: 'different' } }, operation)).code, 'E_PROTOCOL')
  assert.equal(journal.lookup('other', sendID, 'session')!.status, 'notFound')
  assert.equal(journal.lookup('device', sendID, 'other-session')!.status, 'notFound')
})

test('accepted receipt survives restart; interrupted reservation never dispatches twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-'))
  try {
    const path = join(root, 'journal.json')
    const journal = makeJournal(path)
    const accepted = id(), uncertain = id()
    await journal.dispatch('d', accepted, { sessionId: 's', content: 'one' }, async () => ({ ok: true, value: 1 }))
    const restarted = makeJournal(path)
    let calls = 0
    assert.equal((await restarted.dispatch('d', accepted, { sessionId: 's', content: 'one' }, async () => { calls++; return { ok: true, value: 2 } })).status, 'accepted')
    await restarted.dispatch('d', uncertain, { sessionId: 's', content: 'two' }, async () => {
      const crashed = makeJournal(path)
      assert.equal((await crashed.dispatch('d', uncertain, { sessionId: 's', content: 'two' }, async () => { calls++; return { ok: true, value: 3 } })).status, 'unknown')
      throw new Error('lost upstream reply')
    })
    assert.equal(makeJournal(path).lookup('d', uncertain, 's')!.status, 'unknown')
    assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expired identities, corrupt storage and full journals never invoke upstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-'))
  try {
    let calls = 0
    const run = async () => { calls++; return { ok: true as const, value: 1 } }
    const journal = makeJournal(undefined, 1)
    assert.equal((await journal.dispatch('d', id(Date.now() - RETENTION_MS - 1000), { sessionId: 's', content: 'old' }, run)).status, 'expired')
    await journal.dispatch('d', id(), { sessionId: 's', content: 'first' }, run)
    assert.equal((await journal.dispatch('d', id(), { sessionId: 's', content: 'second' }, run)).status, 'rejected')
    const path = join(root, 'journal.json')
    writeFileSync(path, 'broken')
    assert.equal((await makeJournal(path).dispatch('d', id(), { sessionId: 's', content: 'no' }, run)).status, 'unknown')
    const blocked = join(root, 'not-directory')
    writeFileSync(blocked, 'file')
    assert.equal((await makeJournal(join(blocked, 'journal')).dispatch('d', id(), { sessionId: 's', content: 'no' }, run)).status, 'unknown')
    assert.equal(calls, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
