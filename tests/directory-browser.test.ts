import assert from 'node:assert/strict'
import type { Dir, Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fullyQualified, listPhoneDirectory, PHONE_DIRECTORY_MAX_ENTRIES } from '../src/directory-browser.ts'

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'deeppilot-directory-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/deeppilot-directory-') ||
      resolve(root).startsWith(resolve(tmpdir()) + '\\deeppilot-directory-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function dirent(name: string, symbolic = false): Dirent {
  return { name, isDirectory: () => !symbolic, isSymbolicLink: () => symbolic } as Dirent
}

function fakeLevel(read: () => Promise<Dirent | null>, close: () => Promise<void>): Dir {
  return { read, close } as unknown as Dir
}

const unreadable = (error: unknown) => error instanceof Error &&
  'code' in error && error.code === 'directory-unreadable' && /cannot list/.test(error.message)

test('omitted path browses the real home without changing the listing contract', async () => {
  const listing = await listPhoneDirectory()
  assert.equal(listing.home, homedir())
  assert.equal(listing.path, resolve(homedir()))
  assert.ok(listing.entries.length <= PHONE_DIRECTORY_MAX_ENTRIES)
  assert.equal(listing.crumbs.at(-1)?.path, listing.path)
})

test('real directory rows sort by localeCompare, exclude files and flag dot names', async t => {
  const root = await fixture(t)
  const names = ['zulu', 'Beta', '.hidden', 'alpha', '中国', 'Éclair']
  await Promise.all(names.map(name => fs.mkdir(join(root, name))))
  await fs.writeFile(join(root, 'ordinary.txt'), 'file')
  await fs.writeFile(join(root, '.hidden-file'), 'file')
  const listing = await listPhoneDirectory(root)
  assert.deepEqual(listing.entries, names.sort((a, b) => a.localeCompare(b)).map(name => ({
    name, path: join(root, name), hidden: name.startsWith('.'),
  })))
  assert.equal(listing.truncated, false)
  assert.equal(listing.home, homedir())
})

test('crumbs run from root to the normalized target with enterable lexical paths', async t => {
  const root = await fixture(t)
  const child = join(root, '.nested', 'child')
  await fs.mkdir(child, { recursive: true })
  const listing = await listPhoneDirectory(join(child, '..', 'child'))
  assert.equal(listing.path, child)
  assert.deepEqual(listing.crumbs[0], { name: parse(child).root, path: parse(child).root, hidden: false })
  assert.deepEqual(listing.crumbs.at(-1), { name: 'child', path: child, hidden: false })
  for (let i = 1; i < listing.crumbs.length; i++) {
    assert.equal(dirname(listing.crumbs[i].path), listing.crumbs[i - 1].path)
    assert.equal(listing.crumbs[i].name, basename(listing.crumbs[i].path))
  }
  assert.ok(listing.crumbs.every(crumb => !crumb.hidden))
  assert.deepEqual((await listPhoneDirectory(parse(child).root)).crumbs,
    [{ name: parse(child).root, path: parse(child).root, hidden: false }])
})

test('directory symlinks can be entered while file, broken and cyclic links disappear', async t => {
  const root = await fixture(t)
  await fs.mkdir(join(root, 'target', 'child'), { recursive: true })
  await fs.writeFile(join(root, 'file'), 'file')
  await fs.symlink(join(root, 'target'), join(root, 'alias'), 'dir')
  await fs.symlink(join(root, 'file'), join(root, 'file-link'), 'file')
  await fs.symlink(join(root, 'missing'), join(root, 'broken'), 'dir')
  await fs.symlink(join(root, 'cycle-b'), join(root, 'cycle-a'), 'dir')
  await fs.symlink(join(root, 'cycle-a'), join(root, 'cycle-b'), 'dir')
  const listing = await listPhoneDirectory(root)
  assert.deepEqual(listing.entries.map(row => row.name), ['alias', 'target'])
  const linked = await listPhoneDirectory(join(root, 'alias'))
  assert.equal(linked.path, join(root, 'alias'))
  assert.deepEqual(linked.entries, [{ name: 'child', path: join(root, 'alias', 'child'), hidden: false }])
  assert.equal(linked.crumbs.at(-1)?.path, join(root, 'alias'))
})

