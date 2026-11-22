import { projectEvent } from './host-event-projection.ts'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HistoryResult, SessionEventLike } from './host-api.ts'
import { ControlRejection } from './session-controls.ts'
import type { RemoteFileRef, SessionResource, SessionResourcesPage, RemoteDirectory, RemoteFileInfo, RemoteTextPage, RemoteFileManifest, RemoteDiffPage, RemoteDiffLine } from './resource-models.ts'

type Row = Record<string, any>
const record = (v: unknown): Row | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : undefined
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const leaf = (path: string): string => path.replace(/\\/g, '/').split('/').at(-1) || 'file'
function failure(code: 'E_BUSY' | 'E_FORBIDDEN' | 'E_NOT_FOUND' | 'E_PROTOCOL' | 'E_UNSUPPORTED', text: string): never { throw new ControlRejection(code, text) }
const MAX_FILE_BYTES = 32 * 1024 * 1024
const FILE_CHUNK_BYTES = 256 * 1024
interface Scope { sessionId: string; workspaceRoot: string }
interface Transfer { deviceId: string; sessionId: string; signal: AbortSignal; data: Buffer; manifest: RemoteFileManifest; touched: number; workspace: boolean; abort: () => void; timer: ReturnType<typeof setTimeout> }

/** Compare canonical provider file URLs, never an untrusted string path prefix. */
export function insideFileRoot(root: string, target: string): boolean {
  const a = new URL(root), b = new URL(target)
  const windows = /^\/[a-z]:\//i.test(a.pathname)
  const canonical = (v: string) => (windows ? v.toLowerCase() : v).replace(/\/+$/, '')
  const base = canonical(a.pathname), path = canonical(b.pathname)
  return a.protocol === 'file:' && b.protocol === a.protocol && b.host === a.host && (path === base || path.startsWith(base + '/'))
}
export function workspaceRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 4096 && !path.includes('\0') && !path.includes('\\') &&
    !posix.isAbsolute(path) && !win32.isAbsolute(path) && !path.split('/').some(p => p === '..' || p === '.')
}
function mediaType(path: string): string {
  const leafName = leaf(path).toLowerCase()
  const ext = leafName.includes('.') ? leafName.split('.').at(-1) ?? '' : ''
  if (['makefile', 'dockerfile', 'license', 'readme', 'gemfile', 'podfile', 'procfile'].includes(leafName)) return 'text/plain'
  const type: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', md: 'text/plain', markdown: 'text/plain', csv: 'text/csv',
    json: 'application/json', jsonl: 'text/plain', html: 'text/plain', htm: 'text/plain', svg: 'text/plain',
    swift: 'text/plain', ts: 'text/plain', tsx: 'text/plain', js: 'text/plain', jsx: 'text/plain', mjs: 'text/plain',
    cjs: 'text/plain', mts: 'text/plain', cts: 'text/plain', py: 'text/plain', rs: 'text/plain', go: 'text/plain',
    java: 'text/plain', kt: 'text/plain', c: 'text/plain', h: 'text/plain', cpp: 'text/plain', sh: 'text/plain',
    zsh: 'text/plain', bash: 'text/plain', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain', xml: 'text/plain',
    css: 'text/plain', scss: 'text/plain', less: 'text/plain', sql: 'text/plain', log: 'text/plain',
    strings: 'text/plain', xcstrings: 'text/plain', plist: 'text/plain', xcconfig: 'text/plain', entitlements: 'text/plain',
    gitignore: 'text/plain', editorconfig: 'text/plain', env: 'text/plain', lock: 'text/plain', zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
  return type[ext] ?? 'application/octet-stream'
}

