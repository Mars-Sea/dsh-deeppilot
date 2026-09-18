import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { injectCss } from '../src/client/styles.ts'

/**
 * The client bundle identity, read from package.json rather than hard-coded:
 * DSH's module system attributes styles to the package id it loaded, which is
 * also the id tsdown.config.ts writes into the `__ModuleLoader__.load` banner.
 */
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string }

interface FakeStyleTag {
  attrs: Record<string, string>
  textContent: string
}

/** Minimal document face covering exactly what injectCss() touches. */
function withFakeDocument<T>(run: (tags: FakeStyleTag[]) => T): T {
  const tags: FakeStyleTag[] = []
  const doc = {
    querySelector(selector: string): FakeStyleTag | null {
      const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
      if (match === null) return null
      return tags.find((tag) => tag.attrs['data-plugin-css'] === match[1]) ?? null
    },
    createElement(): FakeStyleTag & { setAttribute(key: string, value: string): void } {
      const tag: FakeStyleTag = { attrs: {}, textContent: '' }
      return {
        ...tag,
        setAttribute(key: string, value: string): void {
          tag.attrs[key] = value
        },
        get textContent(): string { return tag.textContent },
        set textContent(value: string) { tag.textContent = value },
      }
    },
    head: { appendChild(element: FakeStyleTag): void { tags.push(element) } },
  }
  const globals = globalThis as { document?: unknown }
  const previous = globals.document
  globals.document = doc
  try {
    return run(tags)
  } finally {
    globals.document = previous
  }
}

test('injectCss stamps the bundle id so runtime unload can reclaim the sheet', () => {
  // DSH's ClientModuleSystem only auto-claims styles present during factory
  // materialization. This sheet is injected from apply(), which runs later, so
  // without an explicit data-plugin the module system's removeOwnedStyles()
  // cannot see it and disabling the plugin would leave it styling the page.
  const tags = withFakeDocument((tags) => {
    injectCss()
    return tags
  })
  assert.equal(tags.length, 1, 'exactly one stylesheet is appended')
  const tag = tags[0]!
  assert.equal(tag.attrs['data-plugin'], packageJson.name, 'owned by the loaded package id')
  assert.equal(tag.attrs['data-plugin-css'], 'dsh-deeppilot/page.css')
  assert.ok(tag.textContent.length > 0, 'the sheet carries the page CSS')
})

test('injectCss is idempotent across repeated activation', () => {
  // A plugin can be enabled, disabled and re-enabled at runtime; each apply()
  // must reuse the existing tag instead of stacking duplicate stylesheets.
  const tags = withFakeDocument((tags) => {
    injectCss()
    injectCss()
    injectCss()
    return tags
  })
  assert.equal(tags.length, 1, 'the stylesheet is injected once')
})

test('injectCss is inert without a document', () => {
  // The same module is imported by the host half during SSR-free unit runs.
  const globals = globalThis as { document?: unknown }
  const previous = globals.document
  delete globals.document
  try {
    assert.doesNotThrow(() => injectCss())
  } finally {
    globals.document = previous
  }
})
