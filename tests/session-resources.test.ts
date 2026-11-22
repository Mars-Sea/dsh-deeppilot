import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { DshSessionResources, insideFileRoot, workspaceRelative } from '../src/session-resources.ts'
import { projectEvent, projectHistory } from '../src/host-event-projection.ts'
import { projectQueue } from '../src/prompt-queue.ts'
import { registryRowFor } from '../src/wire-registry.ts'

function fixture() {
  const bytes = Buffer.from('hello\n世界\n'), events: any[] = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
    { seq: 3, type: 'deliverables/presented', data: { turn: 1, files: [{ path: '/outside/result.txt', description: 'ready' }] } },
    { seq: 4, type: 'workspace/changes', data: { turn: 1 } },
    { seq: 5, type: 'workspace/changes', data: { turn: 1 } },
  ]
  let reads = 0, version = 'v1', enabled = true, expired = false, mutate = false
  const services: any = {
    sessions: { get: (id: string) => id === 's' ? { header: { cwd: '/project' } } : undefined },
    fs: { resolve: async (path: string, options: any) => path === 'escape.txt' ? '/outside/secret' : path.startsWith('/') ? path : options.cwd + '/' + path,
      fileUrl: (path: string) => 'file://' + path, processPath: (path: string) => path },
    sessionQuery: { readEvent: async ({ sessionId, seq }: any) => sessionId === 's' ? { session: { cwd: '/project' }, target: events.find(e => e.seq === seq) } : undefined },
    workspaceFiles: {
      stat: async () => ({ bytes: bytes.length, version }),
      read: async (_: any, path: string, range: any) => { reads++; const value = { text: 'hello\n世界', offset: range.offset, lines: 2, eof: true, version }; if (mutate) version = 'v2'; return value },
      readBytes: async (_: any, path: string, { range }: any) => { reads++; assert.equal(path, '/outside/result.txt'); return { data: bytes.subarray(range.offset, range.offset + range.length), offset: range.offset, eof: true, version } },
      list: async (_: any, targetPath: string) => {
        assert.ok(targetPath.trim().length > 0, 'WorkspaceFiles.inspect requires a non-empty path')
        const rel = targetPath === '.' ? '' : targetPath.replace(/^\.\//, '')
        return { path: rel, entries: [{ name: 'src', type: 'directory' }, { name: '.env', type: 'file' }], truncated: true }
      },
      search: async () => ({ matches: [{ path: 'src/中文.swift', type: 'file' }], truncated: false, incomplete: true }),
    },
    workspaceChanges: { summary: () => expired ? undefined : ({ files: [{ display: 'a.ts', added: 2, deleted: 1 }], total: 1, added: 2, deleted: 1 }),
      diff: async () => expired ? undefined : ({ kind: 'text', display: 'a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' old', '+new'] }] }) },
  }
  const api = new DshSessionResources({ get: (key: string) => services[key] } as never, async () => ({ events: events.map(event => ({ event })), hasMore: false }), () => enabled)
  return { api, reads: () => reads, bytes, services, disable: () => { enabled = false }, expire: () => { expired = true }, mutate: () => { mutate = true } }
}
test('metadata listing does not read file contents, chooses latest turn changes and anchors the answer', async () => {
  const f = fixture()
  const page = await f.api.list('s', undefined, 60, new AbortController().signal)
  assert.deepEqual(page.items.map(i => [i.kind, i.sourceSeq, i.anchorSeq]), [['deliverables', 3, 2], ['changes', 5, 2]])
  assert.equal(page.items[0].files?.[0].name, 'result.txt')
  assert.equal(f.reads(), 0)
  f.expire()
  assert.equal((await f.api.list('s', undefined, 60, new AbortController().signal)).items[1].available, false)
  f.api.dispose()
})
test('manual download verifies event ownership, immutable snapshot hash, connection ownership and cancellation', async () => {
  const f = fixture(), connection = new AbortController(), other = new AbortController()
  const ref = { kind: 'deliverable' as const, sourceSeq: 3, fileIndex: 0 }
  await assert.rejects(f.api.open('d', 'other', ref, connection.signal))
  await assert.rejects(f.api.open('d', 's', { ...ref, sourceSeq: 2 }, connection.signal))
  const manifest = await f.api.open('d', 's', ref, connection.signal)
  assert.equal(manifest.sha256, createHash('sha256').update(f.bytes).digest('hex'))
  assert.throws(() => f.api.read('other', 's', manifest.transferId, 0, connection.signal))
  assert.throws(() => f.api.read('d', 's', manifest.transferId, 0, other.signal))
  assert.deepEqual(f.api.read('d', 's', manifest.transferId, 0, connection.signal).data, f.bytes)
  await assert.rejects(f.api.open('d', 's', ref, connection.signal))
  connection.abort()
  assert.throws(() => f.api.read('d', 's', manifest.transferId, 0, connection.signal))
  const next = await f.api.open('d', 's', ref, other.signal)
  f.api.close('d', 's', next.transferId)
  assert.throws(() => f.api.read('d', 's', next.transferId, 0, other.signal))
  f.api.dispose()
})
test('browser roots bind device, session and canonical target; revocation blocks further reads', async () => {
  const f = fixture(), signal = new AbortController().signal
  const directory = await f.api.directory('d', 's', undefined, '', undefined, false, signal)
  assert.equal(directory.path, '')
  assert.equal(directory.entries.length, 1)
  assert.equal(directory.entries[0].path, 'src')
  assert.equal(directory.truncated, true)
  const subdir = await f.api.directory('d', 's', directory.rootRef, 'src/views', '   ', false, signal)
  assert.equal(subdir.path, 'src/views')
  assert.equal(subdir.entries[0].path, 'src/views/src')
  const ref = { kind: 'workspace' as const, rootRef: directory.rootRef, path: 'a.txt' }
  await assert.rejects(f.api.stat('other', 's', ref, signal))
  await assert.rejects(f.api.stat('d', 's', { ...ref, path: '../secret' }, signal))
  await assert.rejects(f.api.stat('d', 's', { ...ref, path: 'escape.txt' }, signal))
  const search = await f.api.directory('d', 's', directory.rootRef, '', '中文', false, signal)
  assert.equal(search.entries[0].kind, 'file'); assert.equal(search.incomplete, true)
  f.disable(); await assert.rejects(f.api.text('d', 's', ref, 1, undefined, signal))
  assert.equal(f.reads(), 0); f.api.dispose()
})
test('the Host scope follows directory changes and cold sessions while old file references expire', async () => {
  const f = fixture(), signal = new AbortController().signal
  let activeRoot = '/project'
  const hostScopes: string[] = []
  f.services.workspaceFiles.scopeOf = async (sessionId: string, scopeSignal: AbortSignal) => {
    assert.equal(scopeSignal, signal)
    hostScopes.push(sessionId)
    if (sessionId === 's') return { sessionId, workspaceRoot: activeRoot }
    if (sessionId === 'cold') return { sessionId, workspaceRoot: '/cold-worktree' }
  }
  f.services.sessionPersistence = { stat: async (id: string) => id === 'cold' || id === 'gone'
    ? { header: { cwd: '/project' } }
    : id === 'worker' ? { header: { cwd: '/project', origin: 'subagent' } } : undefined }
  const root = (sessionId: string, rootRef?: string) => f.api.directory('d', sessionId, rootRef, '', undefined, false, signal)
  const old = await root('s')
  activeRoot = '/worktree'
  await assert.rejects(root('s', old.rootRef), { code: 'E_BUSY' })
  await assert.rejects(f.api.stat('d', 's', { kind: 'workspace', rootRef: old.rootRef, path: 'same.txt' }, signal), { code: 'E_BUSY' })
  const moved = await root('s')
  assert.equal(moved.rootLabel, '/worktree')
  assert.notEqual(moved.rootRef, old.rootRef)
  f.services.workspaceFiles.stat = async (scope: { workspaceRoot: string }, path: string) => {
    if (path === '/outside/result.txt') assert.equal(scope.workspaceRoot, '/project')
    else {
      assert.equal(scope.workspaceRoot, '/worktree')
      assert.equal(path, '/worktree/same.txt')
    }
    return { version: 'v1' }
  }
  await f.api.stat('d', 's', { kind: 'workspace', rootRef: moved.rootRef, path: 'same.txt' }, signal)
  await f.api.stat('d', 's', { kind: 'deliverable', sourceSeq: 3, fileIndex: 0 }, signal)
  assert.equal((await root('cold')).rootLabel, '/cold-worktree')
  await assert.rejects(root('gone'), { code: 'E_NOT_FOUND' })
  await assert.rejects(root('worker'), { code: 'E_NOT_FOUND' })
  assert.ok(!hostScopes.includes('worker'))
  f.api.dispose()
})
test('text rejects a source changed during reading and diffs preserve line numbers and expiry', async () => {
  const f = fixture(), signal = new AbortController().signal
  f.mutate(); await assert.rejects(f.api.text('d', 's', { kind: 'deliverable', sourceSeq: 3, fileIndex: 0 }, 1, 'v1', signal))
  const diff = await f.api.diff('s', 5, 0, 0, signal)
  assert.deepEqual(diff.lines.slice(1).map(l => [l.kind, l.old, l.new]), [['context', 1, 1], ['added', undefined, 2]])
  f.expire(); assert.equal((await f.api.diff('s', 5, 0, 0, signal)).kind, 'expired'); f.api.dispose()
})
test('provider URL containment and request guards reject traversal and forged file refs', () => {
  assert.equal(insideFileRoot('file:///project', 'file:///project-other/key'), false)
  assert.equal(insideFileRoot('file:///C:/Project', 'file:///c:/project/a.txt'), true)
  assert.equal(insideFileRoot('file://host/project', 'file://other/project/a'), false)
  for (const path of ['../a', '/a', 'C:\\a', 'a/../b', 'a\\b', 'a\0b']) assert.equal(workspaceRelative(path), false)
  const row = registryRowFor('c2s.file.open')!
  assert.equal(row.validate!({ sessionId: 's', ref: { kind: 'path', path: '/secret' } }).ok, false)
  assert.equal(row.validate!({ sessionId: 's', ref: { kind: 'deliverable', sourceSeq: 1, fileIndex: -1 } }).ok, false)
})

test('native empty retry remains absent from bubbles and ordinary prompt queue', () => {
  const message = { id: 'retry', role: 'user', content: [], source: { kind: 'retry', rpcId: 'dp:operation' } }
  const event = { seq: 8, type: 'user/message', data: { turn: 2, message } }
  assert.equal(projectEvent('s', event), null)
  assert.deepEqual(projectHistory([{ event }]), [])
  assert.deepEqual(projectQueue({ 'next-turn': [message], 'next-step': [] }), [])
})
test('close cancels a preparing snapshot before any manifest exists', async () => {
  const f = fixture(), connection = new AbortController(), transferId = '11111111-1111-1111-1111-111111111111'
  let reading!: () => void
  const started = new Promise<void>(resolve => { reading = resolve })
  f.services.workspaceFiles.readBytes = async (_: unknown, _path: string, _range: unknown, signal: AbortSignal) => {
    reading()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  const opening = f.api.open('d', 's', { kind: 'deliverable', sourceSeq: 3, fileIndex: 0 }, connection.signal, transferId)
  await started
  f.api.close('d', 's', transferId)
  await assert.rejects(opening)
  assert.throws(() => f.api.read('d', 's', transferId, 0, connection.signal))
  f.api.dispose()
})
