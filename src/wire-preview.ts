/**
 * 本机预览扩展（能力 `localPreview`）的 wire 行。
 *
 * 只登记 JSON 控制帧；数据帧是二进制帧，由连接门的 handleBinaryFrame 直接交给
 * PreviewTunnel，不经注册表（每秒可能上百帧，走 JSON 校验链没有意义）。
 *
 * 四帧都只在预览连接（clientRole: "preview"）上有效：主连接没有 PreviewTunnel，
 * handler 统一回 E_FORBIDDEN。反方向的限制（预览连接只准发这四帧与 ping）由
 * `previewPolicy` 在连接门里执行。
 */

import {
  accept,
  isInteger,
  isText,
  payloadObject,
  reject,
  type FrameContext,
  type WireFrameRow,
} from './wire-registry.ts'
import type { DeviceScope } from './device-auth.ts'
import { MAX_STREAM_ID } from './preview-tunnel.ts'

const PREVIEW: readonly DeviceScope[] = ['preview.open']
const DOC = 'PROTOCOL.md 本机预览扩展'

/** URL 上限：本机链接不会更长，超长直接按非法载荷拒绝。 */
const MAX_URL_CHARS = 2048

function requirePreview(ctx: FrameContext): ctx is FrameContext & { preview: NonNullable<FrameContext['preview']> } {
  if (ctx.preview !== undefined) return true
  ctx.fail('E_FORBIDDEN', 'preview connection required')
  return false
}

function streamPayload(payload: unknown, extra?: (value: Record<string, unknown>) => string | undefined) {
  const checked = payloadObject(payload)
  if (!checked.ok) return checked
  if (!isInteger(checked.value.streamId, 1, MAX_STREAM_ID)) return reject('E_PROTOCOL', 'invalid streamId')
  const invalid = extra?.(checked.value)
  if (invalid !== undefined) return reject('E_PROTOCOL', invalid)
  return accept(checked.value)
}

export const previewRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.preview.authorize',
    stage: 'authenticated',
    scopes: PREVIEW,
    capability: 'localPreview',
    previewPolicy: 'allowed',
    doc: DOC,
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!isText(checked.value.sessionId)) return reject('E_PROTOCOL', 'invalid sessionId')
      if (!isText(checked.value.url, MAX_URL_CHARS)) return reject('E_PROTOCOL', 'invalid url')
      return accept(checked.value)
    },
    handle: async (ctx, payload) => {
      if (!requirePreview(ctx)) return
      await ctx.preview.authorize(ctx.frame.id, payload.sessionId as string, payload.url as string)
    },
  },
  {
    type: 'c2s.preview.open',
    stage: 'authenticated',
    scopes: PREVIEW,
    capability: 'localPreview',
    previewPolicy: 'allowed',
    doc: DOC,
    validate: (payload) => streamPayload(payload, (value) =>
      isInteger(value.port, 1, 65535) ? undefined : 'invalid port'),
    handle: async (ctx, payload) => {
      if (!requirePreview(ctx)) return
      await ctx.preview.open(ctx.frame.id, payload.streamId as number, payload.port as number)
    },
  },
  {
    type: 'c2s.preview.credit',
    stage: 'authenticated',
    scopes: PREVIEW,
    capability: 'localPreview',
    previewPolicy: 'allowed',
    doc: DOC,
    validate: (payload) => streamPayload(payload, (value) =>
      isInteger(value.bytes, 1, Number.MAX_SAFE_INTEGER) ? undefined : 'invalid bytes'),
    handle: (ctx, payload) => {
      if (!requirePreview(ctx)) return
      ctx.preview.credit(payload.streamId as number, payload.bytes as number)
    },
  },
  {
    type: 'c2s.preview.close',
    stage: 'authenticated',
    scopes: PREVIEW,
    capability: 'localPreview',
    previewPolicy: 'allowed',
    doc: DOC,
    validate: (payload) => streamPayload(payload),
    handle: (ctx, payload) => {
      if (!requirePreview(ctx)) return
      ctx.preview.close(payload.streamId as number)
    },
  },
]
