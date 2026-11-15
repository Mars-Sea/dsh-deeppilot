import { hostFailureOf } from './wire-errors.ts'
import { ControlRejection } from './session-controls.ts'
import { workspaceRelative } from './session-resources.ts'
import type { RemoteFileRef } from './resource-models.ts'
import { isText, payloadObject, reject, type WireFrameRow, type S2CType } from './wire-registry.ts'

const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min
export function validFileRef(value: unknown): value is RemoteFileRef {
  const r = value as Partial<RemoteFileRef> | null
  return r !== null && typeof r === 'object' && (r.kind === 'deliverable'
    ? integer(r.sourceSeq) && integer(r.fileIndex) && r.fileIndex! < 32
    : r.kind === 'workspace' && isText(r.rootRef, 128) && workspaceRelative(r.path) && r.path.length > 0)
}
const types = ['session.resources.list', 'session.changes.diff', 'workspace.files.list', 'workspace.files.search', 'file.stat', 'file.text', 'file.open', 'file.read', 'file.close'] as const
export const resourceRows: readonly WireFrameRow[] = types.map(kind => ({
  type: `c2s.${kind}`, stage: 'authenticated', scopes: ['sessions.read'], widgetPolicy: 'deny',
  capability: kind === 'session.changes.diff' ? 'turnChanges' : kind.startsWith('workspace.') ? 'workspaceFiles' : kind === 'session.resources.list' ? undefined : 'fileDeliverables',
  doc: `PROTOCOL.md c2s.${kind}`,
  validate: value => {
    const p = payloadObject(value)
    if (!p.ok) return p
    const r = p.value
    if (!isText(r.sessionId)) return reject('E_PROTOCOL', '会话标识无效')
    let valid = true
    if (kind === 'session.resources.list') valid = (r.beforeSeq === undefined || integer(r.beforeSeq)) && (r.limit === undefined || integer(r.limit, 1) && (r.limit as number) <= 120)
    if (kind === 'session.changes.diff') valid = integer(r.sourceSeq) && integer(r.fileIndex) && (r.fileIndex as number) < 500 && (r.offset === undefined || integer(r.offset))
    if (kind.startsWith('workspace.')) valid = (r.rootRef === undefined || isText(r.rootRef, 128)) && workspaceRelative(r.path ?? '') &&
      (r.hidden === undefined || typeof r.hidden === 'boolean') && (kind !== 'workspace.files.search' || isText(r.query, 1024) && !(r.query as string).includes('\n'))
    if (['file.stat', 'file.text', 'file.open'].includes(kind)) valid = validFileRef(r.ref)
    if (kind === 'file.open') valid &&= isText(r.transferId, 128) && /^[a-f0-9-]{36}$/i.test(r.transferId as string)
    if (kind === 'file.text') valid &&= (r.offset === undefined || integer(r.offset, 1)) && (r.version === undefined || isText(r.version, 1024))
    if (kind === 'file.read' || kind === 'file.close') valid = isText(r.transferId, 128)
    if (kind === 'file.read') valid &&= integer(r.offset) && (r.binary === undefined || typeof r.binary === 'boolean')
    return valid ? p : reject('E_PROTOCOL', '文件请求无效')
  },
  handle: async (ctx, p) => {
    const resources = ctx.bridge.sessionResources
    if (!resources) return ctx.fail('E_UNSUPPORTED', '当前主机不支持会话文件')
    const signal = ctx.signal ?? new AbortController().signal
    const sid = p.sessionId as string, device = ctx.deviceId!, ref = p.ref as RemoteFileRef
    try {
      let type: S2CType, value: unknown
      switch (kind) {
        case 'session.resources.list': type = 's2c.session.resources'; value = await resources.list(sid, p.beforeSeq as number | undefined, p.limit as number ?? 60, signal); break
        case 'session.changes.diff': type = 's2c.session.changes.diff'; value = await resources.diff(sid, p.sourceSeq as number, p.fileIndex as number, p.offset as number ?? 0, signal); break
        case 'workspace.files.list': case 'workspace.files.search': type = 's2c.workspace.files'; value = await resources.directory(device, sid, p.rootRef as string | undefined, p.path as string ?? '', kind.endsWith('search') ? p.query as string : undefined, p.hidden === true, signal); break
        case 'file.stat': type = 's2c.file.info'; value = await resources.stat(device, sid, ref, signal); break
        case 'file.text': type = 's2c.file.text'; value = await resources.text(device, sid, ref, p.offset as number ?? 1, p.version as string | undefined, signal); break
        case 'file.open': type = 's2c.file.manifest'; value = await resources.open(device, sid, ref, signal, p.transferId as string); break
        case 'file.read': {
          const chunk = resources.read(device, sid, p.transferId as string, p.offset as number, signal)
          const binary = p.binary === true && ctx.sendBinary !== undefined
          const data = binary ? chunk.data : chunk.data.subarray(0, 48 * 1024)
          const header = { transferId: p.transferId, offset: chunk.offset }
          await ctx.waitForWritable?.()
          if (binary) ctx.sendBinary!('s2c.file.chunk', header, data)
          else ctx.send('s2c.file.chunk', { ...header, data: data.toString('base64') })
          type = 's2c.ack'; value = { sessionId: sid, ...header, bytes: data.length, eof: chunk.eof && data.length === chunk.data.length }; break
        }
        case 'file.close': resources.close(device, sid, p.transferId as string); type = 's2c.ack'; value = { sessionId: sid }; break
      }
      ctx.send(type!, value)
    } catch (error) {
      if (error instanceof ControlRejection) return ctx.fail(error.code, error.message)
      const code = hostFailureOf(error, '').code
      if (code === 'workspace-file/too-large') return ctx.fail('E_PROTOCOL', '文件或文本页过大，请在电脑端查看')
      if (code === 'workspace-file/not-regular-file' || code === 'workspace-file/not-directory') return ctx.fail('E_UNSUPPORTED', '此项目无法作为普通文件读取')
      if (code === 'workspace-file/not-text') return ctx.fail('E_UNSUPPORTED', '此文件不是 UTF-8 文本')
      if (code === 'workspace-file/outside-workspace') return ctx.fail('E_FORBIDDEN', '只能读取当前项目内的文件')
      if (code === 'workspace-file/search-failed') return ctx.fail('E_INTERNAL', '文件搜索失败，请稍后重试')
      if (code === 'gateway/bad-request') return ctx.fail('E_PROTOCOL', '文件请求无效')
      ctx.fail('E_NOT_FOUND', '电脑上的文件已不存在或暂时无法读取')
    }
  },
}))
