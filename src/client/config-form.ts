/**
 * Bind the rc.1 profile config form for the browser half of the plugin.
 * The adapter preserves the settings page's snapshot and rejected-write
 * behavior while the form reads and writes this plugin's profile entry.
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

/** The settings page's local snapshot and write contract. */
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
   * when an undeclared service property is read. The form is resolved through
   * `get` because it may be provided after this entry applies.
   */
  get(name: string): unknown
}

/**
 * Deep-unwrap live-update references in a snapshot section.
 *
 * Volatile fields can arrive as `{ get() }` references. The settings page
 * compares plain values, so unwrap them at this boundary.
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
 * Adapt one config form to the settings page's local contract.
 *
 * The form resolves writes as `Promise<boolean>` (false = the Host rejected or
 * could not recover the write) where the scope face signals failure by
 * rejecting — the page's optimistic-write rollback only runs on rejection, so
 * a `false` must be translated into one.
 *
 * @param forms - the 0.1.7 configForms service, if the host provides it.
 * @param entryId - profile entry id.
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
 * Bind the rc.1 form if its service is already provisioned. Callers that
 * apply first retry inside `ctx.inject(['configForms'], …)`.
 */
export function bindConfigForm(ctx: SettingsScopeProvider): SettingsScopeLike | undefined {
  return adaptConfigForm(ctx.get('configForms') as ConfigFormsLike | undefined, 'deeppilot')
}