/** Owns verified resource references and bounded one-operation file snapshots. No persistent cache. */
export class DshSessionResources {
  private readonly secret = randomBytes(32)
  private readonly transfers = new Map<string, Transfer>()
  private readonly preparing = new Map<string, { sessionId: string; transferId: string; cancel: AbortController }>()
  private disposed = false
  constructor(private readonly ctx: Context, private readonly history: (sessionId: string, beforeSeq?: number, limit?: number) => Promise<HistoryResult>,
    private readonly browseEnabled: () => boolean = () => false) {}
  private service(name: string): Row | undefined { return this.ctx.get(name) as Row | undefined }
  get filesAvailable(): boolean { return ['stat', 'read', 'readBytes'].every(k => typeof this.service('workspaceFiles')?.[k] === 'function') &&
    ['resolve', 'fileUrl', 'processPath'].every(k => typeof this.service('fs')?.[k] === 'function') && typeof this.service('sessionQuery')?.readEvent === 'function' }
  get workspaceAvailable(): boolean { return this.filesAvailable && ['list', 'search'].every(k => typeof this.service('workspaceFiles')?.[k] === 'function') }
  get changesAvailable(): boolean { return ['summary', 'diff'].every(k => typeof this.service('workspaceChanges')?.[k] === 'function') && typeof this.service('sessionQuery')?.readEvent === 'function' }

  private assertBrowse(): void { if (!this.browseEnabled()) failure('E_FORBIDDEN', '请先在电脑端开启“允许手机浏览项目文件”') }
  private async scope(sessionId: string, signal: AbortSignal): Promise<Scope> {
    signal.throwIfAborted()
    const live = this.service('sessions')?.get?.(sessionId)?.header
    const stored = live === undefined ? await this.service('sessionPersistence')?.stat?.(sessionId) : undefined
    signal.throwIfAborted()
    const header = live ?? stored?.header
    if (!header || header.origin === 'subagent') failure('E_NOT_FOUND', '项目会话已不存在')
    // New hosts resolve active worktrees and cached directories for cold sessions.
    const files = this.service('workspaceFiles')
    if (typeof files?.scopeOf === 'function') {
      const scope = await files.scopeOf(sessionId, signal)
      signal.throwIfAborted()
      if (!scope) failure('E_NOT_FOUND', '项目会话已不存在')
      if (typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot) failure('E_UNSUPPORTED', '主机未提供项目目录')
      return { sessionId, workspaceRoot: scope.workspaceRoot }
    }
    const root = header.cwd ?? this.service('sandboxPolicy')?.workspaceRoot
    if (typeof root !== 'string' || !root) failure('E_UNSUPPORTED', '主机未提供项目目录')
    return { sessionId, workspaceRoot: root }
  }
  private async root(scope: Scope, deviceId: string, signal: AbortSignal): Promise<{ rootRef: string; url: string }> {
    const fs = this.service('fs')!
    const target = await fs.resolve(scope.workspaceRoot, { signal })
    const url = fs.fileUrl(target) as string
    return { rootRef: createHmac('sha256', this.secret).update(JSON.stringify([deviceId, scope.sessionId, url])).digest('base64url'), url }
  }
  private async event(sessionId: string, sourceSeq: number, kind: string, signal: AbortSignal): Promise<Row> {
    const read = await this.service('sessionQuery')?.readEvent?.({ sessionId, seq: sourceSeq, before: 0, after: 0 }, signal)
    signal.throwIfAborted()
    if (!read || read.session?.origin === 'subagent' || read.target?.type !== kind || read.target.seq !== sourceSeq) failure('E_NOT_FOUND', '此会话中的文件记录已不存在')
    return read
  }

