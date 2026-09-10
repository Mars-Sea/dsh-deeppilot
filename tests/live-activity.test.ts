import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../src/token.ts'
import { createTestIdentity, registerTestIdentity } from './auth-fixture.ts'
import { liveActivityState, LiveActivityPushManager } from '../src/live-activity.ts'
import { apnsPayload, pushHeaders } from '../src/apns.ts'
import { validateRequest } from '../src/request-validation.ts'
import { requiredScope } from '../src/connection-policy.ts'
import type { LiveActivityPushNotification, SessionSummary } from '../src/protocol.ts'

const session: SessionSummary = { workspaceLabel: null, id: 's', title: 'Work', status: 'running', lastActivityTs: 1,
  todos: { done: 1, total: 3 }, todoItems: [{ content: 'Next', status: 'pending' }, { content: 'Now', status: 'in_progress' }],
  pendingApproval: false, pendingQuestion: false }

test('activity projection preserves partial completion and current task', () => {
  assert.equal(liveActivityState(session).task, 'Now')
  assert.equal(liveActivityState({ ...session, pendingApproval: true }).phase, 'approval')
  assert.equal(liveActivityState({ ...session, pendingQuestion: true }).phase, 'question')
  assert.deepEqual(liveActivityState({ ...session, status: 'idle' }), { title: 'Work', task: 'Now', done: 1, total: 3, phase: 'ended' })
  assert.equal(liveActivityState().phase, 'unavailable')
  assert.equal(liveActivityState({ ...session, status: 'unknown' }).phase, 'unavailable')
  assert.equal(liveActivityState({ ...session, status: 'idle', pendingApproval: true }).phase, 'approval')
  assert.equal(Array.from(liveActivityState({ ...session, title: '😀'.repeat(200) }).title).length, 100)
})

test('activity wire format uses dedicated APNs topic and strict registration shape', () => {
  const notification: LiveActivityPushNotification = { kind: 'liveactivity', timestamp: 100, event: 'update', contentState: liveActivityState(session) }
  assert.deepEqual(apnsPayload(notification), { aps: { timestamp: 100, event: 'update', 'content-state': notification.contentState, 'stale-date': 280 } })
  assert.equal(pushHeaders('dev.test', notification)['apns-topic'], 'dev.test.push-type.liveactivity')
  assert.equal(pushHeaders('dev.test', notification)['apns-push-type'], 'liveactivity')
  assert.equal((apnsPayload({ ...notification, event: 'end' }).aps as any)['dismissal-date'], 400)
  const p = { activityId: 'a', sessionId: 's', deviceToken: 'a'.repeat(64), environment: 'development' }
  assert.equal(validateRequest('c2s.liveActivity.register', p), undefined)
  assert.ok(validateRequest('c2s.liveActivity.register', { ...p, environment: 'wrong' }))
  assert.ok(validateRequest('c2s.liveActivity.register', { ...p, deviceToken: 'bad' }))
  assert.ok(validateRequest('c2s.liveActivity.unregister', {}))
  assert.equal(requiredScope('c2s.liveActivity.register'), 'notifications.register')
})

test('terminal state survives next round, reconnect and rotation; revoked scopes suppress pushes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-activity-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const identity = createTestIdentity()
  registerTestIdentity(store, identity)
  const registration = { activityId: 'a', sessionId: 's', token: 'a'.repeat(64), environment: 'development' as const, updatedAt: Date.now(), expiresAt: Date.now() + 100_000 }
  store.setLiveActivity(identity.deviceId, registration)
  const deliveries: LiveActivityPushNotification[] = []
  const manager = new LiveActivityPushManager(() => store, async (_token, _env, notification) => { deliveries.push(notification); return { outcome: 'sent' } })
  try {
    manager.changed([session]); await manager.flush()
    assert.equal(deliveries[0]?.event, 'update')
    manager.changed([{ ...session, status: 'idle' }])
    manager.changed([{ ...session, todos: { done: 0, total: 8 } }])
    await manager.flush()
    assert.equal(deliveries[1]?.event, 'end')
    assert.equal(deliveries[1]?.contentState.total, 3)
    store.setLiveActivity(identity.deviceId, { ...registration, token: 'b'.repeat(64) })
    await store.drain()
    const reloaded = await DeviceStore.load(join(dir, 'devices.json'))
    assert.equal(reloaded.authorized(identity.deviceId)?.liveActivity?.endedState?.phase, 'ended')
    store.clearLiveActivity(identity.deviceId, 'a', registration.token)
    assert.equal(store.authorized(identity.deviceId)?.liveActivity?.token, 'b'.repeat(64))
    manager.changed([session]); await manager.flush()
    assert.equal(deliveries[2]?.event, 'end')
    store.setLiveActivity(identity.deviceId, { ...registration, activityId: 'second' })
    store.setScopes(identity.deviceId, ['sessions.read'])
    manager.changed([session]); await manager.flush()
    assert.equal(deliveries.length, 3)
    assert.equal(store.authorized(identity.deviceId)?.liveActivity, undefined)
  } finally {
    manager.dispose(); await store.drain(); await rm(dir, { recursive: true, force: true })
  }
})
