import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeCrashExit,
  bundledHelperCandidates,
  bundledHelperPlatformDir,
  helperCrashSummary,
  MAX_CRASH_DUMPS,
  normalizeRemoteHostname,
  parseHelperEvent,
  RemoteSupervisor,
  restartDelayMs,
  shortenSymbol,
  tunnelHelperArguments,
} from '../src/remote-supervisor.ts'
import { normalizeFunnelConnectionLimit } from '../src/funnel-policy.ts'

test('remote hostname migrates every pre-DeepPilot default', () => {
  assert.equal(normalizeRemoteHostname(undefined), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('  '), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('dsh-phone'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('DSH-PHONE'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('dsh-pocket'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('HarnessPocket'), 'dsh-deeppilot')
  assert.equal(normalizeRemoteHostname('my-pocket'), 'my-pocket')
})

test('Funnel per-source connection limit defaults safely and accepts 1-16', () => {
  assert.equal(normalizeFunnelConnectionLimit(undefined), 8)
  assert.equal(normalizeFunnelConnectionLimit(0), 8)
  assert.equal(normalizeFunnelConnectionLimit(17), 8)
  assert.equal(normalizeFunnelConnectionLimit(1.5), 8)
  assert.equal(normalizeFunnelConnectionLimit(1), 1)
  assert.equal(normalizeFunnelConnectionLimit(12), 12)
  assert.equal(normalizeFunnelConnectionLimit(16), 16)
})

test('remote supervisor forwards the configured connection limit to the helper', () => {
  const args = tunnelHelperArguments('http://127.0.0.1:1234', '/tmp/state', {
    hostname: 'DeepPilot',
    funnelPort: 8443,
    maxConnectionsPerSource: 12,
  })
  assert.deepEqual(args, [
    '--origin', 'http://127.0.0.1:1234',
    '--hostname', 'DeepPilot',
    '--state-dir', '/tmp/state',
    '--port', '8443',
    '--max-connections-per-source', '12',
  ])
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

// ---------- crash summary extraction ----------

test('crash summary surfaces the panic reason, not the trailing stack noise', () => {
  const stderr = [
    '2026/09/03 22:30:11 http: panic serving 100.101.102.103:443: runtime error: invalid memory address or nil pointer dereference',
    'goroutine 123 [running]:',
    'runtime/debug.Stack()',
    '    runtime/debug/stack.go:26 +0x5e',
    'tailscale.com/net/dnscache.(*Resolver).lookupIP(0x1400012c000, {0x140001d20e0, 0x140001d20e0})',
    '    /root/go/pkg/mod/tailscale.com@v1.102.3/net/dnscache/dnscache.go:604 +0x25c',
    'created by tailscale.com/util/singleflight.(*Group).DoChanContext in goroutine 9',
    '    /root/go/pkg/mod/tailscale.com@v1.102.3/util/singleflight/singleflight.go:194 +0x45c',
  ].join('\n')
  assert.equal(
    helperCrashSummary(stderr),
    'http: panic serving 100.101.102.103:443: runtime error: invalid memory address or nil pointer dereference @ dnscache.(*Resolver).lookupIP (dnscache.go:604)',
  )
})

test('crash summary keeps the signal continuation and skips runtime frames', () => {
  const stderr = [
    'panic: runtime error: invalid memory address or nil pointer dereference',
    '[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x1029a1b4c]',
    '',
    'goroutine 21 [running]:',
    'runtime/debug.Stack()',
    '    runtime/debug/stack.go:26 +0x5e',
    'main.fail(0x102b7c5b0)',
    '    helper/main.go:425 +0x20',
    'created by tailscale.com/util/singleflight.(*Group).DoChanContext in goroutine 9',
    '    tailscale.com@v1.102.3/util/singleflight/singleflight.go:194 +0x45c',
  ].join('\n')
  assert.equal(
    helperCrashSummary(stderr),
    'panic: runtime error: invalid memory address or nil pointer dereference [signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x1029a1b4c] @ main.fail (main.go:425)',
  )
})

test('crash summary handles a bare fatal error without app frames', () => {
  const stderr = [
    'fatal error: concurrent map writes',
    '',
    'goroutine 8 [running]:',
    'runtime.throw({0x10293c5b0, 0x0})',
    '    runtime/panic.go:1108 +0x70',
    'runtime.mapassign_faststr(0x140000582c0, 0x1400010e1e0, {0x102a4e6a0, 0x2})',
    '    runtime/map_fast.go:203 +0x39e',
    'main.main()',
    '    helper/main.go:196 +0x20',
    'created by main.main in goroutine 1',
    '    runtime/proc.go:272 +0x10',
  ].join('\n')
  assert.equal(
    helperCrashSummary(stderr),
    'fatal error: concurrent map writes @ main.main (main.go:196)',
  )
})

test('crash summary falls back to the last non-empty stderr line', () => {
  assert.equal(helperCrashSummary(''), '')
  assert.equal(helperCrashSummary('  '), '')
  const runtimeNoise = 'some log line\ntailscale.com@v1.102.3/util/singleflight/singleflight.go:194 +0x45c'
  assert.equal(helperCrashSummary(runtimeNoise), runtimeNoise.split('\n').at(-1))
})

test('shortenSymbol shrinks module paths, receivers, generics and args', () => {
  assert.equal(shortenSymbol('tailscale.com/net/dnscache.(*Resolver).lookupIP(0x1400012c000, {0x140001d20e0})'),
    'dnscache.(*Resolver).lookupIP')
  assert.equal(shortenSymbol('tailscale.com/util/singleflight.(*Group[...]).doCall(0x3cdce79dc280, 0x0)'),
    'singleflight.(*Group).doCall')
  assert.equal(shortenSymbol('tailscale.com/util/singleflight.(*Group[...]).doCall.func2(0x3cdce79dc280, 0x0, 0x3cdce7b01e80?)'),
    'singleflight.(*Group).doCall.func2')
  assert.equal(shortenSymbol('main.fail(0x102b7c5b0)'), 'main.fail')
  assert.equal(shortenSymbol('runtime.throw({0x10293c5b0, 0x0})'), 'runtime.throw')
  assert.equal(shortenSymbol('created by tailscale.com/util/singleflight.(*Group).DoChanContext in goroutine 9'),
    'singleflight.(*Group).DoChanContext in goroutine 9')
})

test('crash summary handles the real tailscale doCall.func2 sample', () => {
  const stderr = [
    'panic: runtime error: invalid memory address or nil pointer dereference',
    '[signal SIGSEGV: segmentation violation code=0x1 addr=0x1b pc=0x1b]',
    '',
    'goroutine 103 [running]:',
    'tailscale.com/util/singleflight.(*Group[...]).doCall.func2(0x3cdce79dc280, 0x0, 0x3cdce7b01e80?)',
    '        tailscale.com@v1.102.3/util/singleflight/singleflight.go:297 +0x16b',
    'tailscale.com/util/singleflight.(*Group[...]).doCall(0x3cdce79f8000?, 0x3cdce778a1a0?, {0x3cdce799e040?, 0x99bb57?}, 0x0?)',
    '        tailscale.com@v1.102.3/util/singleflight/singleflight.go:297 +0x89',
    'created by tailscale.com/util/singleflight.(*Group[...]).DoChanContext in goroutine 102',
    '        tailscale.com@v1.102.3/util/singleflight/singleflight.go:194 +0x45c',
  ].join('\n')
  assert.equal(
    helperCrashSummary(stderr),
    'panic: runtime error: invalid memory address or nil pointer dereference [signal SIGSEGV: segmentation violation code=0x1 addr=0x1b pc=0x1b] @ singleflight.(*Group).doCall.func2 (singleflight.go:297)',
  )
})

test('analyzeCrashExit writes a 0600 dump and points the summary at it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-crashdump-'))
  try {
    const stateDir = join(dir, 'state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, '.keep'), '', { flag: 'a' })
    const stderr = [
      'panic: runtime error: invalid memory address or nil pointer dereference',
      '[signal SIGSEGV: segmentation violation code=0x1 addr=0x1b pc=0x1b]',
      '',
      'goroutine 21 [running]:',
      'tailscale.com/util/singleflight.(*Group).doCall(0x1400012c000, {0x140001d20e0, 0x0})',
      '    tailscale.com@v1.102.3/util/singleflight/singleflight.go:297 +0x45c',
    ].join('\n')
    const analysis = await analyzeCrashExit(stderr, stateDir)
    assert.ok(analysis.dumpPath !== undefined, 'expected a dump path')
    assert.ok(analysis.dumpPath.startsWith(stateDir), 'dump should live in the state dir')
    assert.equal(analysis.summary.includes('panic: runtime error'), true)
    const dump = await readFile(analysis.dumpPath!, 'utf8')
    assert.equal(dump, stderr)
    const stat = await import('node:fs/promises').then((m) => m.stat(analysis.dumpPath!))
    assert.equal(stat.mode & 0o777, 0o600, 'dump must be 0600')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('analyzeCrashExit skips writing when the exit is not a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-crashdump-skip-'))
  try {
    const stateDir = join(dir, 'state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, '.keep'), '', { flag: 'a' })
    const analysis = await analyzeCrashExit('helper exited (SIGTERM)', stateDir)
    assert.equal(analysis.dumpPath, undefined)
    assert.equal(analysis.summary, 'helper exited (SIGTERM)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('analyzeCrashExit dumps the real goroutine-103 format with no signal line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-crashdump-103-'))
  try {
    const stateDir = join(dir, 'state')
    await mkdir(stateDir, { recursive: true })
    const stderr = [
      'panic: runtime error: invalid memory address or nil pointer dereference',
      '',
      'goroutine 103 [running]:',
      'tailscale.com/util/singleflight.(*Group[...]).doCall.func2(0x3cdce79dc280, 0x0, 0x3cdce7b01e80?)',
      '        tailscale.com@v1.102.3/util/singleflight/singleflight.go:297 +0x16b',
      'created by tailscale.com/util/singleflight.(*Group[...]).DoChanContext in goroutine 102',
      '        tailscale.com@v1.102.3/util/singleflight/singleflight.go:194 +0x45c',
    ].join('\n')
    const analysis = await analyzeCrashExit(stderr, stateDir)
    assert.ok(analysis.dumpPath !== undefined, 'expected a dump path')
    const dump = await readFile(analysis.dumpPath!, 'utf8')
    assert.equal(dump, stderr)
    assert.ok(analysis.summary.includes('singleflight.(*Group).doCall.func2'),
      `expected closure symbol in summary, got: ${analysis.summary}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('analyzeCrashExit trims to the newest MAX_CRASH_DUMPS dumps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-crashdump-trim-'))
  try {
    const stateDir = join(dir, 'state')
    await mkdir(stateDir, { recursive: true })
    const stderr = ['panic: runtime error: invalid memory address or nil pointer dereference', '',
      'goroutine 8 [running]:',
      'main.main', '    helper/main.go:196 +0x20',
    ].join('\n')
    // Simulate an already-full directory of older dumps, then one more crash.
    for (let i = 0; i < MAX_CRASH_DUMPS; i++) {
      await writeFile(join(stateDir, `crash-${1_000 + i}.log`), stderr, { mode: 0o600 })
    }
    const analysis = await analyzeCrashExit(stderr, stateDir)
    assert.ok(analysis.dumpPath !== undefined)
    const names = (await readdir(stateDir)).filter((n) => n.startsWith('crash-'))
    assert.equal(names.length, MAX_CRASH_DUMPS, 'old dumps should be trimmed to the newest cap')
    assert.ok(names.includes(join(analysis.dumpPath!).split('/').pop()!), 'new dump should be retained')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('analyzeCrashExit tolerates an unwritable state dir and returns only the summary', async () => {
  const analysis = await analyzeCrashExit('panic: boom', '/nonexistent-ro/state')
  assert.equal(analysis.dumpPath, undefined)
  assert.equal(analysis.summary, 'panic: boom')
})

test('supervisor surfaces the panic reason when the helper process crashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-sup-panic-'))
  try {
    // A stub that crashes exactly like the Go helper does: emit a structured
    // stdout event, then dump a panic-style stack to stderr and die non-zero.
    const helper = join(dir, 'panic-helper')
    const stateDir = join(dir, 'state')
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' '{"phase":"starting"}'`,
      "printf '%s\\n' 'panic: runtime error: invalid memory address or nil pointer dereference' >&2",
      "printf '%s\\n' '[signal SIGSEGV: segmentation violation code=0x1 addr=0x1b pc=0x1b]' >&2",
      "printf '%s\\n' 'goroutine 21 [running]:' >&2",
      "printf '%s\\n' 'tailscale.com/net/dnscache.(*Resolver).lookupIP(0x1400012c000, {0x140001d20e0, 0x140001d20e0})' >&2",
      "printf '%s\\n' '    tailscale.com@v1.102.3/net/dnscache/dnscache.go:604 +0x25c' >&2",
      "printf '%s\\n' 'created by tailscale.com/util/singleflight.(*Group).doCall in goroutine 9' >&2",
      "printf '%s\\n' '    tailscale.com@v1.102.3/util/singleflight/singleflight.go:297 +0x45c' >&2",
      'exit 2',
      '',
    ].join('\n')
    await writeFile(helper, script, { mode: 0o755 })
    const supervisor = new RemoteSupervisor({
      enabled: true,
      hostname: 'panic-probe',
      statePath: stateDir,
      helperPath: helper,
      log: () => {},
    })
    await supervisor.start('http://127.0.0.1:39997')
    // start() resolves immediately after spawning; wait for the child exit.
    for (let waited = 0; waited < 2_000 && supervisor.status().phase !== 'error'; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const status = supervisor.status()
    assert.equal(status.phase, 'error')
    assert.ok(status.message?.startsWith('panic: runtime error: invalid memory address'),
      `expected panic reason as the message, got: ${status.message}`)
    assert.ok(!status.message?.includes('singleflight.go:194'),
      `message must not be the trailing stack frame, got: ${status.message}`)
    assert.ok(status.message?.includes('full dump:'), `expected a dump path, got: ${status.message}`)
    const dumpMatch = /full dump: (.+)\)$/.exec(status.message ?? '')
    assert.ok(dumpMatch !== null, `could not parse dump path from: ${status.message}`)
    const dumpPath = dumpMatch[1]!
    assert.ok(dumpPath.startsWith(stateDir), `dump should live under state dir, got ${dumpPath}`)
    const dump = await readFile(dumpPath, 'utf8')
    assert.ok(dump.includes('panic: runtime error'), 'dump should include the full panic')
    assert.ok(dump.includes('singleflight.go:297'), 'dump should include the full stack')
    await supervisor.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- N3: backoff schedule differs by failure category ----------

test('unavailable failures throttle to a fixed window, crashes keep exponential backoff', () => {
  // A missing helper binary / unwritable state dir will not self-heal on a
  // tight loop; the old schedule (1s..30s) would have hammered the host
  // every restart. Unavailable is now a flat 60s wait. Crashes still get the
  // exponential ladder so a transient helper failure recovers quickly.
  for (const attempt of [0, 1, 5, 50]) {
    assert.equal(
      restartDelayMs('unavailable', attempt), 60_000,
      `unavailable attempt ${attempt} must always be 60s`,
    )
  }
  assert.equal(restartDelayMs('crash', 0), 1_000)
  assert.equal(restartDelayMs('crash', 1), 2_000)
  assert.equal(restartDelayMs('crash', 2), 4_000)
  assert.equal(restartDelayMs('crash', 5), 30_000, 'final plateau of the crash schedule')
  assert.equal(
    restartDelayMs('crash', 999), 30_000,
    'out-of-range attempt must saturate at the plateau, not throw',
  )
})