  async list(sessionId: string, beforeSeq: number | undefined, limit: number, signal: AbortSignal): Promise<SessionResourcesPage> {
    const history = await this.history(sessionId, beforeSeq, limit)
    signal.throwIfAborted()
    const events = history.events.map(e => e.event)
    const anchors = new Map<number, number>()
    let turn: number | undefined
    for (const e of events) {
      const data = record(e.data)
      if (e.type === 'turn/start' && number(data?.turn)) turn = data!.turn
      const owner = number(data?.turn) ? data!.turn : turn
      if (owner !== undefined && ['user/message', 'assistant/message'].includes(e.type)) {
        const projected = projectEvent(sessionId, e)
        if (projected?.kind === 'message.final' && projected.data.role !== 'system') anchors.set(owner, e.seq)
      }
      if (owner !== undefined && e.type === 'turn/end' && data?.reason?.kind === 'error') anchors.set(owner, e.seq)
    }
    const latestChanges = new Map<number, SessionEventLike>()
    for (const e of events) if (e.type === 'workspace/changes' && number(record(e.data)?.turn)) latestChanges.set(record(e.data)!.turn, e)
    const items: SessionResource[] = []
    let budget = 0, cut: number | undefined
    for (const e of [...events].reverse()) {
      const data = record(e.data)
      if (!data || !number(data.turn) || !number(e.seq)) continue
      let item: SessionResource
      if (e.type === 'deliverables/presented' && this.filesAvailable && Array.isArray(data.files)) {
        item = { kind: 'deliverables', sourceSeq: e.seq, turn: data.turn, anchorSeq: anchors.get(data.turn) ?? e.seq,
          files: data.files.slice(0, 32).flatMap((f: unknown, index: number) => {
            const file = record(f)
            return typeof file?.path === 'string' && file.path.length <= 4096 ? [{ index, name: leaf(file.path),
              ...(typeof file.description === 'string' ? { description: file.description.slice(0, 1024) } : {}) }] : []
          }), truncated: data.files.length > 32 }
      } else if (e.type === 'workspace/changes' && this.changesAvailable && latestChanges.get(data.turn) === e) {
        const summary = this.service('workspaceChanges')?.summary?.(sessionId, e.seq)
        if (summary && (!Array.isArray(summary.files) || !number(summary.total) || !number(summary.added) || !number(summary.deleted))) continue
        if (summary?.total === 0) continue
        item = { kind: 'changes', sourceSeq: e.seq, turn: data.turn, anchorSeq: anchors.get(data.turn) ?? e.seq,
          available: summary !== undefined, ...(summary ? { total: summary.total, added: summary.added, deleted: summary.deleted,
            changes: summary.files.slice(0, 500).map((f: Row, index: number) => ({ index, path: String(f.display).slice(0, 4096),
              added: number(f.added) ? f.added : 0, deleted: number(f.deleted) ? f.deleted : 0,
              ...(f.binary ? { binary: true } : {}), ...(f.oversized ? { oversized: true } : {}) })),
            truncated: summary.total > Math.min(summary.files.length, 500) } : {}) }
      } else continue
      budget += Buffer.byteLength(JSON.stringify(item))
      if (budget > 512 * 1024) { cut = e.seq + 1; break }
      items.push(item)
    }
    const earliest = events[0]?.seq
    return { sessionId, items: items.sort((a, b) => a.sourceSeq - b.sourceSeq), hasMore: cut !== undefined || history.hasMore, ...((cut ?? (history.hasMore ? earliest : undefined)) === undefined ? {} : { nextBeforeSeq: cut ?? earliest }) }
  }

