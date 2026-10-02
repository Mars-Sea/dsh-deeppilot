/**
 * 会话特性的 wire 行：列表/归档、打开与关闭、创建/分支/重命名/取消、历史与
 * 附件、模型目录与切换、prompt 投递。
 *
 * handler 体从 connection.ts 的 switch 原样迁来，`this.` 换成 `ctx.`；
 * 该校验的判定与顺序和迁移前一致——先是原 request-validation 的形状检查，
 * 后是原 case 体内的形状检查——因此同一载荷在新旧路径上得到同一个错误码与
 * 同一条信息（tests/wire-parity.test.ts 在迁移期逐条对等，之后由
 * tests/wire-rows.test.ts 固定为显式期望）。
 */

import { validSendId } from './connection-policy.ts'
import { normalizePageLimit } from './host-event-projection.ts'
import {
  IMAGE_MEDIA_TYPES,
  MAX_BASE64_CHARS_PER_IMAGE,
  MAX_DOCUMENT_MEDIA_TYPE_CHARS,
  MAX_DOCUMENT_NAME_CHARS,
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_PROMPT_DOCUMENTS,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_TEXT_CHARS,
  sanitizeDocumentField,
  sanitizeImageName,
} from './connection-policy.ts'
import {
  accept,
  isInteger,
  isOptionalField,
  isText,
  payloadObject,
  reject,
  type CheckedPayload,
  type WireFrameRow,
} from './wire-registry.ts'

/** 会话读取域的帧共同要求 sessions.read（PROTOCOL.md scope 映射表）。 */
const READ: WireFrameRow['scopes'] = ['sessions.read']
const MANAGE: WireFrameRow['scopes'] = ['sessions.manage']

/** 原 request-validation 的 sessionId 检查：所有 c2s.session.* 共用的第一道。 */
function requireSessionId(payload: Record<string, unknown>): CheckedPayload | undefined {
  if (!isText(payload.sessionId)) return reject('E_PROTOCOL', 'invalid sessionId')
  return undefined
}

