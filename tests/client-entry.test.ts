/**
 * Client-entry activation against the rc.1 config form service. The form may
 * arrive after this entry applies, so its injection stays optional.
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

test('the client entry permits configForms to arrive after activation', () => {
  assert.deepEqual([...clientEntry.inject], ['slots', 'locale', 'remote'])
})

test('a 0.1.7 host activates the entry and binds a late configForms service', async () => {
  const { root, sections } = harness()
  const fiber = loadEntry(root)
  await fiber

  assert.equal(fiber.state, ACTIVE, 'entry fiber is active before configForms')
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

  // Writes travel through the adapted form.
  face.setDeepPilotEnabled(true)
  await settle()
  assert.deepEqual(form.writes, [{ field: 'enabled', value: true }])
})

test('a host without configForms still activates the entry', async () => {
  // A missing form degrades the settings page without blocking the entry.
  const { root, sections } = harness()
  const fiber = loadEntry(root)
  await fiber

  assert.equal(fiber.state, ACTIVE)
  assert.deepEqual(missingServices(root, fiber), [])
  assert.deepEqual(faceOf(sections).hooks.deepPilotEnabled.getSnapshot(), { status: 'loading', enabled: true })
})
