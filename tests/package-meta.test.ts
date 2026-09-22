import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

/** package.json fields this test guards for Plugin Manager display metadata. */
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  icon?: unknown
  exports?: Record<string, unknown>
  files?: string[]
}

/** Mirrors the host's iconOf() rules (app-boot package-meta.ts): relative
 *  path, SVG/PNG/JPEG/WebP only, at most 256 KiB, inside the package. */
const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_ICON_BYTES = 256 * 1024

/** locale/<lang>.json must carry non-empty meta.title and meta.description. */
interface LocaleMeta {
  meta?: { title?: unknown; description?: unknown }
}

test('declares a relative, whitelisted, packaged plugin icon', async () => {
  const icon = packageJson.icon
  assert.equal(typeof icon, 'string', 'package.json icon declaration present')
  const iconPath = icon as string
  assert.ok(iconPath.length > 0, 'icon path is non-empty')
  assert.ok(!iconPath.startsWith('/'), 'icon must be a relative file path')
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(iconPath), 'icon must not be a URL or scheme')
  const dot = iconPath.lastIndexOf('.')
  assert.ok(dot > 0, 'icon carries an extension')
  const ext = iconPath.slice(dot).toLowerCase()
  assert.ok(ICON_EXTENSIONS.includes(ext), `icon extension ${ext} is whitelisted`)

  // The reader resolves the icon through the package.json export.
  assert.ok(
    packageJson.exports?.['./package.json'] !== undefined,
    'exports expose ./package.json for icon reading',
  )
  // The image must be published for the installed package to carry it.
  const filesName = iconPath.replace(/^\.\//, '')
  assert.ok(
    packageJson.files?.includes(filesName) === true,
    `files lists ${filesName}`,
  )

  const info = await stat(new URL(`../${filesName}`, import.meta.url))
  assert.ok(info.isFile(), 'icon file exists in the repository')
  assert.ok(info.size <= MAX_ICON_BYTES, `icon is within ${MAX_ICON_BYTES} bytes`)
})

test('exposes and ships localized Plugin Manager metadata', async () => {
  assert.ok(
    packageJson.exports?.['./locale/*.json'] !== undefined,
    'exports expose ./locale/*.json',
  )
  assert.ok(
    packageJson.files?.includes('locale/*.json') === true,
    'files lists locale/*.json',
  )

  const tables: Array<[string, LocaleMeta]> = []
  for (const lang of ['en', 'zh']) {
    // en.json is the host's discovery entry; every sibling must parse.
    const raw = await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')
    const table = JSON.parse(raw) as LocaleMeta
    assert.equal(typeof table.meta?.title, 'string', `${lang} meta.title present`)
    assert.ok(
      typeof table.meta?.title === 'string' && table.meta.title.trim().length > 0,
      `${lang} meta.title non-empty`,
    )
    assert.equal(typeof table.meta?.description, 'string', `${lang} meta.description present`)
    assert.ok(
      typeof table.meta?.description === 'string' && table.meta.description.trim().length > 0,
      `${lang} meta.description non-empty`,
    )
    tables.push([lang, table])
  }

  // Language files must declare the same fields so the host never falls back
  // to the package name for one language but not another.
  const [en, zh] = tables as [string, LocaleMeta][]
  assert.deepEqual(
    Object.keys(zh[1].meta ?? {}).sort(),
    Object.keys(en[1].meta ?? {}).sort(),
    'locale files declare identical meta keys',
  )
})
