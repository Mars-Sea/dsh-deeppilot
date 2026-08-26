import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('dispose during an in-flight start never spawns the helper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-sup-race-'))
  try {
    // The stub records its own launch; if the buggy race ever spawns it, the
    // marker file appears even though dispose() already completed.
    const marker = join(dir, 'spawned.marker')
    const helper = join(dir, 'fake-helper')
    await writeFile(helper, '#!/bin/sh\ntouch ' + JSON.stringify(marker) + '\n', { mode: 0o755 })
    const supervisor = new RemoteSupervisor({
      enabled: true,
      hostname: 'race-probe',
      statePath: join(dir, 'state'),
      helperPath: helper,
      log: () => {},
    })
    void supervisor.start('http://127.0.0.1:9')
    // Dispose while start() is still awaiting its filesystem checks —
    // synchronously before access() can possibly resolve.
    await supervisor.dispose()
    assert.equal(supervisor.status().phase, 'stopped')
    // Give a buggy implementation ample time to resume start() and spawn:
    // process launch latency varies, so poll instead of a fixed sleep.
    for (let waited = 0; waited < 2_000 && !existsSync(marker); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(existsSync(marker), false, 'helper must not be spawned after dispose won the race')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