test('1001 real child directories produce a sorted 1000-row head and truncated flag', async t => {
  const root = await fixture(t)
  const names = Array.from({ length: PHONE_DIRECTORY_MAX_ENTRIES + 1 }, (_, i) => `entry-${String(i).padStart(4, '0')}`)
  // Deliberately create in reverse order: filesystem order is not our wire order.
  for (const name of [...names].reverse()) await fs.mkdir(join(root, name))
  const listing = await listPhoneDirectory(root)
  assert.equal(listing.entries.length, 1000)
  assert.equal(listing.truncated, true)
  assert.deepEqual(listing.entries.map(row => row.name), names.slice(0, 1000))
  await fs.rmdir(join(root, names.at(-1)!))
  assert.equal((await listPhoneDirectory(root)).truncated, false)
})

test('bounded scan preserves stable ties and reports eviction even when broken links occupy the window', async t => {
  const names = ['é', 'e\u0301']
  assert.equal(names[0].localeCompare(names[1]), 0)
  const candidates = [...names, ...Array.from({ length: 1100 }, (_, i) => `z-${i}`)]
  let index = 0
  let closed = false
  const level = fakeLevel(async () => index < candidates.length ? dirent(candidates[index++]) : null,
    async () => { closed = true })
  const open = t.mock.method(fs, 'opendir', async () => level)
  const listing = await listPhoneDirectory(resolve('/bounded'))
  assert.equal(closed, true)
  assert.deepEqual(listing.entries.slice(0, 2).map(row => row.name), names)
  assert.deepEqual(listing.entries.map(row => row.name), candidates.slice().sort((a, b) => a.localeCompare(b)).slice(0, 1000))
  assert.equal(listing.truncated, true)

  open.mock.restore()
  index = 0
  const links = Array.from({ length: 1002 }, (_, i) => `a-${String(i).padStart(4, '0')}`)
  t.mock.method(fs, 'opendir', async () => fakeLevel(async () => index < links.length ? dirent(links[index++], true) : null, async () => {}))
  const stat = t.mock.method(fs, 'stat', async () => { throw new Error('broken link') })
  const broken = await listPhoneDirectory(resolve('/bounded'))
  assert.deepEqual(broken.entries, [])
  assert.equal(broken.truncated, true)
  assert.equal(stat.mock.callCount(), 1001)
})

test('invalid, empty, missing and file paths return a local directory-unreadable Error', async t => {
  const root = await fixture(t)
  await fs.writeFile(join(root, 'file'), '')
  for (const path of ['', '.', 'relative/child', join(root, 'missing'), join(root, 'file'), root + '\0']) {
    await assert.rejects(listPhoneDirectory(path), unreadable)
  }
})

test('fullyQualified handles POSIX paths without rebasing relative forms', () => {
  for (const path of ['/', '/home/user', '//server/share']) assert.equal(fullyQualified(path, 'linux'), true, path)
  for (const path of ['', '.', '../child', '~', 'C:\\child', '\\child']) assert.equal(fullyQualified(path, 'linux'), false, path)
})

test('fullyQualified requires a Windows drive or a complete UNC share', () => {
  for (const path of ['C:\\', 'c:/child', 'D:\\folder\\child', '\\\\server\\share', '\\\\server\\share\\child', '//server/share/child']) {
    assert.equal(fullyQualified(path, 'win32'), true, path)
  }
  for (const path of ['', '.', 'C:', 'C:child', '\\', '/', '/child', '\\child', '\\\\', '\\\\server', '\\\\server\\', '//server/']) {
    assert.equal(fullyQualified(path, 'win32'), false, path)
  }
})