export const sessionRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.ping',
    stage: 'pre-auth',
    scopes: [],
    widgetPolicy: 'allowed',
    doc: 'PROTOCOL.md 连接与鉴权',
    handle: (ctx) => {
      ctx.send('s2c.pong', { serverTime: Date.now() })
    },
  },
  {
    // 握手帧。机制（验签、scope 载入、welcome、续传）仍在连接里：这是认证
    // 状态机的地盘，行只登记「它存在、无需 scope、认证前可到」。
    type: 'c2s.auth.prove',
    stage: 'pre-auth',
    scopes: [],
    widgetPolicy: 'allowed',
    doc: 'PROTOCOL.md 连接与鉴权',
    handle: (ctx) => ctx.prove(),
  },
  {
    type: 'c2s.sessions.list',
    stage: 'authenticated',
    scopes: READ,
    widgetPolicy: 'allowed',
    doc: 'PROTOCOL.md c2s.sessions.list',
    validate: (payload) => payloadObject(payload),
    handle: (ctx) => {
      ctx.send('s2c.sessions.snapshot', { full: true, sessions: ctx.bridge.listSessions() })
    },
  },
  {
    // 与 list 同语义的无参帧：载荷可省略或为 null（G2）。
    type: 'c2s.sessions.archived',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.sessions.archived',
    validate: (payload) => payloadObject(payload),
    handle: (ctx) => {
      ctx.send('s2c.sessions.archived.snapshot', { sessions: ctx.bridge.listArchivedSessions() })
    },
  },
  {
    type: 'c2s.pending.list',
    stage: 'authenticated',
    scopes: ['interactions.respond'],
    widgetPolicy: 'allowed',
    capability: 'pendingSnapshot',
    doc: 'PROTOCOL.md c2s.pending.list',
    validate: (payload) => payloadObject(payload),
    handle: (ctx) => {
      ctx.send('s2c.pending.snapshot', ctx.bridge.pendingSnapshot())
    },
  },
  {
    type: 'c2s.workspaces.list',
    stage: 'authenticated',
    scopes: READ,
    capability: 'projectSelection',
    doc: 'PROTOCOL.md c2s.workspaces.list',
    validate: (payload) => payloadObject(payload),
    handle: async (ctx) => {
      const result = await ctx.bridge.listWorkspaces()
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.workspaces.snapshot', { workspaces: result.value })
    },
  },
  {
    type: 'c2s.workspace.create',
    stage: 'authenticated',
    scopes: MANAGE,
    capability: 'projectSelection',
    doc: 'PROTOCOL.md c2s.workspace.create',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!isText(checked.value.path, 32768)) return reject('E_PROTOCOL', 'invalid path')
      return checked
    },
    handle: async (ctx, payload) => {
      const path = String(payload.path).trim()
      // 空路径是载荷问题，先于能力检查（与迁移前次序一致）。
      if (!path) return ctx.fail('E_PROTOCOL', 'non-empty path required')
      const result = await ctx.bridge.createWorkspace(path)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.workspace.created', result.value)
    },
  },
  {
    type: 'c2s.directory.list',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.directory.list',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!isOptionalField(checked.value, 'path', (v) => isText(v, 32768, false))) {
        return reject('E_PROTOCOL', 'invalid path')
      }
      if (checked.value.path !== undefined && typeof checked.value.path !== 'string') {
        return reject('E_PROTOCOL', 'path must be a string')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.listDirectory(payload.path as string | undefined)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.directory.listing', result.value)
    },
  },
  {
    type: 'c2s.directory.pick',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.directory.pick',
    validate: (payload) => payloadObject(payload),
    handle: async (ctx) => {
      const result = await ctx.bridge.pickDirectory()
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.directory.picked', { path: result.value })
    },
  },
  {
    type: 'c2s.session.open',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.session.open',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (!isOptionalField(checked.value, 'tailCount', (v) => isInteger(v, 1, 10000))) {
        return reject('E_PROTOCOL', 'invalid tailCount')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const sessionId = payload.sessionId as string
      const buffered = ctx.bufferOpenEvents(sessionId)
      const ok = await ctx.bridge.openSession(ctx, sessionId, (payload.tailCount as number | undefined) ?? 100)
      if (!ok) {
        // 打开失败：仅当缓冲仍属于本次尝试时才移除，避免清掉并发打开的新缓冲。
        ctx.discardOpenBuffer(sessionId, buffered)
        return ctx.fail('E_NOT_FOUND', 'session history unavailable')
      }
      // 并发的 close 或替换打开会使本次尝试失效：它的 tail 已经发出，但不应
      // 在用户离开页面后重新激活实时投递。
      if (!ctx.flushOpenBuffer(sessionId, buffered)) return
    },
  },
  {
    type: 'c2s.session.close',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.session.close',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      return requireSessionId(checked.value) ?? checked
    },
    handle: (ctx, payload) => {
      ctx.closeOpenSession(payload.sessionId as string)
      ctx.send('s2c.ack', {})
    },
  },
  {
    type: 'c2s.session.create',
    stage: 'authenticated',
    scopes: MANAGE,
    doc: 'PROTOCOL.md c2s.session.create',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (
        !isOptionalField(checked.value, 'workspaceId', (v) => isText(v)) ||
        !isOptionalField(checked.value, 'cwd', (v) => isText(v, 32768)) ||
        (checked.value.workspaceId !== undefined && checked.value.cwd !== undefined)
      ) {
        return reject('E_PROTOCOL', 'invalid workspace selection')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const workspaceId = typeof payload.workspaceId === 'string' ? String(payload.workspaceId).trim() : ''
      const cwd = typeof payload.cwd === 'string' ? String(payload.cwd).trim() : ''
      if (workspaceId && cwd) return ctx.fail('E_PROTOCOL', 'workspaceId and cwd are mutually exclusive')
      const newId = await ctx.bridge.createSession({
        ...(workspaceId ? { workspaceId } : {}),
        ...(cwd ? { cwd } : {}),
      })
      if (!newId) return ctx.fail('E_INTERNAL', 'session create failed')
      ctx.send('s2c.ack', { sessionId: newId })
    },
  },
  {
    // PROTOCOL.md：分支会话要求 sessions.read 与 sessions.manage 两个 scope
    // （迁移前只校验了 sessions.manage，调用点的补充规则漏掉了本帧，见 G1）。
    type: 'c2s.session.fork',
    stage: 'authenticated',
    scopes: [...MANAGE, ...READ],
    capability: 'sessionFork',
    doc: 'PROTOCOL.md Session 分支扩展',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (!validSendId(checked.value.clientRequestId) || !isOptionalField(checked.value, 'atSeq', (v) => isInteger(v, 0, Number.MAX_SAFE_INTEGER))) {
        return reject('E_PROTOCOL', 'invalid session fork fields')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const deviceId = ctx.deviceId!
      const result = await ctx.bridge.forkSession(deviceId, {
        sessionId: payload.sessionId as string,
        clientRequestId: payload.clientRequestId as string,
        ...(payload.atSeq !== undefined ? { atSeq: payload.atSeq as number } : {}),
      })
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.session.forked', {
        clientRequestId: payload.clientRequestId,
        sourceSessionId: payload.sessionId,
        sessionId: result.value.sessionId,
        ...(payload.atSeq !== undefined ? { atSeq: payload.atSeq } : {}),
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  {
    type: 'c2s.session.rename',
    stage: 'authenticated',
    scopes: MANAGE,
    capability: 'sessionManagement',
    doc: 'PROTOCOL.md c2s.session.rename',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (!isText(checked.value.title, 4096)) return reject('E_PROTOCOL', 'invalid title')
      return checked
    },
    handle: async (ctx, payload) => {
      const title = String(payload.title).trim()
      if (title.length === 0) return ctx.fail('E_PROTOCOL', 'sessionId and non-empty title required')
      const result = await ctx.bridge.renameSession(payload.sessionId as string, title)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.session.renamed', { sessionId: payload.sessionId, title: result.value })
    },
  },
  {
    type: 'c2s.session.archive',
    stage: 'authenticated',
    scopes: MANAGE,
    capability: 'sessionManagement',
    doc: 'PROTOCOL.md c2s.session.archive',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      return requireSessionId(checked.value) ?? checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.archiveSession(payload.sessionId as string)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.session.archived', { sessionId: payload.sessionId })
    },
  },
  {
    type: 'c2s.session.unarchive',
    stage: 'authenticated',
    scopes: MANAGE,
    capability: 'sessionRestore',
    doc: 'PROTOCOL.md c2s.session.unarchive',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      return requireSessionId(checked.value) ?? checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.unarchiveSession(payload.sessionId as string)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.session.unarchived', { sessionId: payload.sessionId })
    },
  },
  {
    type: 'c2s.session.cancel',
    stage: 'authenticated',
    scopes: MANAGE,
    doc: 'PROTOCOL.md c2s.session.cancel',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      return requireSessionId(checked.value) ?? checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.cancelSession(payload.sessionId as string)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.ack', { sessionId: payload.sessionId })
    },
  },
  {
    type: 'c2s.session.history',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.session.history',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (
        !isInteger(checked.value.beforeSeq, 0, Number.MAX_SAFE_INTEGER) ||
        !isOptionalField(checked.value, 'limit', (v) => isInteger(v, 1, 500))
      ) {
        return reject('E_PROTOCOL', 'invalid history range')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      if (typeof payload.beforeSeq !== 'number') {
        return ctx.fail('E_PROTOCOL', 'sessionId and beforeSeq required')
      }
      const page = await ctx.bridge.historyPage(
        payload.sessionId as string,
        payload.beforeSeq,
        normalizePageLimit(payload.limit),
      )
      if (!page) return ctx.fail('E_NOT_FOUND', 'history unavailable')
      ctx.send('s2c.history.page', page)
    },
  },
  {
    type: 'c2s.session.attachment',
    stage: 'authenticated',
    scopes: READ,
    doc: 'PROTOCOL.md c2s.session.attachment',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (!isText(checked.value.attachmentId)) return reject('E_PROTOCOL', 'invalid attachmentId')
      return checked
    },
    handle: async (ctx, payload) => {
      const attachmentId = payload.attachmentId as string
      if (attachmentId.length === 0) return ctx.fail('E_PROTOCOL', 'sessionId and attachmentId required')
      const image = await ctx.bridge.attachmentData(payload.sessionId as string, attachmentId)
      if (!image) return ctx.fail('E_NOT_FOUND', 'attachment unavailable')
      ctx.send('s2c.ack', image)
    },
  },
  {
    type: 'c2s.session.models',
    stage: 'authenticated',
    scopes: READ,
    capability: 'models',
    doc: 'PROTOCOL.md c2s.session.models',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      return requireSessionId(checked.value) ?? checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.sessionModels(payload.sessionId as string)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.session.models', { sessionId: payload.sessionId, ...result.value })
    },
  },
  {
    type: 'c2s.session.selectModel',
    stage: 'authenticated',
    scopes: MANAGE,
    capability: 'models',
    doc: 'PROTOCOL.md c2s.session.selectModel',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (
        !isText(checked.value.provider, 256) ||
        !isText(checked.value.model, 1024) ||
        !isOptionalField(checked.value, 'reasoningEffort', (v) => isText(v, 128, false))
      ) {
        return reject('E_PROTOCOL', 'invalid model selection')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      if (!String(payload.provider).trim() || !String(payload.model).trim()) {
        return ctx.fail('E_PROTOCOL', 'sessionId, provider and model required')
      }
      const result = await ctx.bridge.selectSessionModel(payload.sessionId as string, {
        provider: String(payload.provider).trim(),
        model: String(payload.model).trim(),
        ...(String(payload.reasoningEffort ?? '').trim()
          ? { reasoningEffort: String(payload.reasoningEffort).trim() }
          : {}),
      })
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.session.modelSelected', { sessionId: payload.sessionId, selected: result.value })
    },
  },
  {
    // 投递回执查询：journal 语义，能力位恒真但仍绑定，缺位即说明 Bridge 被改动。
    type: 'c2s.session.delivery',
    stage: 'authenticated',
    scopes: ['prompt.send'],
    capability: 'promptDelivery',
    doc: 'PROTOCOL.md c2s.session.delivery',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      if (!validSendId(checked.value.clientSendId)) return reject('E_PROTOCOL', 'invalid clientSendId')
      return checked
    },
    handle: (ctx, payload) => {
      ctx.send('s2c.ack', ctx.bridge.promptDeliveries.lookup(
        ctx.deviceId!,
        payload.clientSendId as string,
        payload.sessionId as string,
      ))
    },
  },
  {
    type: 'c2s.session.sendPrompt',
    stage: 'authenticated',
    scopes: ['prompt.send'],
    doc: 'PROTOCOL.md c2s.session.sendPrompt',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const invalid = requireSessionId(checked.value)
      if (invalid) return invalid
      const p = checked.value
      if (p.clientSendId !== undefined && !validSendId(p.clientSendId)) {
        return reject('E_PROTOCOL', 'invalid clientSendId')
      }
      if (
        !isOptionalField(p, 'text', (v) => isText(v, MAX_PROMPT_TEXT_CHARS, false)) ||
        !isOptionalField(p, 'images', Array.isArray) ||
        !isOptionalField(p, 'documents', Array.isArray)
      ) {
        return reject('E_PROTOCOL', 'invalid prompt fields')
      }
      // 附件条目形状：原 request-validation 的检查整体先于 handler 的资源上限，
      // 次序保持不变，同一条载荷在两条路径上得到同一条信息。
      for (const key of ['images', 'documents']) {
        const items = p[key] as unknown[] | undefined
        if (items && items.some((v) => v === null || typeof v !== 'object' || Array.isArray(v))) {
          return reject('E_PROTOCOL', 'invalid attachment')
        }
        for (const item of (items ?? []) as Array<Record<string, unknown>>) {
          if (item.name !== undefined && !isText(item.name, 4096, false)) {
            return reject('E_PROTOCOL', 'invalid attachment name')
          }
          if (item.truncated !== undefined && typeof item.truncated !== 'boolean') {
            return reject('E_PROTOCOL', 'invalid truncated flag')
          }
        }
      }
      const text = typeof p.text === 'string' ? p.text : ''
      const rawImages = Array.isArray(p.images) ? p.images : []
      const rawDocuments = Array.isArray(p.documents) ? p.documents : []
      if (text.trim().length === 0 && rawImages.length === 0 && rawDocuments.length === 0) {
        return reject('E_PROTOCOL', 'sessionId and prompt content required')
      }
      if (rawImages.length > MAX_PROMPT_IMAGES) return reject('E_PROTOCOL', 'too many images')
      if (rawDocuments.length > MAX_PROMPT_DOCUMENTS || rawImages.length + rawDocuments.length > MAX_PROMPT_IMAGES) {
        return reject('E_PROTOCOL', 'too many prompt attachments')
      }
      const images: Array<{ mediaType: string; data: string; name?: string }> = []
      for (const image of rawImages as Array<Record<string, unknown>>) {
        const mediaType = String(image?.mediaType)
        const data = image?.data
        if (
          !IMAGE_MEDIA_TYPES.has(mediaType) ||
          typeof data !== 'string' ||
          data.length === 0 ||
          data.length > MAX_BASE64_CHARS_PER_IMAGE
        ) {
          return reject('E_PROTOCOL', 'invalid image attachment')
        }
        images.push({
          mediaType,
          data,
          ...(typeof image.name === 'string' && sanitizeImageName(image.name).length > 0
            ? { name: sanitizeImageName(image.name) }
            : {}),
        })
      }
      const documents: Array<{ mediaType: string; name: string; text: string; truncated?: boolean }> = []
      for (const document of rawDocuments as Array<Record<string, unknown>>) {
        const name = document?.name
        const mediaType = document?.mediaType
        const documentText = document?.text
        if (
          typeof name !== 'string' ||
          typeof mediaType !== 'string' ||
          typeof documentText !== 'string' ||
          documentText.length === 0 ||
          documentText.length > MAX_DOCUMENT_TEXT_CHARS
        ) {
          return reject('E_PROTOCOL', 'invalid document attachment')
        }
        const cleanName = sanitizeDocumentField(name, MAX_DOCUMENT_NAME_CHARS)
        const cleanMediaType = sanitizeDocumentField(mediaType, MAX_DOCUMENT_MEDIA_TYPE_CHARS).toLowerCase()
        if (!cleanName || !cleanMediaType || cleanMediaType.startsWith('image/')) {
          return reject('E_PROTOCOL', 'invalid document attachment')
        }
        documents.push({
          name: cleanName,
          mediaType: cleanMediaType,
          text: documentText,
          ...(document.truncated === true ? { truncated: true } : {}),
        })
      }
      return accept({
        sessionId: p.sessionId,
        text,
        images,
        documents,
        ...(p.clientSendId !== undefined ? { clientSendId: p.clientSendId } : {}),
      })
    },
    handle: async (ctx, payload) => {
      const sessionId = payload.sessionId as string
      const text = payload.text as string
      const images = payload.images as Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }>
      const documents = payload.documents as Array<{ mediaType: string; name: string; text: string; truncated?: boolean }>
      const clientSendId = payload.clientSendId as string | undefined
      if (clientSendId !== undefined) {
        // 幂等投递：同一 clientSendId 重复到达时复用回执，不重复入队。
        const receipt = await ctx.bridge.promptDeliveries.dispatch(
          ctx.deviceId!,
          clientSendId,
          { sessionId, content: { text, images, documents } },
          () => ctx.bridge.sendPrompt(sessionId, text, images, documents),
        )
        ctx.send('s2c.ack', receipt)
        return
      }
      const userSeq = await ctx.bridge.sendPrompt(sessionId, text, images, documents)
      if (!userSeq.ok) return ctx.fail(userSeq.code, userSeq.message)
      ctx.send('s2c.ack', { userSeq: userSeq.value })
    },
  },
]
