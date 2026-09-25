import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptConfigForm, bindConfigForm } from '../src/client/config-form.ts'

/** Minimal 0.1.7 config-form fake with test controls. */
function fakeForm(options?: { accepted?: boolean; value?: Record<string, unknown> }) {
  const accepted = options?.accepted ?? true
  let snapshot = {
    status: 'ready' as 'loading' | 'ready' | 'unavailable',
    value: options?.value ?? { enabled: false, local: { enabled: true, port: 4000 } },
    writable: true,
  }
  const listeners = new Set<() => void>()
  const writes: Array<{ field: string; value?: unknown; unset?: boolean }> = []
  return {
    writes,
    emit() { for (const listener of [...listeners]) listener() },
    next(next: typeof snapshot) { snapshot = next; },
    face: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async (field: string, value: unknown) => {
        writes.push({ field, value })
        return accepted
      },
      unset: async (field: string) => {
        writes.push({ field, unset: true })
        return accepted
      },
    },
  }
}

test('adaptConfigForm maps the form snapshot onto the scope face', () => {
  const form = fakeForm()
  const scope = adaptConfigForm({ get: () => form.face }, 'deeppilot')
  assert.ok(scope)
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.writable, true)
  assert.deepEqual(snapshot.value, { enabled: false, local: { enabled: true, port: 4000 } })
})

test('adaptConfigForm resolves set() only when the host accepted the write', async () => {
  const accepted = fakeForm({ accepted: true })
  const scope = adaptConfigForm({ get: () => accepted.face }, 'deeppilot')
  assert.ok(scope)
  // A resolved write maps to a resolved promise (page keeps the optimistic value).
  await scope.set('enabled', true)
  assert.deepEqual(accepted.writes, [{ field: 'enabled', value: true }])

  // A rejected write (false, no throw from the form) must surface as a
  // rejection so the page's rollback path runs — silently treating it as
  // success would leave the UI in a state the Host never accepted.
  const rejected = fakeForm({ accepted: false })
  const rejectScope = adaptConfigForm({ get: () => rejected.face }, 'deeppilot')
  assert.ok(rejectScope)
  await assert.rejects(
    () => rejectScope.set('enabled', false),
    /host rejected the settings write/,
  )
  await assert.rejects(
    () => rejectScope.unset('enabled'),
    /host rejected the settings write/,
  )
})

test('adaptConfigForm forwards subscribe to the form', () => {
  const form = fakeForm()
  const scope = adaptConfigForm({ get: () => form.face }, 'deeppilot')
  assert.ok(scope)
  let ticks = 0
  const off = scope.subscribe(() => { ticks += 1 })
  form.emit()
  assert.equal(ticks, 1)
  off()
  form.emit()
  assert.equal(ticks, 1)
})

test('bindConfigForm binds the rc.2 config form', () => {
  const form = fakeForm()
  const scope = bindConfigForm({ get: () => ({ get: () => form.face }) })
  assert.ok(scope)
  assert.equal(scope.getSnapshot().status, 'ready')
})

test('bindConfigForm stays undefined when no form exists', () => {
  assert.equal(bindConfigForm({ get: () => undefined }), undefined)
  assert.equal(bindConfigForm({ get: () => ({}) }), undefined)
})

test('bindConfigForm resolves configForms through ctx.get', () => {
  // An undeclared Cordis service property read throws, so use ctx.get.
  const form = fakeForm()
  const resolved: string[] = []
  const scope = bindConfigForm({
    get: (name: string) => {
      resolved.push(name)
      return name === 'configForms' ? { get: () => form.face } : undefined
    },
  })
  assert.ok(scope)
  assert.deepEqual(resolved, ['configForms'])
  assert.equal(scope.getSnapshot().status, 'ready')

  // Nothing provided at all: the adapter reports no form.
  assert.equal(bindConfigForm({ get: () => undefined }), undefined)
})
