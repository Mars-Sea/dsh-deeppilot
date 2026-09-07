import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apnsPayload, pushHeaders } from '../src/apns.ts'
import { WidgetPushScheduler } from '../src/widget-push.ts'
import { DeviceStore } from '../src/token.ts'
import { createTestIdentity, registerTestIdentity } from './auth-fixture.ts'
import { validateRequest } from '../src/request-validation.ts'

test('WidgetKit uses the main app topic suffix and a content-free payload', () => {
  assert.deepEqual(apnsPayload({ kind: 'widget' }), { aps: { 'content-changed': true } })
  assert.deepEqual(pushHeaders('dev.test.app', { kind: 'widget' }), {
    'apns-topic': 'dev.test.app.push-type.widgets', 'apns-push-type': 'widgets',
    'apns-priority': '5', 'apns-collapse-id': 'widget-overview',
  })
  assert.equal(validateRequest('c2s.widget.push.register', { environment: 'wrong' }), 'invalid APNs environment')
})

test('widget token rotation, persistence and revocation do not affect alert registrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'widget-push-'))
  const path = join(directory, 'devices.json')
  const store = await DeviceStore.load(path)
  try {
    const identity = createTestIdentity()
    registerTestIdentity(store, identity)
    store.setPushToken(identity.deviceId, 'a'.repeat(64), 'production', undefined, 1)
    store.setWidgetPushToken(identity.deviceId, 'b'.repeat(64), 'development', 2)
    store.setWidgetPushToken(identity.deviceId, 'c'.repeat(64), 'production', 3)
    store.clearWidgetPushToken(identity.deviceId, 'b'.repeat(64))
    await store.drain()
    const reloaded = await DeviceStore.load(path)
    assert.equal(reloaded.authorized(identity.deviceId)?.widgetApns?.token, 'c'.repeat(64))
    assert.equal(reloaded.authorized(identity.deviceId)?.apns?.token, 'a'.repeat(64))
    store.clearWidgetPushToken(identity.deviceId, 'c'.repeat(64))
    assert.equal(store.authorized(identity.deviceId)?.widgetApns, undefined)
    assert.ok(store.authorized(identity.deviceId)?.apns)
    store.setWidgetPushToken(identity.deviceId, 'b'.repeat(64), 'development', 4)
    store.revoke(identity.deviceId, 5)
    assert.equal(store.list()[0]?.widgetApns, undefined)
  } finally {
    await store.drain()
    await rm(directory, { recursive: true, force: true })
  }
})

test('scheduler coalesces bursts, retains trailing changes and stops after disposal', async () => {
  let count = 0
  let release!: () => void
  const scheduler = new WidgetPushScheduler(async () => {
    count++
    if (count === 1) await new Promise<void>(resolve => { release = resolve })
  }, 20)
  try {
    for (let i = 0; i < 20; i++) scheduler.changed()
    for (let i = 0; i < 100 && count === 0; i++) await sleep(5)
    assert.equal(count, 1)
    scheduler.changed()
    release()
    for (let i = 0; i < 100 && count < 2; i++) await sleep(5)
    assert.equal(count, 2)
    scheduler.changed()
    scheduler.dispose()
    await sleep(40)
    assert.equal(count, 2)
  } finally { scheduler.dispose() }
})
