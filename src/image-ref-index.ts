/**
 * 会话图片引用索引：把手机只认识的 `attachmentId` 换回宿主读图所需的完整引用。
 *
 * 为什么需要：DSH 0.2.2 起 `sessions.attachment` 的参数从 `{sessionId, attachmentId}`
 * 改为 `{sessionId, attachment: ImageAttachmentRef}`，宿主按引用里的
 * mediaType/bytes/width/height 核对文件，且不再检查会话是否引用过这张图。手机协议
 * 只下发 attachmentId（不含 bytes），因此由 Bridge 记住它投影过的完整引用。
 *
 * 数据来源：实时 `session/event` 与 tail/history 读到的事件（见 eventImageRefs）。
 * 缓存未命中（插件重启、手机本地缓存了更早的消息）时按页向前扫会话历史，有页数上限。
 * 找不到即视为「本会话没有引用这张图」，调用方回 E_NOT_FOUND——这同时补上了新宿主
 * 不再做的会话归属校验。
 */
import type { SessionEventLike } from './host-api.ts'
import { eventImageRefs, type HostImageRef } from './host-event-projection.ts'

/** 缓存条目上限：引用只有几十字节，4096 条足够覆盖手机近期能看到的图片。 */
export const MAX_CACHED_IMAGE_REFS = 4096
/** 缓存未命中时最多向前扫的历史页数（每页最多 500 条消息）。 */
export const MAX_IMAGE_REF_SCAN_PAGES = 20

/** 读一页历史：beforeSeq 为排他边界，缺省读最新一页；失败返回 null。 */
export type HistoryPageReader = (sessionId: string, beforeSeq: number | undefined) =>
  Promise<{ events: SessionEventLike[]; hasMore: boolean } | null>

export class ImageRefIndex {
  /** 键为 `sessionId\0attachmentId`；Map 的插入顺序即 LRU 顺序。 */
  private readonly refs = new Map<string, HostImageRef>()
  /** 同一会话的并发回查共用一次扫描（冷启动时多张缩略图会同时请求）。 */
  private readonly scans = new Map<string, Promise<void>>()

  constructor(private readonly maxEntries = MAX_CACHED_IMAGE_REFS) {}

  /** 记下一批事件里的图片引用；对非图片事件是空操作。 */
  remember(sessionId: string, events: Iterable<SessionEventLike>): void {
    for (const event of events) {
      for (const ref of eventImageRefs(event)) this.put(sessionId, ref)
    }
  }

  /** 只查缓存，不触发扫描。 */
  peek(sessionId: string, attachmentId: string): HostImageRef | undefined {
    const key = keyOf(sessionId, attachmentId)
    const ref = this.refs.get(key)
    if (ref) {
      // 刷新 LRU 位置。
      this.refs.delete(key)
      this.refs.set(key, ref)
    }
    return ref
  }

  /** 缓存优先；未命中时扫描会话历史后再查一次。找不到返回 undefined。 */
  async resolve(sessionId: string, attachmentId: string, readPage: HistoryPageReader): Promise<HostImageRef | undefined> {
    const cached = this.peek(sessionId, attachmentId)
    if (cached) return cached
    let scan = this.scans.get(sessionId)
    if (!scan) {
      scan = this.scan(sessionId, readPage).finally(() => this.scans.delete(sessionId))
      this.scans.set(sessionId, scan)
    }
    await scan
    return this.peek(sessionId, attachmentId)
  }

  private async scan(sessionId: string, readPage: HistoryPageReader): Promise<void> {
    let beforeSeq: number | undefined
    for (let page = 0; page < MAX_IMAGE_REF_SCAN_PAGES; page++) {
      const result = await readPage(sessionId, beforeSeq)
      if (!result || result.events.length === 0) return
      this.remember(sessionId, result.events)
      const oldest = Math.min(...result.events.map(event => event.seq))
      // 边界不前进就停：宿主若重复返回同一页，继续扫只会原地打转。
      if (!result.hasMore || !Number.isFinite(oldest) || (beforeSeq !== undefined && oldest >= beforeSeq)) return
      beforeSeq = oldest
    }
  }

  private put(sessionId: string, ref: HostImageRef): void {
    const key = keyOf(sessionId, ref.attachmentId)
    this.refs.delete(key)
    this.refs.set(key, ref)
    while (this.refs.size > this.maxEntries) {
      const oldest = this.refs.keys().next().value
      if (oldest === undefined) break
      this.refs.delete(oldest)
    }
  }
}

function keyOf(sessionId: string, attachmentId: string): string {
  return `${sessionId}\u0000${attachmentId}`
}
