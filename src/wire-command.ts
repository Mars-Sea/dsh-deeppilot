import { isText, payloadObject, reject, type CheckedPayload, type WireFrameRow } from './wire-registry.ts'
import { hostFailureOf, wireErrorOf } from './wire-errors.ts'
import type { CommandAttachment } from './command-api.ts'

function sessionPayload(value: unknown): CheckedPayload {
  const result = payloadObject(value)
  return result.ok && !isText(result.value.sessionId) ? reject('E_PROTOCOL', '会话标识无效') : result
}
const categories = ['task-result', 'instruction-following', 'product-interaction', 'service-stability', 'resource-cost', 'security-privacy-permission', 'other']
export const commandRows: readonly WireFrameRow[] = [
  ...(['commands', 'permissions', 'feedback', 'command'] as const).map((name): WireFrameRow => ({
    type: `c2s.session.${name}`, stage: 'authenticated', capability: 'commands',
    scopes: name === 'commands' || name === 'permissions' ? ['sessions.read'] : ['prompt.send'],
    doc: `PROTOCOL.md c2s.session.${name}`,
    validate: value => {
      const result = sessionPayload(value)
      if (!result.ok) return result
      const p = result.value
      if (name === 'command') {
        if (typeof p.line !== 'string' || p.line.length > 64 * 1024 || !/^\/[a-z][a-z0-9_-]*(?:\s|$)/.test(p.line)) return reject('E_PROTOCOL', '指令格式无效')
        if (p.expectedDefinitionId !== undefined && (typeof p.expectedDefinitionId !== 'string' || !p.expectedDefinitionId || p.expectedDefinitionId.length > 512)) return reject('E_PROTOCOL', '指令定义标识无效')
        const attachments = p.attachments ?? []
        if (!Array.isArray(attachments) || attachments.length > 4) return reject('E_PROTOCOL', '附件数量无效')
        for (const item of attachments as CommandAttachment[]) {
          if (!item || !['image', 'document'].includes(item.type) || typeof item.name !== 'string' || item.name.length > 512 ||
              typeof item.mediaType !== 'string' || typeof item.data !== 'string' || item.data.length > 16 * 1024 * 1024 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data) ||
              (item.type === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mediaType))) return reject('E_PROTOCOL', '附件格式无效')
        }
        return { ok: true, value: { ...p, attachments } }
      }
      if (name === 'feedback' && (typeof p.text !== 'string' || p.text.length > 64 * 1024 || (p.category !== undefined && !categories.includes(String(p.category))))) return reject('E_PROTOCOL', '反馈内容无效')
      return result
    },
    handle: async (ctx, payload) => {
      const operation = name === 'commands' ? 'list' : name === 'command' ? 'execute' : name
      const result = await ctx.bridge.commandOperation(operation, payload)
      if (!result.ok) return ctx.fail(result.code, result.message)
      const type = name === 'commands' ? 's2c.session.commands' : name === 'permissions' ? 's2c.session.permissions' : name === 'command' ? 's2c.session.commandResult' : 's2c.ack'
      ctx.send(type, { sessionId: payload.sessionId, ...(result.value as object) })
    },
  })),
  {
    type: 'c2s.session.export', stage: 'authenticated', scopes: ['sessions.read'], capability: 'commands',
    doc: 'PROTOCOL.md c2s.session.export', validate: sessionPayload,
    handle: async (ctx, payload) => {
      const signal = AbortSignal.any([ctx.signal ?? new AbortController().signal, AbortSignal.timeout(10 * 60_000)])
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const cancel = () => { void reader?.cancel().catch(() => {}) }
      try {
        const response = await ctx.bridge.exportSession(payload.sessionId as string, signal)
        reader = response.body!.getReader()
        signal.addEventListener('abort', cancel, { once: true })
        let index = 0, bytes = 0
        while (true) {
          signal.throwIfAborted()
          const next = await reader.read()
          if (next.done) break
          for (let offset = 0; offset < next.value.length; offset += 48 * 1024) {
            const chunk = next.value.subarray(offset, offset + 48 * 1024)
            bytes += chunk.length
            await ctx.waitForWritable?.()
            ctx.send('s2c.session.export.chunk', { index: index++, data: Buffer.from(chunk).toString('base64') })
          }
        }
        signal.throwIfAborted()
        ctx.send('s2c.ack', { sessionId: payload.sessionId, fileName: 'dsh-session-log.zip', chunks: index, bytes })
      } catch (error) {
        // 归档失败不止一种：主机没生成归档、内容类型不符、十分钟超时，或者本次
        // 连接断开。此前这里统一成一句「请重试」，把主机给的真实原因也一并吞掉；
        // 现在按域表翻译，主机的中文原因原样带给手机，只有取消/超时这类没有上游
        // 码的抛出物才落回兜底文案。断线同样走这里——它必须留在「不报成功」一侧。
        const failure = hostFailureOf(error, 'command/export-cancelled')
        const message = failure.code === 'command/export-cancelled' ? '会话日志导出失败，请重试' : failure.message
        const mapped = wireErrorOf('command', { ...failure, message })
        ctx.fail(mapped.code, mapped.message)
      }
      finally { signal.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); reader?.releaseLock() }
    },
  },
]