  async directory(deviceId: string, sessionId: string, rootRef: string | undefined, path: string, query: string | undefined, hidden: boolean, signal: AbortSignal): Promise<RemoteDirectory> {
    this.assertBrowse()
    const scope = await this.scope(sessionId, signal), root = await this.root(scope, deviceId, signal)
    if (rootRef !== undefined && rootRef !== root.rootRef) failure('E_BUSY', '项目目录已变化，请返回项目根目录')
    if (!workspaceRelative(path)) failure('E_FORBIDDEN', '只能浏览当前项目内的文件')
    const files = this.service('workspaceFiles')!
    const trimmedQuery = query?.trim()
    if (trimmedQuery !== undefined && trimmedQuery.length > 0) {
      const result = await files.search(scope, { query: trimmedQuery, excludedPaths: [], includeHidden: hidden, respectGitignore: true }, signal)
      this.assertBrowse(); signal.throwIfAborted()
      return { sessionId, rootRef: root.rootRef, rootLabel: scope.workspaceRoot.slice(0, 4096), path: '', query: trimmedQuery,
        entries: result.matches.slice(0, 500).flatMap((v: Row) => workspaceRelative(v.path) && ['file', 'directory'].includes(v.type)
          ? [{ name: leaf(v.path), path: v.path, kind: v.type }] : []), truncated: result.truncated === true || result.matches.length > 500, incomplete: result.incomplete === true }
    }
    // DSH WorkspaceFiles.inspect 拒绝空字符串 path，dsh-fs-local.lstat 拒绝纯空白字符串；
    // 根目录传 '.'，子目录补 './' 前缀，解析后仍回到同一规范化工作区根内。
    const result = await files.list(scope, path === '' ? '.' : `./${path}`, signal)
    this.assertBrowse(); signal.throwIfAborted()
    const listedPath = typeof result.path === 'string' && workspaceRelative(result.path) ? result.path : path
    return { sessionId, rootRef: root.rootRef, rootLabel: scope.workspaceRoot.slice(0, 4096), path: listedPath,
      entries: result.entries.slice(0, 500).flatMap((e: Row) => typeof e.name === 'string' && e.name.length <= 4096 && !e.name.includes('/') && !e.name.includes('\\') && e.name !== '.git' &&
        (hidden || !e.name.startsWith('.')) && ['file', 'directory'].includes(e.type)
        ? [{ name: e.name, path: [listedPath, e.name].filter(Boolean).join('/'), kind: e.type, ...(number(e.size) ? { bytes: e.size } : {}) }] : []),
      truncated: result.truncated === true || result.entries.length > 500 }
  }

  private async target(deviceId: string, sessionId: string, ref: RemoteFileRef, signal: AbortSignal): Promise<{ scope: Scope; path: string; workspace: boolean }> {
    if (!this.filesAvailable) failure('E_UNSUPPORTED', '当前主机不支持读取文件')
    if (ref.kind === 'deliverable') {
      // A historical result stays anchored to its recorded path and original
      // session directory even when the project's browsing root moves.
      const read = await this.event(sessionId, ref.sourceSeq, 'deliverables/presented', signal)
      const path = read.target.data?.files?.[ref.fileIndex]?.path
      if (typeof path !== 'string' || !path || path.length > 4096) failure('E_NOT_FOUND', '成果文件已不存在')
      const workspaceRoot = read.session.cwd ?? this.service('sandboxPolicy')?.workspaceRoot
      if (typeof workspaceRoot !== 'string') failure('E_UNSUPPORTED', '主机未提供文件目录')
      return { scope: { sessionId, workspaceRoot }, path, workspace: false }
    }
    this.assertBrowse()
    if (!workspaceRelative(ref.path)) failure('E_FORBIDDEN', '只能读取当前项目内的文件')
    const scope = await this.scope(sessionId, signal), root = await this.root(scope, deviceId, signal)
    if (root.rootRef !== ref.rootRef) failure('E_BUSY', '项目目录已变化，请返回项目根目录')
    const fs = this.service('fs')!, target = await fs.resolve(ref.path, { cwd: scope.workspaceRoot, signal })
    if (!insideFileRoot(root.url, fs.fileUrl(target))) failure('E_FORBIDDEN', '文件不在当前项目内')
    return { scope, path: fs.processPath(target), workspace: true }
  }

  async stat(deviceId: string, sessionId: string, ref: RemoteFileRef, signal: AbortSignal): Promise<RemoteFileInfo> {
    const { scope, path } = await this.target(deviceId, sessionId, ref, signal)
    const info = await this.service('workspaceFiles')!.stat(scope, path, signal)
    signal.throwIfAborted()
    return { sessionId, name: leaf(path), version: info.version, ...(number(info.bytes) ? { bytes: info.bytes } : {}), mediaType: mediaType(path) }
  }

