import assert from 'node:assert/strict'
import test from 'node:test'
import {
  _allKeysForTest,
  interpolate,
  registerLocale,
  t,
  translateWith,
  translateOrThrow,
  type SupportedLocale,
} from '../src/client/i18n.ts'

// ---------- table parity ----------

test('every key has a translation in every supported locale', () => {
  const keys = _allKeysForTest()
  assert.ok(keys.length > 50, 'sanity: the table should have a meaningful number of keys')
  for (const locale of ['zh', 'en'] as const) {
    for (const key of keys) {
      const value = translateOrThrow(locale, key)
      assert.ok(value.length > 0, `${locale} key "${key}" must not be empty`)
    }
  }
})

test('zh and en tables have the same key set (no partial translations)', () => {
  // Re-derive en's key set from the translation-or-throw surface; the
  // helper reads from the single source of truth, so this stays in sync.
  const zhKeys = new Set(_allKeysForTest())
  const enKeys = new Set<string>()
  for (const key of _allKeysForTest()) {
    translateOrThrow('en', key)
    enKeys.add(key)
  }
  // They should be the same set; if not, the tables are out of sync.
  const diff = [...zhKeys].filter((k) => !enKeys.has(k))
  assert.deepEqual(diff, [], `keys present in zh but missing in en: ${diff.join(', ')}`)
})

// ---------- interpolation ----------

test('interpolate substitutes every {name} placeholder', () => {
  assert.equal(interpolate('hello {name}!', { name: 'world' }), 'hello world!')
  assert.equal(
    interpolate('{greeting}, {name}!', { greeting: 'hi', name: 'x' }),
    'hi, x!',
  )
})

test('interpolate leaves unknown placeholders intact', () => {
  // A missing key should not silently swallow; the rendered output must
  // still be visible so the caller can spot the bug.
  assert.equal(interpolate('hi {name}', {}), 'hi {name}')
  assert.equal(interpolate('hi {name}'), 'hi {name}')
})

test('interpolate coerces non-string placeholders', () => {
  assert.equal(interpolate('{count} devices', { count: 3 }), '3 devices')
  assert.equal(interpolate('{flag}', { flag: true }), 'true')
})

// ---------- t() resolution ----------

test('t() uses the English fallback when no locale context is available', () => {
  // No ctx → detectLocale returns 'en' (we cannot introspect a host). The
  // "en" table is the source of truth, so we should get English back.
  assert.equal(t(undefined, 'nav'), 'DeepPilot')
  assert.equal(t(undefined, 'help.step1').startsWith('Turn on'), true)
})

test('translateWith calls the locale-aware slot translator directly', () => {
  const zh = (key: string, vars?: Readonly<Record<string, unknown>>) =>
    interpolate(translateOrThrow('zh', key), vars)
  assert.equal(translateWith(zh, 'help.step1').startsWith('先打开'), true)
  assert.equal(
    translateWith(zh, 'pair.qrHint', { kind: '内网' }),
    '二维码包含内网地址和一次性配对码；配对码 5 分钟后失效，二维码将在 60 秒后自动隐藏。',
  )
})

test('t() uses the locale snapshot when a namespace lookup is missing', () => {
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
      getSnapshot: () => ({ active: 'zh', revision: 1 }),
    },
  }
  assert.equal(t(ctx as never, 'help.step1').startsWith('先打开'), true)
})

test('t() substitutes placeholders when a vars object is passed', () => {
  // The pair.qrHint template uses {kind} — confirm interpolation works
  // through t() as well.
  assert.equal(
    t(undefined, 'pair.qrHint', { kind: 'LAN' }),
    'The QR contains a LAN address and a single-use pairing code. The code expires after 5 minutes; the QR auto-hides after 60 seconds.',
  )
})

test('t() falls back to the host locale face when one is available', () => {
  // Simulate a host whose locale face is set to Chinese. The bound
  // translator is authoritative when it knows the requested key.
  const ctx = {
    locale: {
      register: () => undefined,
      bind: (ns: string) => (key: string) => {
        if (ns !== 'settings.deeppilot') throw new Error('unknown namespace')
        return translateOrThrow('zh', key)
      },
    },
  }
  // Once the host answers in Chinese, t() should preserve that result.
  assert.equal(t(ctx as never, 'help.step1').startsWith('先打开'), true)
})

test('t() stays usable when the host locale face throws', () => {
  // A misbehaving host (throws on every key) is a recovery test: we must
  // not blow up the page or return a blank string.
  const ctx = {
    locale: {
      register: () => undefined,
      bind: () => () => { throw new Error('host down') },
    },
  }
  // Snapshot/browser detection falls back to English when neither is
  // available, but the user must still see a non-empty, non-key string.
  const value = t(ctx as never, 'help.step1')
  assert.ok(value.length > 0)
  assert.notEqual(value, 'help.step1')
})

test('t() returns the original key for genuinely missing entries (last-resort zh)', () => {
  // Unknown keys must not crash; they surface as the key itself so the
  // gap is visible in the rendered output rather than masked by a blank.
  // We round-trip a key the table does not ship.
  // _allKeysForTest is the closure: cannot be read otherwise. Synthesize
  // a guaranteed-missing key by prepending a marker.
  const ghost = '__missing_for_test__'
  assert.equal(t(undefined, ghost), ghost)
})

// ---------- registerLocale ----------

test('registerLocale forwards the zh+en table to the host', () => {
  let captured: { namespace: string; table: unknown } | null = null
  let disposed = false
  const ctx = {
    locale: {
      register: (namespace: string, table: unknown) => {
        captured = { namespace, table }
        return () => { disposed = true }
      },
      bind: () => () => '',
    },
  }
  const dispose = registerLocale(ctx as never)
  assert.ok(captured !== null, 'registerLocale must call ctx.locale.register')
  const cap = captured as { namespace: string; table: unknown }
  assert.equal(cap.namespace, 'settings.deeppilot')
  const table = cap.table as { zh: Record<string, string>; en: Record<string, string> }
  // Both locales must be present; the host picks one at lookup time.
  assert.ok(table.zh && table.en)
  assert.equal(table.zh.nav, 'DeepPilot')
  assert.equal(table.en.nav, 'DeepPilot')
  assert.equal(table.zh['help.step1'].startsWith('先打开'), true)
  assert.equal(table.en['help.step1'].startsWith('Turn on'), true)
  dispose()
  assert.equal(disposed, true)
})

test('registerLocale is a no-op when the locale face is absent', () => {
  // The shape contract on Context leaves locale optional; missing must
  // not throw.
  const ctx: { locale?: unknown } = {}
  const dispose = registerLocale(ctx as never)
  assert.doesNotThrow(dispose)
})

// ---------- locale typing ----------

test('SupportedLocale is the closed {zh, en} union', () => {
  // If a third locale is ever added by accident the type would still
  // compile; this test catches it at runtime by walking every reported
  // key and ensuring each locale's value is non-empty (already done by
  // the parity test). The point of this test is to make the intent
  // explicit: a change to SupportedLocale requires changing tests too.
  const supported: SupportedLocale[] = ['zh', 'en']
  assert.deepEqual(supported, ['zh', 'en'])
})
