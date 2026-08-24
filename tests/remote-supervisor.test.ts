import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeRemoteHostname,
  parseHelperEvent,
  RemoteSupervisor,
} from '../src/remote-supervisor.ts'

test('remote hostname migrates every pre-DeepPilot default', () => {
  assert.equal(normalizeRemoteHostname(undefined), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('  '), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('dsh-phone'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('DSH-PHONE'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('dsh-pocket'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('HarnessPocket'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('my-pocket'), 'my-pocket')
})

test('remote helper IPC accepts only known structured phases', () => {
  assert.deepEqual(parseHelperEvent('{"phase":"online","publicURL":"https://phone.example.ts.net"}'), {
    phase: 'online',
    publicURL: 'https://phone.example.ts.net',
  })
  assert.equal(parseHelperEvent('{"phase":"unknown"}'), null)
  assert.equal(parseHelperEvent('not json'), null)
})

test('remote helper IPC bounds diagnostic text', () => {
  const event = parseHelperEvent(JSON.stringify({ phase: 'error', message: 'x'.repeat(800) }))
  assert.equal(event?.message?.length, 500)
})

test('remote supervisor degrades when the embedded helper is absent', async () => {
  const supervisor = new RemoteSupervisor({
    enabled: true,
    hostname: 'test-phone',
    statePath: '/tmp/deeppilot-remote-test-state',
    helperPath: '/tmp/deeppilot-helper-that-does-not-exist',
    log: () => {},
  })
  await supervisor.start('http://127.0.0.1:39999')
  assert.equal(supervisor.status().phase, 'unavailable')
  await supervisor.dispose()
})
