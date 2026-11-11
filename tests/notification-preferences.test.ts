import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DeviceStore } from '../src/token.ts'
import { inQuietHours, isNotificationPreferences } from '../src/notification-preferences.ts'
import { apnsPayload } from '../src/apns.ts'
import { registryRowFor, validatePayload } from '../src/wire-registry.ts'
import { createTestIdentity, registerTestIdentity } from './auth-fixture.ts'
import type { NotificationPreferences } from '../src/protocol.ts'

const preferences = (startMinutes: number, endMinutes: number, timeZone = 'Asia/Shanghai'): NotificationPreferences =>
  ({ soundEnabled: false, quietHours: { enabled: true, startMinutes, endMinutes, timeZone } })

test('quiet hours use device IANA time zone and inclusive start/exclusive end across midnight', () => {
  const q = preferences(22 * 60, 8 * 60)
  for (const [at, expected] of [
    ['2026-11-10T13:59:59Z', false], ['2026-11-10T14:00:00Z', true],
    ['2026-11-10T16:00:00Z', true], ['2026-11-10T23:59:59Z', true],
    ['2026-11-11T00:00:00Z', false],
  ] as const) assert.equal(inQuietHours(q, Date.parse(at)), expected, at)
  assert.equal(inQuietHours(preferences(9 * 60, 17 * 60), Date.parse('2026-11-10T01:00:00Z')), true)
  assert.equal(inQuietHours(preferences(9 * 60, 17 * 60), Date.parse('2026-11-10T09:00:00Z')), false)
  assert.equal(inQuietHours(preferences(120, 120), Date.parse('2026-11-10T00:00:00Z')), true)
  assert.equal(inQuietHours({ soundEnabled: false, quietHours: { ...q.quietHours!, enabled: false } }), false)
  assert.equal(inQuietHours(), false)
})

test('quiet hours follow repeated and skipped wall-clock times at DST changes', () => {
  const q = preferences(60, 120, 'America/New_York')
  // Both instances of 01:30 during fall-back are quiet, 02:00 is not.
  assert.equal(inQuietHours(q, Date.parse('2026-11-01T05:30:00Z')), true)
  assert.equal(inQuietHours(q, Date.parse('2026-11-01T06:30:00Z')), true)
  assert.equal(inQuietHours(q, Date.parse('2026-11-01T07:00:00Z')), false)
  const spring = preferences(120, 180, 'America/New_York')
  assert.equal(inQuietHours(spring, Date.parse('2026-03-08T06:59:59Z')), false)
  assert.equal(inQuietHours(spring, Date.parse('2026-03-08T07:00:00Z')), false)
})

test('push registration rejects malformed preferences instead of using host-local defaults', () => {
  const row = registryRowFor('c2s.push.register')!
  const valid = preferences(0, 0)
  assert.equal(isNotificationPreferences(valid), true)
  for (const value of [null, {}, { soundEnabled: 0 }, preferences(-1, 60), preferences(0, 1440),
    preferences(1.5, 60), preferences(0, 60, 'invalid/zone'), preferences(0, 60, '+08:00'),
    { soundEnabled: false, quietHours: [] }]) {
    assert.equal(isNotificationPreferences(value), false)
    assert.equal(validatePayload(row, { deviceToken: 'a'.repeat(64), preferences: value }).ok, false)
  }
  assert.equal(validatePayload(row, { deviceToken: 'a'.repeat(64), preferences: valid }).ok, true)
})

test('device preference persistence survives token rotation and old registrations preserve the last explicit choice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-prefs-'))
  const path = join(dir, 'devices.json')
  const store = await DeviceStore.load(path)
  const identity = createTestIdentity()
  registerTestIdentity(store, identity)
  try {
    const q = preferences(1320, 480)
    store.setPushToken(identity.deviceId, 'a'.repeat(64), 'production', undefined, 1, q)
    q.soundEnabled = true // storage must not retain the caller's mutable object
    store.setPushToken(identity.deviceId, 'b'.repeat(64), 'development', undefined, 2)
    await store.drain()
    const restored = await DeviceStore.load(path)
    assert.deepEqual(restored.authorized(identity.deviceId)?.apns?.preferences, preferences(1320, 480))
    store.setPushToken(identity.deviceId, 'b'.repeat(64), 'development', undefined, 3, { soundEnabled: true })
    assert.deepEqual(store.authorized(identity.deviceId)?.apns?.preferences, { soundEnabled: true })
  } finally { await store.drain(); await rm(dir, { recursive: true, force: true }) }
})

test('direct APNs keeps default sound for legacy clients and omits sound for explicit false', () => {
  const notification = { notificationId: 'n', sessionId: 's', category: 'goal.completed' as const, title: 'Goal', body: 'Done' }
  for (const [soundEnabled, expected] of [[undefined, 'default'], [true, 'default'], [false, undefined]] as const) {
    const aps = apnsPayload({ ...notification, soundEnabled }).aps as Record<string, unknown>
    assert.equal(aps.sound, expected)
    assert.equal(aps['interruption-level'], undefined)
  }
})