test('already-aborted calls do not start I/O, including for an empty directory', async t => {
  const open = t.mock.method(fs, 'opendir', async () => { throw new Error('must not open') })
  const controller = new AbortController()
  const reason = new Error('already departed')
  controller.abort(reason)
  await assert.rejects(listPhoneDirectory(undefined, controller.signal), error => error === reason)
  assert.equal(open.mock.callCount(), 0)
})

test('abort during a blocked open returns promptly and closes the late real handle', { timeout: 2000 }, async t => {
  const root = await fixture(t)
  const level = await fs.opendir(root)
  const opening = deferred<Dir>()
  const close = t.mock.method(level, 'close')
  t.mock.method(fs, 'opendir', () => opening.promise)
  const controller = new AbortController()
  const reason = new Error('open aborted')
  const pending = listPhoneDirectory(root, controller.signal)
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  opening.resolve(level)
  await new Promise<void>(done => setImmediate(done))
  assert.equal(close.mock.callCount(), 1)
  await assert.rejects(level.read(), { code: 'ERR_DIR_CLOSED' })
})

test('abort during read returns before queued close finishes and observes late read rejection', { timeout: 2000 }, async t => {
  const reading = deferred<Dirent | null>()
  const closing = deferred<void>()
  const entered = deferred<void>()
  let closed = false
  t.mock.method(fs, 'opendir', async () => fakeLevel(() => { entered.resolve(); return reading.promise }, async () => {
    await closing.promise
    closed = true
  }))
  const controller = new AbortController()
  const reason = new Error('read aborted')
  const pending = listPhoneDirectory(resolve('/blocked'), controller.signal)
  await entered.promise
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(closed, false)
  reading.reject(new Error('abandoned read failed'))
  closing.resolve()
  await new Promise<void>(done => setImmediate(done))
  assert.equal(closed, true)
})

test('abort during normal close also returns promptly and observes a late close failure', { timeout: 2000 }, async t => {
  const closing = deferred<void>()
  const entered = deferred<void>()
  t.mock.method(fs, 'opendir', async () => fakeLevel(async () => null, () => {
    entered.resolve()
    return closing.promise
  }))
  const controller = new AbortController()
  const reason = new Error('close aborted')
  const pending = listPhoneDirectory(resolve('/blocked'), controller.signal)
  await entered.promise
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  closing.reject(new Error('late close failed'))
  await new Promise<void>(done => setImmediate(done))
})

test('abort during symlink stat returns promptly after closing the scan handle', { timeout: 2000 }, async t => {
  const probing = deferred<never>()
  const entered = deferred<void>()
  let index = 0
  let closed = false
  t.mock.method(fs, 'opendir', async () => fakeLevel(async () => index++ === 0 ? dirent('link', true) : null,
    async () => { closed = true }))
  t.mock.method(fs, 'stat', () => { entered.resolve(); return probing.promise })
  const controller = new AbortController()
  const reason = new Error('stat aborted')
  const pending = listPhoneDirectory(resolve('/blocked'), controller.signal)
  await entered.promise
  assert.equal(closed, true)
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  probing.reject(new Error('late stat failed'))
  await new Promise<void>(done => setImmediate(done))
})

test('read errors close the handle and normal close errors become directory-unreadable', async t => {
  let closed = false
  const open = t.mock.method(fs, 'opendir', async () => fakeLevel(async () => { throw new Error('scan failed') }, async () => { closed = true }))
  await assert.rejects(listPhoneDirectory(resolve('/error')), unreadable)
  assert.equal(closed, true)
  open.mock.restore()
  t.mock.method(fs, 'opendir', async () => fakeLevel(async () => null, async () => { throw new Error('close failed') }))
  await assert.rejects(listPhoneDirectory(resolve('/error')), error => unreadable(error) && /close failed/.test((error as Error).message))
})
