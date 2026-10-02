/**
 * 交互特性的 wire 行：回答待决的 approval 与 question。
 *
 * 两帧共用 `interactions.respond`。失败的三种结局（没有这条待决 / Host 拒收
 * 答案 / 传输失败）由 wire-errors 的词表翻译成 wire 错误码与可读信息——此前
 * 这条映射住在 connection-policy，和 scope 表、常量混在一起。
 */

import {
  isOptionalField,
  isText,
  payloadObject,
  reject,
  type WireFrameRow,
} from './wire-registry.ts'
import { pendingResponseErrorCode, pendingResponseMessage } from './wire-errors.ts'

const RESPOND: WireFrameRow['scopes'] = ['interactions.respond']

export const interactionRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.approval.respond',
    stage: 'authenticated',
    scopes: RESPOND,
    doc: 'PROTOCOL.md c2s.approval.respond',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (!isText(p.requestId)) return reject('E_PROTOCOL', 'invalid requestId')
      if (
        !['allow', 'deny'].includes(p.decision as string) ||
        !isOptionalField(p, 'reason', (v) => isText(v, 65536, false))
      ) {
        return reject('E_PROTOCOL', 'invalid approval response')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const decision = payload.decision as 'allow' | 'deny'
      if (decision !== 'allow' && decision !== 'deny') {
        return ctx.fail('E_PROTOCOL', 'requestId and decision required')
      }
      // 可选的拒绝理由必须抵达 Host，模型据此理解工具调用为何被拒。
      const outcome = await ctx.bridge.respondApproval(
        payload.requestId as string,
        decision,
        typeof payload.reason === 'string' ? (payload.reason as string) : undefined,
      )
      if (!outcome.ok) {
        const reason = outcome.reason
        return ctx.fail(pendingResponseErrorCode(reason), pendingResponseMessage('approval', reason))
      }
      ctx.send('s2c.ack', {})
    },
  },
  {
    type: 'c2s.question.respond',
    stage: 'authenticated',
    scopes: RESPOND,
    doc: 'PROTOCOL.md c2s.question.respond',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (!isText(p.requestId)) return reject('E_PROTOCOL', 'invalid requestId')
      if (!Array.isArray(p.answers) || p.answers.length > 100) return reject('E_PROTOCOL', 'invalid answers')
      const ids = new Set<unknown>()
      for (const answer of p.answers as Array<Record<string, unknown>>) {
        if (
          !answer ||
          typeof answer !== 'object' ||
          Array.isArray(answer) ||
          !isText(answer.id) ||
          ids.has(answer.id) ||
          !Array.isArray(answer.selected) ||
          answer.selected.length > 100 ||
          !answer.selected.every((v: unknown) => isText(v, 4096)) ||
          (answer.custom !== undefined && !isText(answer.custom, 65536))
        ) {
          return reject('E_PROTOCOL', 'invalid answer')
        }
        ids.add(answer.id)
      }
      return checked
    },
    handle: async (ctx, payload) => {
      if (!Array.isArray(payload.answers)) return ctx.fail('E_PROTOCOL', 'requestId and answers required')
      const outcome = await ctx.bridge.respondQuestion(payload.requestId as string, payload.answers)
      if (!outcome.ok) {
        const reason = outcome.reason
        return ctx.fail(pendingResponseErrorCode(reason), pendingResponseMessage('question', reason))
      }
      ctx.send('s2c.ack', {})
    },
  },
]
