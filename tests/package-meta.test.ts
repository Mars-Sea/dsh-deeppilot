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

/**
 * DSH 0.2.2 的插件详情页按语言链读取 `locale/<lang>.json` 的 `meta.detail`，
 * 找不到才退回包根 README。这里指向 `docs/DETAIL*.md`，插件页因此显示面向用户的
 * 详情文档，而不是整份 README。
 * 宿主规则（`@deepseek-ai/dsh-plugin-detail` 的 `detailPath`）：以 `/` 分隔、
 * 相对包根、以 `.md`/`.markdown` 结尾，无空段、`.`、`..`、反斜杠或 URL scheme；
 * 写错或文件不存在时宿主报 `invalid`，且**不会**退回 README，所以这里严格对齐。
 * 文档必须位于包的子目录中：根目录文档旁边的图片不会被发布。
 * 旧宿主不认识 `meta.detail`，只按字段名取 title/description，多出的键被忽略。
 */
test('locale meta.detail names a packaged Markdown document per language', async () => {
  const expected: Record<string, string> = { en: 'docs/DETAIL.md', zh: 'docs/DETAIL.zh.md' }
  for (const [lang, doc] of Object.entries(expected)) {
    const raw = await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')
    const detail = (JSON.parse(raw) as { meta?: { detail?: unknown } }).meta?.detail
    assert.equal(detail, doc, `${lang} meta.detail points at ${doc}`)
    const path = detail as string
    assert.ok(/\.(md|markdown)$/i.test(path), `${lang} detail is Markdown`)
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.includes('\\'), `${lang} detail has no scheme or backslash`)
    assert.ok(
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      `${lang} detail stays inside the package root`,
    )
    assert.ok(path.includes('/'), `${lang} detail sits in a subdirectory, so its images are published`)
    assert.ok(packageJson.files?.includes(path) === true, `files lists ${path}`)
    assert.ok((await stat(new URL(`../${path}`, import.meta.url))).isFile(), `${path} exists`)
  }
})

/**
 * 详情文档只放一张功能配图，路径相对文档自身（宿主按 `detailImage` 解析）。
 * 图片必须随包发布，否则插件页会显示破图；这里同时守住"每份文档恰好一张图"，
 * 因为详情页是单图版式，不是画廊。
 */
test('each detail document references one packaged feature image', async () => {
  for (const doc of ['docs/DETAIL.md', 'docs/DETAIL.zh.md']) {
    const markdown = await readFile(new URL(`../${doc}`, import.meta.url), 'utf8')
    const images = [...markdown.matchAll(/^!\[([^\]]*)\]\(([^)\s]+)\)$/gmu)]
    assert.equal(images.length, 1, `${doc} carries exactly one image line`)
    const [, alt, destination] = images[0] as RegExpMatchArray
    assert.ok((alt ?? '').trim().length > 0, `${doc} image has alternative text`)
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(destination as string), `${doc} image path is relative`)
    const imagePath = `${doc.slice(0, doc.lastIndexOf('/'))}/${destination as string}`
    assert.ok(packageJson.files?.includes(imagePath) === true, `files lists ${imagePath}`)
    const info = await stat(new URL(`../${imagePath}`, import.meta.url))
    assert.ok(info.isFile(), `${imagePath} exists`)
    assert.ok(info.size <= 1024 * 1024, `${imagePath} stays within 1 MiB`)
  }
})
