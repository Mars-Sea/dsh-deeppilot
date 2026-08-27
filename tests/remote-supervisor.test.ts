import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundledHelperCandidates,
  bundledHelperPlatformDir,
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

test('runtime log URLs cannot downgrade an online remote status', () => {
  const supervisor = new RemoteSupervisor({
    enabled: true,
    hostname: 'test-phone',
    statePath: '/tmp/deeppilot-remote-test-state',
    log: () => {},
  })
  const acceptLine = (supervisor as unknown as { acceptLine: (line: string) => void }).acceptLine.bind(supervisor)
  acceptLine('{"phase":"online","publicURL":"https://test.ts.net"}')
  acceptLine('{"phase":"login_required","authURL":"https://example.com/diagnostic"}')
  assert.equal(supervisor.status().phase, 'online')
  acceptLine('{"phase":"login_required","authURL":"https://login.tailscale.com/a/valid-but-late"}')
  assert.equal(supervisor.status().phase, 'online')
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

test('remote supervisor reports tried paths when no helper is bundled', async () => {
  // Point helperPath at a guaranteed-missing location; the unavailable
  // message must surface the user-provided path so the operator can see
  // what was attempted without re-reading the source.
  const supervisor = new RemoteSupervisor({
    enabled: true,
    hostname: 'diag-phone',
    statePath: '/tmp/deeppilot-remote-test-state',
    helperPath: '/tmp/deeppilot-helper-does-not-exist-' + Date.now(),
    log: () => {},
  })
  await supervisor.start('http://127.0.0.1:39998')
  const status = supervisor.status()
  assert.equal(status.phase, 'unavailable')
  assert.ok(status.message?.includes('tunnel helper unavailable'),
    `expected unavailable message, got: ${status.message}`)
  assert.ok(status.message?.includes('does-not-exist'),
    `expected message to mention the user-provided path, got: ${status.message}`)
  await supervisor.dispose()
})

const helperPlatformCases: Array<{
  platform: NodeJS.Platform
  arch: string
  directory: string
  fileName: string
}> = [
  { platform: 'darwin', arch: 'x64', directory: 'darwin-amd64', fileName: 'dsh-deeppilot-tunnel' },
  { platform: 'darwin', arch: 'arm64', directory: 'darwin-arm64', fileName: 'dsh-deeppilot-tunnel' },
  { platform: 'linux', arch: 'x64', directory: 'linux-amd64', fileName: 'dsh-deeppilot-tunnel' },
  { platform: 'linux', arch: 'arm64', directory: 'linux-arm64', fileName: 'dsh-deeppilot-tunnel' },
  { platform: 'win32', arch: 'x64', directory: 'windows-amd64', fileName: 'dsh-deeppilot-tunnel.exe' },
  { platform: 'win32', arch: 'arm64', directory: 'windows-arm64', fileName: 'dsh-deeppilot-tunnel.exe' },
]

for (const { platform, arch, directory, fileName } of helperPlatformCases) {
  test(`bundled helper candidates map ${platform}-${arch} to ${directory}`, () => {
    assert.equal(bundledHelperPlatformDir(platform, arch), directory)
    const candidates = bundledHelperCandidates(platform, arch)
    assert.ok(candidates.length >= 4, 'expected at least four candidate locations')
    // The first candidate is always the canonical npm layout, which is the
    // only one that matters in a normal install. Other candidates cover
    // DSH-bundled layouts and the user data dir.
    assert.ok(candidates[0]?.endsWith(join(directory, fileName)),
      `first candidate ${candidates[0]} should end with ${join(directory, fileName)}`)
    assert.ok(candidates[0] !== undefined && existsSync(candidates[0]),
      `canonical helper candidate ${candidates[0]} should exist in the committed matrix`)
    for (const candidate of candidates) {
      assert.ok(candidate.endsWith(fileName),
        `candidate ${candidate} should end with ${fileName}`)
    }
  })
}

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
