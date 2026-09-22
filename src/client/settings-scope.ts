/**
 * Dual-host settings-scope binding for the browser half of the plugin.
 *
 * DSH ≤ 0.1.6 exposes the plugin's settings section through
 * `ctx.settingsScope.bind({ namespace })`. DSH 0.1.7 removed that service and
 * replaces it with `ctx.configForms.get(entryId)` — a form over this plugin's
 * own profile config entry (the same values the Host half reads through
 * currentConfig()). The two faces are near-isomorphic on purpose: this module
 * adapts the newer form to the older scope shape so the settings page and its
 * stores stay host-agnostic.
 *
 * Structural types only (no value imports): the client bundle's runtime
 * require allowlist is react + @deepseek-ai/cordis.
 */

/** Section fields the settings page reads; other config keys pass through. */
export interface SettingsSectionValue {
  enabled?: boolean
  local?: { enabled?: boolean; port?: number; [key: string]: unknown }
  remote?: { enabled?: boolean; maxConnectionsPerSource?: number; [key: string]: unknown }
  [key: string]: unknown
}

export interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: SettingsSectionValue
  writable?: boolean
}

/** The 0.1.6 settings-scope face the settings page consumes. */
export interface SettingsScopeLike {
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** 0.1.7 ConfigFormController surface used here (structural subset). */
interface ConfigFormLike {
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

/** 0.1.7 `ctx.configForms` service face (structural subset). */
export interface ConfigFormsLike {
  get?(entryId: string): ConfigFormLike
}

interface SettingsScopeProvider {
  /**
   * Cordis service lookup. Real contexts carry this and MUST be read through
   * it: a context proxy throws `cannot get property "<name>" without inject`
   * when an undeclared *service* property is read, which is exactly the
   * 0.1.7 situation (`settingsScope` is gone, `configForms` is not declared
   * on this entry — see client/index.ts). Plain-object callers without `get`
   * fall back to direct property reads.
   */
  get?(name: string): unknown
  settingsScope?: {
    bind(spec: { namespace: string }): SettingsScopeLike | undefined
  }
  configForms?: ConfigFormsLike
}

/** Read one optional settings seam without an inject declaration on this entry. */
function readSeam<T>(ctx: SettingsScopeProvider, name: 'settingsScope' | 'configForms'): T | undefined {
  if (typeof ctx.get === 'function') return (ctx.get(name) ?? undefined) as T | undefined
  return ctx[name] as T | undefined
}

/**
 * Deep-unwrap live-update references in a snapshot section.
 *
 * If a host parses section values through a volatile-capable schema, leaves
 * can arrive as `{ get() }` references; the settings page compares plain
 * values, so unwrap defensively at this single boundary regardless of which
 * schemastery instance produced the snapshot.
 */
function plainSection(value: SettingsSectionValue | undefined): SettingsSectionValue | undefined {
  if (value === null || typeof value !== 'object') return value
  if (typeof (value as { get?: unknown }).get === 'function') {
    return plainSection((value as { get: () => SettingsSectionValue }).get())
  }
  const plain: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    plain[key] = item !== null && typeof item === 'object' ? plainSection(item as SettingsSectionValue) : item
  }
  return plain as SettingsSectionValue
}

/**
 * Adapt one 0.1.7 config form to the settings-scope face.
 *
 * The form resolves writes as `Promise<boolean>` (false = the Host rejected or
 * could not recover the write) where the scope face signals failure by
 * rejecting — the page's optimistic-write rollback only runs on rejection, so
 * a `false` must be translated into one.
 *
 * @param forms - the 0.1.7 configForms service, if the host provides it.
 * @param entryId - profile entry id; identical to the legacy namespace here.
 * @returns the adapted scope, or undefined when the service cannot resolve it.
 */
export function adaptConfigForm(forms: ConfigFormsLike | undefined, entryId: string): SettingsScopeLike | undefined {
  const form = forms?.get?.(entryId)
  if (form === undefined) return undefined
  const accept = async (pending: Promise<boolean>): Promise<void> => {
    if (!(await pending)) throw new Error('host rejected the settings write')
  }
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      return {
        status: snapshot.status,
        value: plainSection(snapshot.value),
        writable: snapshot.writable,
      }
    },
    subscribe: (listener) => form.subscribe(listener),
    set: (field, value) => accept(form.set(field, value)),
    unset: (field) => accept(form.unset(field)),
  }
}

/**
 * Bind the settings scope for whichever host generation is running.
 *
 * Prefers the legacy settingsScope (present ≤ 0.1.6); falls back to the 0.1.7
 * config form when its service is already provisioned. Safe to call from any
 * context — including one that declares neither service, which on a Cordis
 * context is the difference between `undefined` and a thrown
 * `cannot get property "settingsScope" without inject`. Callers that apply
 * before `configForms` is provided re-run this inside the optional
 * `ctx.inject(['configForms'], …)` callback (see client index.ts).
 */
export function bindSettingsScope(ctx: SettingsScopeProvider): SettingsScopeLike | undefined {
  const legacy = readSeam<{ bind(spec: { namespace: string }): SettingsScopeLike | undefined }>(ctx, 'settingsScope')
  return legacy?.bind({ namespace: 'deeppilot' })
    ?? adaptConfigForm(readSeam<ConfigFormsLike>(ctx, 'configForms'), 'deeppilot')
}
