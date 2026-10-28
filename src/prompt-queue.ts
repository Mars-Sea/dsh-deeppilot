/**
 * 运行中排队与转向（PROTOCOL.md「运行中排队与转向扩展」）的纯函数部分。
 *
 * 职责：
 * - Host `requestId` 与 wire `clientSendId` 的互转：Bridge 发送带 clientSendId 的
 *   prompt 时以 `dp:` 前缀拼出确定的 requestId，Host 把它记为用户来源的 `rpcId`；
 *   快照时反向剥掉前缀，发起设备即可把待发送项与队列项对上。
 * - 把 DSH `inbox` 投影（`{ "next-turn": Message[], "next-step": Message[] }`，
 *   来源是持久化的 `agent/inbox/spliced` 事件）折叠成 `s2c.session.queue` 的条目。
 *
 * 不持有状态：缓存、去重与推送时机在 host-bridge。
 */

import { validSendId } from './connection-policy.ts'
import { projectedDocument } from './document-payload.ts'
import type { SessionQueueItem } from './protocol.ts'

const REQUEST_ID_PREFIX = 'dp:'

/** 快照正文上限（Unicode 码点）。只用于列表展示，完整正文仍在 Host 日志里。 */
export const MAX_QUEUE_TEXT_CODE_POINTS = 4096

/** clientSendId -> Host requestId。 */
export function promptRequestId(clientSendId: string): string {
  return REQUEST_ID_PREFIX + clientSendId
}

/** Host 来源 rpcId -> clientSendId；不是本 Bridge 用 clientSendId 发出的返回 undefined。 */
export function clientSendIdOf(rpcId: unknown): string | undefined {
  if (typeof rpcId !== 'string' || !rpcId.startsWith(REQUEST_ID_PREFIX)) return undefined
  const id = rpcId.slice(REQUEST_ID_PREFIX.length)
  return validSendId(id) ? id : undefined
}

interface InboxMessageLike {
  id?: unknown
  content?: unknown
  source?: { kind?: unknown; rpcId?: unknown }
}

/**
 * inbox 投影 -> 队列条目，保持 Host 的先进先出顺序：先 `next-turn`（排队），
 * 再 `next-step`（转向）。值形状不对时返回 undefined，调用方据此不推送，
 * 而不是把「读不懂」当成「队列为空」——客户端会把消失的项当作已发出。
 */
export function projectQueue(value: unknown): SessionQueueItem[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const inbox = value as Record<string, unknown>
  const nextTurn = inbox['next-turn']
  const nextStep = inbox['next-step']
  if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return undefined
  const items: SessionQueueItem[] = []
  for (const [list, placement] of [[nextTurn, 'queued'], [nextStep, 'steering']] as const) {
    for (const message of list as InboxMessageLike[]) {
      const item = queueItemOf(message, placement)
      if (item) items.push(item)
    }
  }
  return items
}

function queueItemOf(message: InboxMessageLike, placement: SessionQueueItem['placement']): SessionQueueItem | undefined {
  if (message === null || typeof message !== 'object' || typeof message.id !== 'string' || message.id.length === 0) {
    return undefined
  }
  const texts: string[] = []
  let imageCount = 0
  let documentCount = 0
  for (const block of Array.isArray(message.content) ? message.content as Array<{ type?: unknown; text?: unknown }> : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'image') {
      imageCount += 1
    } else if (block.type === 'text' && typeof block.text === 'string') {
      // 文档以带标记的文本块随 prompt 发出（document-payload.ts）：计数，不进正文。
      if (projectedDocument(block.text) !== undefined) documentCount += 1
      else texts.push(block.text)
    }
  }
  const codePoints = Array.from(texts.join('\n'))
  const truncated = codePoints.length > MAX_QUEUE_TEXT_CODE_POINTS
  const source = message.source
  const clientSendId = source?.kind === 'user' ? clientSendIdOf(source.rpcId) : undefined
  return {
    itemId: message.id,
    placement,
    text: truncated ? codePoints.slice(0, MAX_QUEUE_TEXT_CODE_POINTS).join('') : codePoints.join(''),
    ...(truncated ? { truncated: true } : {}),
    imageCount,
    documentCount,
    ...(clientSendId !== undefined ? { clientSendId } : {}),
  }
}
