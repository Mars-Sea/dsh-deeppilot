import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeviceStore, MAX_DEVICES, loadOrCreateToken, tokenMatches, writeNewToken } from '../src/token.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pbb-token-'))
}

test('writeNewToken replaces the stored secret and invalidates the old one', async () => {
  const dir = await makeTempDir()
  try {
    const tokenPath = join(dir, 'auth-token')
    const original = await loadOrCreateToken(tokenPath)
    assert.ok(original.length >= 32)

    const rotated = await writeNewToken(tokenPath)
    assert.notEqual(rotated, original)
    assert.ok(rotated.length >= 32)

    // The persisted file now holds only the new secret...
    const persisted = (await readFile(tokenPath, 'utf8')).trim()
    assert.equal(persisted, rotated)
    // ...so the old token no longer matches.
    assert.equal(tokenMatches(original, persisted), false)
    assert.equal(tokenMatches(rotated, persisted), true)

    // Rotation twice in a row keeps working (temp files never collide).
    const again = await writeNewToken(tokenPath)
    assert.notEqual(again, rotated)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadOrCreateToken refuses to overwrite a malformed existing token', async () => {
  const dir = await makeTempDir()
  try {
    const tokenPath = join(dir, 'auth-token')
    await writeFile(tokenPath, 'truncated-token\n', 'utf8')
    await assert.rejects(loadOrCreateToken(tokenPath), /pairing token is malformed/)
    assert.equal(await readFile(tokenPath, 'utf8'), 'truncated-token\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeNewToken leaves no temp files behind', async () => {
  const dir = await makeTempDir()
  try {
    const tokenPath = join(dir, 'auth-token')
    await loadOrCreateToken(tokenPath)
    await writeNewToken(tokenPath)
    const entries = await readdir(dir)
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [])
    assert.deepEqual(entries.sort(), ['auth-token'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DeviceStore.clear drops every paired-device record', async () => {
  const dir = await makeTempDir()
  try {
    const store = await DeviceStore.load(join(dir, 'devices.json'))
    store.touch({ deviceId: 'device-1', deviceName: 'iPhone', appVersion: '0.1.0' }, 1)
    store.touch({ deviceId: 'device-2', deviceName: 'iPad', appVersion: '0.1.0' }, 2)
    assert.equal(store.list().length, 2)

    store.clear()
    await store.drain()
    assert.deepEqual(store.list(), [])

    // A reload observes the cleared registry too (flush happened).
    const reloaded = await DeviceStore.load(join(dir, 'devices.json'))
    assert.deepEqual(reloaded.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('device registry is capped and evicts the least-recently-seen device', async () => {
  const dir = await makeTempDir()
  try {
    const store = await DeviceStore.load(join(dir, 'devices.json'))
    const overflow = 10
    for (let i = 0; i < MAX_DEVICES + overflow; i++) {
      store.touch({ deviceId: `device-${i}`, deviceName: `Phone ${i}`, appVersion: '0.1.0' }, i + 1)
    }
    let rows = store.list()
    assert.equal(rows.length, MAX_DEVICES, 'registry stays at the cap')
    // The `overflow` oldest devices made room for the newcomers.
    for (let i = 0; i < overflow; i++) {
      assert.equal(rows.some((r) => r.deviceId === `device-${i}`), false, `device-${i} was evicted`)
    }
    assert.equal(rows.some((r) => r.deviceId === `device-${MAX_DEVICES - 1 + overflow}`), true, 'newest device survived')

    // Refreshing an existing device updates it without eviction pressure.
    const before = rows.find((r) => r.deviceId === `device-${MAX_DEVICES}`)!.lastSeenTs
    store.touch({ deviceId: `device-${MAX_DEVICES}`, deviceName: 'Renamed', appVersion: '0.2.0' }, 10_000)
    await store.drain()
    rows = store.list()
    assert.equal(rows.length, MAX_DEVICES)
    const refreshed = rows.find((r) => r.deviceId === `device-${MAX_DEVICES}`)!
    assert.ok(refreshed.lastSeenTs > before)
    assert.equal(refreshed.deviceName, 'Renamed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent touches never leave a half-written devices.json behind', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'devices.json')
    const store = await DeviceStore.load(path)
    // Fire 40 touches with no awaiting in between; serialized flushes must
    // still land a parseable document.
    for (let i = 0; i < 40; i++) {
      store.touch({ deviceId: `d-${i}`, deviceName: `N${i}`, appVersion: '1' }, i)
    }
    await store.drain()
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { version: number; devices: Array<{ deviceId: string }> }
    assert.equal(parsed.version, 1)
    assert.deepEqual(
      parsed.devices.map((d) => d.deviceId).sort(),
      [...Array(40).keys()].map((i) => `d-${i}`).sort(),
      'every touched device is present exactly once',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- N2: corrupt-token sidecar + loud throw ----------

test('a truncated auth-token throws and preserves the original as a .corrupt sidecar', async () => {
  // N2: silently regenerating a token used to orphan every paired phone with
  // no on-disk clue. Now the loader must (a) refuse to start a session with a
  // malformed file, and (b) copy the broken file to <path>.corrupt so an
  // operator can inspect the cause.
  const dir = await makeTempDir()
  try {
    const tokenPath = join(dir, 'auth-token')
    // Plant a 12-char string (well under the 32-char minimum): a disk-full
    // truncation, an editor saving a partial file, anything below the bar.
    const broken = 'short-token-12'
    await writeFile(tokenPath, broken + '\n', { mode: 0o600 })

    await assert.rejects(
      () => loadOrCreateToken(tokenPath),
      /pairing token is malformed at/,
      'loadOrCreateToken must refuse to overwrite a corrupted file',
    )

    // The original must still be on disk (untouched), and a .corrupt sidecar
    // must hold the exact bytes the operator would have lost.
    const stillThere = (await readFile(tokenPath, 'utf8')).trim()
    assert.equal(stillThere, broken, 'the broken file is not overwritten')
    const sidecar = await readFile(tokenPath + '.corrupt', 'utf8')
    assert.equal(sidecar.trim(), broken, 'the .corrupt sidecar carries the same bytes')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
