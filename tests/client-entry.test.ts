/**
 * Client-entry activation across DSH generations.
 *
 * DSH 0.1.7 removed the client `settingsScope` service. The settings seam was
 * declared in the entry's own `inject`, so on a 0.1.7 host the browser boot
 * audit failed with `dsh-deeppilot: pending (waiting for service:
 * settingsScope)` and the entry never applied — the whole DeepPilot settings
 * page vanished even though every other service resolved.
 *
 * These tests run the real client entry against a real Cordis context shaped
 * like each host generation and assert what that audit checks: every name in
 * the entry's `inject` resolves, and the fiber reaches ACTIVE. They also pin
 * the seam behavior behind it (which store adopts which host face, and that a
 * late-provisioned service still binds).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as clientEntry from '../src/client/index.ts'

/** Numeric state mirroring Cordis's `const enum FiberState` (value 2 = ACTIVE). */
const ACTIVE = 2

interface SnapshotLike {
  status: 'loading' | 'ready' | 'unavailable'
  value?: Record<string, unknown>
  writable?: boolean
}

interface FormFace {
  getSnapshot(): SnapshotLike
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

interface HooksFace {
  hooks: Record<string, { getSnapshot(): unknown }>
  setDeepPilotEnabled(value: boolean): void
  setDeepPilotLocalPort(value: number): Promise<void>
}

/** 0.1.7 config form fake: records writes, resolves the acceptance boolean. */
function fakeConfigForm(value: Record<string, unknown>, accepted = true): { face: FormFace; writes: Array<{ field: string; value: unknown }> } {
  const listeners = new Set<() => void>()
  const writes: Array<{ field: string; value: unknown }> = []
  return {
    writes,
    face: {
      getSnapshot: () => ({ status: 'ready', value, writable: true }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async (field, next) => {
        writes.push({ field, value: next })
        return accepted
      },
      unset: async () => accepted,
    },
  }
}

/** ≤0.1.6 settings scope fake: the legacy seam's bind() face. */
function fakeSettingsScope(value: Record<string, unknown>) {
  const listeners = new Set<() => void>()
  const writes: Array<{ field: string; value: unknown }> = []
  const bound: string[] = []
  const scope = {
    getSnapshot: () => ({ status: 'ready' as const, value, writable: true }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field: string, next: unknown) => { writes.push({ field, value: next }) },
    unset: async () => {},
  }
  return {
    writes,
    bound,
    service: {
      bind: (spec: { namespace: string }) => {
        bound.push(spec.namespace)
        return scope
      },
    },
  }
}

/**
 * Root context with exactly the services every supported host provides, plus a
 * slots face that captures the registered `settings.section` entry so tests can
 * drive the inject face the renderer would call.
 */
function harness() {
  const root = new Context()
  const sections: Array<{ inject: () => HooksFace }> = []
  root.provide('slots', {
    inject: (_name: string, callback: () => unknown) => { callback() },
    register: (entry: unknown) => {
      sections.push(entry as { inject: () => HooksFace })
      return () => {}
    },
  })
  root.provide('locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
  })
  // The report remote is exercised by its own tests; here it only has to
  // resolve so the settings section registers.
  root.provide('remote', { $mount: async () => async () => {} })
  return { root, sections }
}

function loadEntry(root: Context) {
  return root.plugin({
    name: 'dsh-deeppilot',
    inject: [...clientEntry.inject],
    apply: clientEntry.apply,
  })
}

/** Missing required services, as the web boot audit computes them. */
function missingServices(root: Context, fiber: { inject: Record<string, unknown> }): string[] {
  return Object.keys(fiber.inject).filter((service) => root.get(service) === undefined)
}

/** Let service wake-ups and queued promise callbacks settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

function faceOf(sections: Array<{ inject: () => HooksFace }>): HooksFace {
  const entry = sections[0]
  assert.ok(entry, 'the settings.section entry was registered')
  return entry.inject()
}

test('the client entry never requires a service one host generation lacks', () => {
  // `settingsScope` (≤ 0.1.6) and `configForms` (0.1.7) are mutually exclusive
  // across generations: either name in this list bricks activation on the
  // other host, because the boot audit waits for it forever.
  assert.deepEqual([...clientEntry.inject], ['slots', 'locale', 'remote'])
})

test('a 0.1.7 host activates the entry and binds a late configForms service', async () => {
  const { root, sections } = harness()
  const fiber = loadEntry(root)
  await fiber

  // The failure this test exists for: no settingsScope exists on 0.1.7, and
  // the entry must still reach ACTIVE with nothing missing.
  assert.equal(root.get('settingsScope'), undefined)
  assert.equal(fiber.state, ACTIVE, 'entry fiber is active without settingsScope')
  assert.deepEqual(missingServices(root, fiber), [])

  const face = faceOf(sections)
  // configForms arrives after this plugin applies (its own page fiber provides
  // it), so the switches wait rather than binding to nothing.
  assert.deepEqual(face.hooks.deepPilotEnabled.getSnapshot(), { status: 'loading', enabled: true })

  const form = fakeConfigForm({
    enabled: false,
    local: { enabled: true, port: 4123 },
    remote: { enabled: true, maxConnectionsPerSource: 5 },
  })
  const requested: string[] = []
  root.provide('configForms', {
    get: (entryId: string) => {
      requested.push(entryId)
      return entryId === 'deeppilot' ? form.face : undefined
    },
  })
  await settle()

  // The 0.1.7 namespace is the host plugin entry id from this bundle's patch.
  assert.deepEqual(requested, ['deeppilot'])
  assert.deepEqual(face.hooks.deepPilotEnabled.getSnapshot(), { status: 'ready', enabled: false })
  assert.deepEqual(face.hooks.deepPilotLocalPort.getSnapshot(), { status: 'ready', value: 4123 })
  assert.deepEqual(face.hooks.deepPilotRemoteEnabled.getSnapshot(), { status: 'ready', enabled: true })
  assert.deepEqual(face.hooks.deepPilotRemoteConnectionLimit.getSnapshot(), { status: 'ready', value: 5 })

  // Writes travel through the adapted form, not the removed service.
  face.setDeepPilotEnabled(true)
  await settle()
  assert.deepEqual(form.writes, [{ field: 'enabled', value: true }])
})

test('a ≤ 0.1.6 host binds the legacy settingsScope and ignores configForms', async () => {
  const { root, sections } = harness()
  const legacy = fakeSettingsScope({
    enabled: false,
    local: { enabled: false, port: 3200 },
    remote: { enabled: false, maxConnectionsPerSource: 3 },
  })
  root.provide('settingsScope', legacy.service)

  const fiber = loadEntry(root)
  await fiber

  assert.equal(fiber.state, ACTIVE)
  assert.deepEqual(missingServices(root, fiber), [])
  // Bound at apply time: the page is ready without waiting for anything.
  assert.deepEqual(legacy.bound, ['deeppilot'])

  const face = faceOf(sections)
  assert.deepEqual(face.hooks.deepPilotEnabled.getSnapshot(), { status: 'ready', enabled: false })
  assert.deepEqual(face.hooks.deepPilotLocalPort.getSnapshot(), { status: 'ready', value: 3200 })
  assert.deepEqual(face.hooks.deepPilotRemoteConnectionLimit.getSnapshot(), { status: 'ready', value: 3 })

  face.setDeepPilotEnabled(true)
  await settle()
  assert.deepEqual(legacy.writes, [{ field: 'enabled', value: true }])
})

test('a ≤ 0.1.6 host binds a settingsScope provisioned after apply', async () => {
  // Dropping the hard requirement also means the entry may now apply before
  // the legacy service exists (entry activation order is not a dependency
  // order). The optional injection has to catch that ordering too, or 0.1.6
  // silently loses the settings bindings instead of failing loudly.
  const { root, sections } = harness()
  const legacy = fakeSettingsScope({ enabled: true, local: { port: 3098 } })

  const fiber = loadEntry(root)
  await fiber
  assert.equal(fiber.state, ACTIVE)

  const face = faceOf(sections)
  assert.deepEqual(legacy.bound, [], 'nothing bound while the service was absent')
  assert.deepEqual(face.hooks.deepPilotEnabled.getSnapshot(), { status: 'loading', enabled: true })

  root.provide('settingsScope', legacy.service)
  await settle()
  assert.deepEqual(legacy.bound, ['deeppilot'])
  assert.deepEqual(face.hooks.deepPilotEnabled.getSnapshot(), { status: 'ready', enabled: true })
  assert.deepEqual(face.hooks.deepPilotLocalPort.getSnapshot(), { status: 'ready', value: 3098 })
})

test('a host with neither settings seam still activates the entry', async () => {
  // A future generation may rename the seam again. Losing the settings
  // namespace must degrade to a page stuck on its loading copy — never to a
  // pending entry that takes the whole plugin down.
  const { root, sections } = harness()
  const fiber = loadEntry(root)
  await fiber

  assert.equal(fiber.state, ACTIVE)
  assert.deepEqual(missingServices(root, fiber), [])
  assert.deepEqual(faceOf(sections).hooks.deepPilotEnabled.getSnapshot(), { status: 'loading', enabled: true })
})