  async text(deviceId: string, sessionId: string, ref: RemoteFileRef, offset: number, version: string | undefined, signal: AbortSignal): Promise<RemoteTextPage> {
    const { scope, path, workspace } = await this.target(deviceId, sessionId, ref, signal)
    const page = await this.service('workspaceFiles')!.read(scope, path, { offset, limit: 200 }, signal)
    signal.throwIfAborted(); if (workspace) this.assertBrowse()
    const after = await this.service('workspaceFiles')!.stat(scope, path, signal)
    signal.throwIfAborted()
    if (after.version !== page.version || (version !== undefined && version !== page.version)) failure('E_BUSY', '文件已变化，请重新打开')
    if (typeof page.text !== 'string' || Buffer.byteLength(page.text) > 256 * 1024) failure('E_PROTOCOL', '文本页过大，请在电脑端查看')
    return { sessionId, name: leaf(path), version: page.version, mediaType: mediaType(path), bytes: page.bytes,
      offset: page.offset, text: page.text, lines: page.lines, eof: page.eof }
  }

  async open(deviceId: string, sessionId: string, ref: RemoteFileRef, signal: AbortSignal, transferId: string = randomUUID()): Promise<RemoteFileManifest> {
    this.sweep()
    if (this.disposed) failure('E_BUSY', '连接已结束')
    if (this.transfers.has(transferId) || [...this.preparing.values()].some(p => p.transferId === transferId) || this.preparing.has(deviceId) || [...this.transfers.values()].some(t => t.deviceId === deviceId) || this.transfers.size + this.preparing.size >= 2) failure('E_BUSY', '已有文件正在读取，请先关闭预览')
    const cancel = new AbortController()
    this.preparing.set(deviceId, { sessionId, transferId, cancel })
    const workSignal = AbortSignal.any([signal, cancel.signal, AbortSignal.timeout(120_000)])
    try {
      const { scope, path, workspace } = await this.target(deviceId, sessionId, ref, workSignal)
      const files = this.service('workspaceFiles')!, first = await files.stat(scope, path, workSignal)
      if (number(first.bytes) && first.bytes > MAX_FILE_BYTES) failure('E_PROTOCOL', '文件超过手机读取上限（32 MiB）')
      const pieces: Buffer[] = []
      let bytes = 0
      for (;;) {
        workSignal.throwIfAborted(); if (workspace) this.assertBrowse()
        const page = await files.readBytes(scope, path, { range: { offset: bytes, length: FILE_CHUNK_BYTES } }, workSignal)
        if (page.version !== first.version || page.offset !== bytes || !(page.data instanceof Uint8Array)) failure('E_BUSY', '文件已变化，请重新打开')
        const part = Buffer.from(page.data.buffer, page.data.byteOffset, page.data.byteLength)
        bytes += part.length
        if (part.length > FILE_CHUNK_BYTES || bytes > MAX_FILE_BYTES) failure('E_PROTOCOL', '文件超过手机读取上限（32 MiB）')
        pieces.push(part)
        if (page.eof === true) break
        if (part.length === 0) failure('E_PROTOCOL', '主机未能完整读取文件')
      }
      const last = await files.stat(scope, path, workSignal)
      workSignal.throwIfAborted(); if (workspace) this.assertBrowse()
      if (last.version !== first.version || (number(first.bytes) && first.bytes !== bytes) || (number(last.bytes) && last.bytes !== bytes)) failure('E_BUSY', '文件已变化，请重新打开')
      if (this.disposed) failure('E_BUSY', '连接已结束')
      const data = Buffer.concat(pieces, bytes)
      const manifest: RemoteFileManifest = { sessionId, transferId, name: leaf(path), version: first.version, mediaType: mediaType(path), bytes,
        sha256: createHash('sha256').update(data).digest('hex') }
      const abort = () => this.close(deviceId, sessionId, transferId)
      this.transfers.set(transferId, { deviceId, sessionId, signal, abort, data, manifest, touched: Date.now(), workspace, timer: setTimeout(abort, 120_000) })
      this.transfers.get(transferId)!.timer.unref?.()
      signal.addEventListener('abort', abort, { once: true })
      return manifest
    } finally { this.preparing.delete(deviceId) }
  }
  read(deviceId: string, sessionId: string, transferId: string, offset: number, signal: AbortSignal): { data: Buffer; offset: number; eof: boolean } {
    this.sweep()
    const t = this.transfers.get(transferId)
    if (!t || t.deviceId !== deviceId || t.sessionId !== sessionId || t.signal !== signal) failure('E_NOT_FOUND', '本次文件读取已结束，请重新打开')
    if (t.workspace) this.assertBrowse()
    if (!number(offset) || offset > t.data.length) failure('E_PROTOCOL', '文件读取位置无效')
    t.touched = Date.now()
    t.timer.refresh()
    const data = t.data.subarray(offset, offset + FILE_CHUNK_BYTES)
    return { data, offset, eof: offset + data.length === t.data.length }
  }
  close(deviceId: string, sessionId: string, transferId: string): void {
    const pending = this.preparing.get(deviceId)
    if (pending?.sessionId === sessionId && pending.transferId === transferId) pending.cancel.abort()
    const t = this.transfers.get(transferId)
    if (!t || t.deviceId !== deviceId || t.sessionId !== sessionId) return
    clearTimeout(t.timer)
    t.signal.removeEventListener('abort', t.abort)
    this.transfers.delete(transferId)
  }
  private sweep(): void {
    for (const [id, t] of this.transfers) if (Date.now() - t.touched > 120_000 || t.signal.aborted) this.close(t.deviceId, t.sessionId, id)
  }
  dispose(): void { this.disposed = true; for (const p of this.preparing.values()) p.cancel.abort(); for (const [id, t] of this.transfers) this.close(t.deviceId, t.sessionId, id) }

