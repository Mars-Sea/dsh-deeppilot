import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptDeliveryJournal, DELIVERY_RETENTION_MS } from '../src/prompt-delivery.ts'
const id = (time = Date.now()) => `${time}-${randomUUID()}`

test('concurrent duplicates share one dispatch and reject changed payload', async () => {
  const journal = new PromptDeliveryJournal()
  const sendID = id()
  let calls = 0
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  const operation = async () => { calls++; await wait; return { ok: true as const, value: 7 } }
  const first = journal.dispatch('device', 'session', sendID, { text: 'hi' }, operation)
  const second = journal.dispatch('device', 'session', sendID, { text: 'hi' }, operation)
  assert.equal(journal.lookup('device', 'session', sendID).status, 'unknown')
  finish()
  assert.deepEqual(await first, await second)
  assert.equal(calls, 1)
  assert.equal((await journal.dispatch('device', 'session', sendID, { text: 'different' }, operation)).code, 'E_PROTOCOL')
  assert.equal(journal.lookup('other', 'session', sendID).status, 'notFound')
  assert.equal(journal.lookup('device', 'other-session', sendID).status, 'notFound')
})

test('accepted receipt survives restart; interrupted reservation never dispatches twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-'))
  try {
    const path = join(root, 'journal.json')
    const journal = new PromptDeliveryJournal(path)
    const accepted = id(), uncertain = id()
    await journal.dispatch('d', 's', accepted, 'one', async () => ({ ok: true, value: 1 }))
    const restarted = new PromptDeliveryJournal(path)
    let calls = 0
    assert.equal((await restarted.dispatch('d', 's', accepted, 'one', async () => { calls++; return { ok: true, value: 2 } })).status, 'accepted')
    await restarted.dispatch('d', 's', uncertain, 'two', async () => {
      const crashed = new PromptDeliveryJournal(path)
      assert.equal((await crashed.dispatch('d', 's', uncertain, 'two', async () => { calls++; return { ok: true, value: 3 } })).status, 'unknown')
      throw new Error('lost upstream reply')
    })
    assert.equal(new PromptDeliveryJournal(path).lookup('d', 's', uncertain).status, 'unknown')
    assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expired identities, corrupt storage and full journals never invoke upstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-'))
  try {
    let calls = 0
    const run = async () => { calls++; return { ok: true as const, value: 1 } }
    const journal = new PromptDeliveryJournal(undefined, 1)
    assert.equal((await journal.dispatch('d', 's', id(Date.now() - DELIVERY_RETENTION_MS - 1000), 'old', run)).status, 'expired')
    await journal.dispatch('d', 's', id(), 'first', run)
    assert.equal((await journal.dispatch('d', 's', id(), 'second', run)).status, 'rejected')
    const path = join(root, 'journal.json')
    writeFileSync(path, 'broken')
    assert.equal((await new PromptDeliveryJournal(path).dispatch('d', 's', id(), 'no', run)).status, 'unknown')
    const blocked = join(root, 'not-directory')
    writeFileSync(blocked, 'file')
    assert.equal((await new PromptDeliveryJournal(join(blocked, 'journal')).dispatch('d', 's', id(), 'no', run)).status, 'unknown')
    assert.equal(calls, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