  async diff(sessionId: string, sourceSeq: number, fileIndex: number, offset: number, signal: AbortSignal): Promise<RemoteDiffPage> {
    await this.event(sessionId, sourceSeq, 'workspace/changes', signal)
    const diff = await this.service('workspaceChanges')?.diff?.(sessionId, sourceSeq, fileIndex, signal)
    signal.throwIfAborted()
    if (!diff) return { sessionId, sourceSeq, fileIndex, path: '', kind: 'expired', lines: [] }
    const common = { sessionId, sourceSeq, fileIndex, path: String(diff.display).slice(0, 4096) }
    if (diff.kind !== 'text') return { ...common, kind: diff.kind === 'binary' ? 'binary' : 'oversized', lines: [] }
    const lines: RemoteDiffLine[] = []
    let count = 0, bytes = 0, nextOffset: number | undefined
    outer: for (const hunk of diff.hunks) {
      let oldLine = hunk.oldStart, newLine = hunk.newStart
      const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
      const candidates = [{ kind: 'header', text: header }, ...hunk.lines.map((raw: string) => {
        const sign = raw[0], kind = sign === '+' ? 'added' : sign === '-' ? 'removed' : 'context'
        const item = { kind, text: raw.slice(1, 8193), ...(sign !== '+' ? { old: oldLine++ } : {}), ...(sign !== '-' ? { new: newLine++ } : {}), ...(raw.length > 8193 ? { truncated: true } : {}) }
        return item
      })] as RemoteDiffLine[]
      for (const line of candidates) {
        if (count++ < offset) continue
        const size = Buffer.byteLength(JSON.stringify(line))
        if (lines.length >= 300 || bytes + size > 192 * 1024) { nextOffset = count - 1; break outer }
        lines.push(line); bytes += size
      }
    }
    return { ...common, kind: 'text', lines, coarse: diff.coarse === true, ...(nextOffset === undefined ? {} : { nextOffset }) }
  }
}
