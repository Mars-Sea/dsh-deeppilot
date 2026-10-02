/**
 * at-most-once dispatch journal：prompt 投递与非 prompt 变更的**同一个** module。
 *
 * 迁移前 `prompt-delivery.ts` 与 `mutation-journal.ts` 是同一份耐久协议的两份
 * 拷贝（盘点结论：key/expired/save 骨架字节级相同，mutation 甚至反向 import
 * prompt 的 validSendId，共享已从错误方向发生）。两者的差别集中在六个面：
 * 指纹覆盖范围、条目字段、回执形状、id 校验、lookup、落盘容器格式——全部收进
 * 注入的 codec；核心只留耐久协议。
 *
 * 核心拥有：key 派生、原子写盘（temp + fsync + rename + 目录 fsync）、加载与
 * 逐字段校验、保留清扫、容量、healthy 降级、在途去重、opener 单例。
 *
 * codec 拥有：一次投递的全部「方言」。它同时是两个 adapter——prompt 回执与
 * mutation 结果——因此这条缝是真的，不是假想的。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { validSendId } from './connection-policy.ts'
import { ERROR_CODES, type WireErrorCode } from './wire-errors.ts'

/** 落盘条目：两个通用字段 + codec 私有字段。 */
export interface JournalEntry {
  fingerprint: string
  createdAt: number
  [field: string]: unknown
}

/** operation 的结果：成功带值，失败带 wire 错误码。 */
export type OperationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; code: WireErrorCode; message?: string }

/**
 * 一切「不看条目就能定」的结果类别。codec 用一个方法把它们翻译成自己的方言，
 * 而不是让核心知道任何一方的形状。
 */
export type DispatchOutcome =
  /** 命中既有条目（重放）。 */
  | { kind: 'replay'; entry: JournalEntry }
  /** 同一 id 搭不同内容。 */
  | { kind: 'mismatch' }
  /** 文件损坏 / 目录不可造，journal 已降级。 */
  | { kind: 'unavailable' }
  /** id 的纪元前缀超出保留窗口。 */
  | { kind: 'expired' }
  /** 条目数已达容量上限。 */
  | { kind: 'full' }
  /** 刚跑完的那一次：operation 的结果原样带出（不标 replayed）。 */
  | { kind: 'ran'; entry: JournalEntry; result: OperationResult }
  /** operation 抛错：条目保持 unknown，且不得自动重试。 */
  | { kind: 'crashed' }
  /** 预留条目时写盘失败。 */
  | { kind: 'reserve-failed' }
  /** id 形状不合法（仅 mutation 变体开启这道守卫）。 */
  | { kind: 'invalid-id' }

export interface DispatchCodec<TRequest = unknown, TResult = unknown> {
  /** 实例身份：opener 单例键的一部分（含 persistValues 等变体差异）。 */
  readonly identity: string
  /** 请求指纹。prompt 覆盖 [sessionId, content]；mutation 只覆盖 content。 */
  fingerprint(request: TRequest): string
  /** 预留条目时写入的 codec 字段（fingerprint/createdAt 由核心补）。 */
  reserve(request: TRequest, id: string): Record<string, unknown>
  /** operation 成功后就地更新条目。 */
  accepted(entry: JournalEntry, id: string, value: unknown): void
  /** operation 失败后就地更新条目。 */
  rejected(entry: JournalEntry, id: string, code: WireErrorCode): void
  /** 把结果类别翻译成调用方言。 */
  resultOf(outcome: DispatchOutcome, id: string): TResult
  /** id 非法时是否先拒掉（mutation 是；prompt 由 wire 层保证，故否）。 */
  readonly requiresValidId?: boolean
  /** lookup 的匹配规则；缺省表示该实例不提供 lookup。 */
  matches?(entry: JournalEntry, request: unknown): boolean
  /** lookup 未命中时回什么（prompt 要区分 notFound / expired）。 */
  miss?(id: string, expired: boolean): TResult
  /** 落盘容器 → 内存条目表；任何不合法都抛错（核心转成 healthy=false）。 */
  parse(raw: unknown): Record<string, JournalEntry>
  /** 内存条目表 → 落盘容器。 */
  serialize(entries: Record<string, JournalEntry>): unknown
}

export interface DispatchJournalOptions<TRequest = unknown, TResult = unknown> {
  codec: DispatchCodec<TRequest, TResult>
  path?: string
  /** 落盘体积上限：prompt 8MB、mutation 4MB（由条目实际大小决定，不统一）。 */
  maxFileBytes?: number
  capacity?: number
  retentionMs?: number
  /**
   * 并发重复是否搭同在途那次。prompt 是（重复方拿到同一个最终回执）；
   * mutation 否（重复方立刻拿到 unknown → E_INTERNAL）。两者都由对等快照钉住。
   */
  joinInFlight?: boolean
}

const DEFAULT_CAPACITY = 10_000
const DEFAULT_RETENTION_MS = 7 * 24 * 3600 * 1000
/** 比保留窗口多宽限 5 分钟：边界附近的条目不会被反复删了又写。 */
const SWEEP_GRACE_MS = 5 * 60 * 1000

/** Durable at-most-once dispatch. Unknown outcomes are never automatically retried. */
export class DispatchJournal<TRequest = unknown, TResult = unknown> {
  private entries: Record<string, JournalEntry> = Object.create(null)
  private inFlight = new Map<string, Promise<TResult>>()
  private healthy = true
  private readonly maxFileBytes: number
  private readonly capacity: number
  private readonly retentionMs: number
  private readonly joinInFlight: boolean

  constructor(private readonly options: DispatchJournalOptions<TRequest, TResult>) {
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.joinInFlight = options.joinInFlight ?? true
    const path = options.path
    if (path === undefined || !existsSync(path)) return
    try {
      if (statSync(path).size > this.maxFileBytes) throw new Error('oversized journal')
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; entries?: unknown }
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > this.capacity) {
        throw new Error('invalid journal')
      }
      const loaded = this.options.codec.parse(parsed.entries)
      for (const key of Object.keys(loaded)) this.entries[key] = loaded[key]!
    } catch {
      // 任何不合法都让 journal 降级：宁可拒绝新投递，也不要按错格式续写。
      this.healthy = false
    }
  }

  private key(deviceId: string, id: string): string {
    return createHash('sha256').update(JSON.stringify([deviceId, id])).digest('hex')
  }

  /** id 的纪元前缀是否还在保留窗口内（未来 5 分钟以上同样算非法）。 */
  private expired(id: string, now = Date.now()): boolean {
    const age = now - Number(id.slice(0, 13))
    return age > this.retentionMs || age < -SWEEP_GRACE_MS
  }

  private save(): void {
    const path = this.options.path
    if (path === undefined) return
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, entries: this.options.codec.serialize(this.entries) }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    const dir = openSync(dirname(path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

  /** 查询既有回执；`request` 交给 codec 的 matches 判定（缺省即不提供 lookup）。 */
  lookup(deviceId: string, id: string, request?: unknown): TResult | undefined {
    const codec = this.options.codec
    if (codec.matches === undefined) return undefined
    if (!this.healthy) return codec.resultOf({ kind: 'unavailable' }, id)
    const entry = this.entries[this.key(deviceId, id)]
    if (entry !== undefined && codec.matches(entry, request)) return codec.resultOf({ kind: 'replay', entry }, id)
    return codec.miss?.(id, this.expired(id)) ?? codec.resultOf({ kind: 'unavailable' }, id)
  }

  /**
   * 幂等投递。未知结果绝不自动重试：条目保持 unknown，重放时由 codec 决定
   * 调用方看到什么。
   */
  async dispatch(deviceId: string, id: string, request: TRequest, operation: () => Promise<OperationResult>): Promise<TResult> {
    const codec = this.options.codec
    // id 守卫在最前（与迁移前 mutation 的次序一致）：形状非法的请求不落盘。
    if (codec.requiresValidId === true && !validSendId(id)) {
      return codec.resultOf({ kind: 'invalid-id' }, id)
    }
    const key = this.key(deviceId, id)
    const fingerprint = codec.fingerprint(request)
    const existing = this.entries[key]
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) return codec.resultOf({ kind: 'mismatch' }, id)
      // 搭同在途那次（prompt）：并发重复共享一次上游调用，拿同一最终回执。
      const pending = this.inFlight.get(key)
      if (this.joinInFlight && pending !== undefined) return pending
      return codec.resultOf({ kind: 'replay', entry: existing }, id)
    }
    if (!this.healthy) return codec.resultOf({ kind: 'unavailable' }, id)
    if (this.expired(id)) return codec.resultOf({ kind: 'expired' }, id)

    const now = Date.now()
    for (const [entryKey, entry] of Object.entries(this.entries)) {
      if (now - entry.createdAt > this.retentionMs + SWEEP_GRACE_MS && !this.inFlight.has(entryKey)) {
        delete this.entries[entryKey]
      }
    }
    if (Object.keys(this.entries).length >= this.capacity) return codec.resultOf({ kind: 'full' }, id)

    // 先落盘预约再跑上游：进程在两次之间死掉，重启后也能识别「结果未知」。
    const entry: JournalEntry = { fingerprint, createdAt: Number(id.slice(0, 13)), ...codec.reserve(request, id) }
    this.entries[key] = entry
    try { this.save() } catch {
      this.healthy = false
      return codec.resultOf({ kind: 'reserve-failed' }, id)
    }

    const run = (async (): Promise<TResult> => {
      let ran: OperationResult
      try {
        ran = await operation()
        if (ran.ok) codec.accepted(entry, id, ran.value)
        else codec.rejected(entry, id, ran.code)
      } catch {
        // 上游可能在传输失败前已经接受：条目保持 unknown，绝不自动重试。
        return codec.resultOf({ kind: 'crashed' }, id)
      }
      try { this.save() } catch { this.healthy = false }
      // 刚跑完的那一次：operation 的结果原样带出，不标 replayed。
      return codec.resultOf({ kind: 'ran', entry, result: ran }, id)
    })()
    this.inFlight.set(key, run)
    try { return await run } finally { this.inFlight.delete(key) }
  }

  /** 等所有在途投递结束；供进程收尾。 */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()])
    }
  }
}

// ---------- opener ----------

const journals = new Map<string, DispatchJournal<never, never>>()

/**
 * 按 path + codec 身份取单例。身份进键是必要的：同一路径用不同 codec/persistValues
 * 打开必须得到不同实例——迁移前的键只有 path，`persistValues` 因此会被静默忽略。
 */
export function openDispatchJournal<TRequest, TResult>(
  options: DispatchJournalOptions<TRequest, TResult>,
): DispatchJournal<TRequest, TResult> {
  const { path, codec } = options
  if (path === undefined) {
    return new DispatchJournal<TRequest, TResult>(options)
  }
  const cacheKey = path + '|' + codec.identity
  const cached = journals.get(cacheKey)
  if (cached !== undefined) return cached as unknown as DispatchJournal<TRequest, TResult>
  const journal = new DispatchJournal<TRequest, TResult>(options)
  journals.set(cacheKey, journal as unknown as DispatchJournal<never, never>)
  return journal
}

// ---------- prompt 投递 codec ----------

/** prompt 投递的回执：手机侧按 clientSendId 对账。 */
export type DeliveryStatus = 'accepted' | 'rejected' | 'unknown' | 'notFound' | 'expired'
export interface DeliveryReceipt {
  clientSendId: string
  status: DeliveryStatus
  userSeq?: number
  code?: string
}

/** prompt 的落盘条目：回执内嵌，sessionId 单独存一份供 lookup 比对。 */
interface PromptEntry extends JournalEntry {
  sessionId: string
  receipt: DeliveryReceipt
}

/** 受理即 accepted；四种会被 APNs 终态清理的失败码之外一律原样上抛。 */
const PROMPT_RECEIPT_CODES = ['E_BUSY', 'E_NOT_FOUND', 'E_PROTOCOL', 'E_UNSUPPORTED'] as const

/**
 * prompt 投递方言：
 * - 指纹覆盖 [sessionId, content]（同一条 prompt 换会话重发视为不同请求）；
 * - 并发重复搭同在途那次（joinInFlight），因此重复方拿到同一最终回执；
 * - 有 lookup，且 sessionId 不匹配即视为未命中；
 * - 落盘是 [key, entry] 二元组数组（历史格式，零迁移）。
 */
export const promptDeliveryCodec: DispatchCodec<
  { sessionId: string; content: unknown },
  DeliveryReceipt
> & { identity: string } = {
  identity: 'prompt-delivery',
  fingerprint: (request) => createHash('sha256')
    .update(JSON.stringify([request.sessionId, request.content]))
    .digest('hex'),
  reserve: (request, id) => ({
    sessionId: request.sessionId,
    receipt: { clientSendId: id, status: 'unknown' },
  }),
  accepted: (entry, id, value) => {
    const receipt = entry.receipt as DeliveryReceipt
    entry.receipt = { clientSendId: id, status: 'accepted', userSeq: value as number }
  },
  rejected: (entry, id, code) => {
    const receipt = entry.receipt as DeliveryReceipt
    entry.receipt = { clientSendId: id, status: 'rejected', code }
  },
  resultOf: (outcome, id) => {
    switch (outcome.kind) {
      case 'replay':
      case 'ran': return (outcome.entry.receipt ?? { clientSendId: id, status: 'unknown' }) as DeliveryReceipt
      case 'mismatch': return { clientSendId: id, status: 'rejected', code: 'E_PROTOCOL' }
      case 'unavailable':
      case 'crashed':
      case 'reserve-failed': return { clientSendId: id, status: 'unknown' }
      case 'expired': return { clientSendId: id, status: 'expired' }
      case 'full': return { clientSendId: id, status: 'rejected', code: 'E_BUSY' }
      case 'invalid-id': return { clientSendId: id, status: 'rejected', code: 'E_PROTOCOL' }
    }
  },
  // prompt 不做 id 守卫：wire 层已在 validateRequest/行内校验保证形状。
  requiresValidId: false,
  matches: (entry, request) => entry.sessionId === request,
  miss: (id, expired) => ({ clientSendId: id, status: expired ? 'expired' : 'notFound' }),
  parse: (raw) => {
    const out: Record<string, JournalEntry> = Object.create(null)
    for (const [key, value] of raw as Array<[string, PromptEntry]>) {
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || !value || typeof value.sessionId !== 'string' ||
          !Number.isFinite(value.createdAt) || typeof value.fingerprint !== 'string' ||
          !validSendId(value.receipt?.clientSendId) ||
          !['accepted', 'rejected', 'unknown'].includes(value.receipt.status)) throw new Error('invalid entry')
      if (!/^[a-f0-9]{64}$/.test(value.fingerprint) ||
          value.createdAt !== Number(value.receipt.clientSendId.slice(0, 13)) ||
          (value.receipt.status === 'accepted' && !Number.isSafeInteger(value.receipt.userSeq)) ||
          (value.receipt.status === 'rejected' && !(PROMPT_RECEIPT_CODES as readonly string[]).includes(String(value.receipt.code)))) {
        throw new Error('invalid receipt')
      }
      out[key] = value
    }
    return out
  },
  serialize: (entries) => Object.entries(entries).map(([key, entry]) => [key, entry]),
}

// ---------- schedule/fork mutation codec ----------

/** mutation 的结果：replayed 让调用方知道这是重放而非新执行。 */
export type MutationErrorCode = WireErrorCode

export type MutationOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MutationErrorCode; message?: string }

export type MutationDispatchResult<T> =
  | { ok: true; value?: T; replayed?: boolean }
  | { ok: false; code: MutationErrorCode; message?: string; replayed?: boolean }

interface MutationEntry extends JournalEntry {
  status: 'accepted' | 'rejected' | 'unknown'
  code?: MutationErrorCode
  value?: unknown
}

/**
 * mutation 方言（schedule 与 fork 共用，fork 打开 persistValues）：
 * - 有 id 守卫，且在最前面（形状非法的 clientRequestId 不落盘）；
 * - 并发重复不搭在途那次：重复方立刻拿到 unknown → E_INTERNAL「不得自动重试」；
 * - 成功值只在 persistValues 时落盘——fork 需要重启后仍能重放 sessionId，
 *   schedule 的 authoritative 资源由客户端重新拉取，不在此复制第二份；
 * - 落盘是对象数组（历史格式，零迁移）。
 */
export function scheduleMutationCodec(persistValues: boolean): DispatchCodec<unknown, MutationDispatchResult<unknown>> & { identity: string } {
  const isErrorCode = (value: unknown): value is MutationErrorCode =>
    typeof value === 'string' && value in ERROR_CODES
  return {
    identity: 'mutation:' + (persistValues ? 'persist' : 'memory'),
    fingerprint: (request) => createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    reserve: () => ({ status: 'unknown' }),
    accepted: (entry, _id, value) => {
      entry.status = 'accepted'
      if (persistValues) entry.value = value
    },
    rejected: (entry, _id, code) => {
      entry.status = 'rejected'
      entry.code = code
    },
    resultOf: (outcome, id) => {
      switch (outcome.kind) {
        case 'ran': return outcome.result as MutationDispatchResult<unknown>
        case 'replay': {
          const entry = outcome.entry as MutationEntry
          if (entry.status === 'accepted') return { ok: true, value: entry.value, replayed: true }
          if (entry.status === 'rejected' && entry.code !== undefined) return { ok: false, code: entry.code, replayed: true }
          return { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically', replayed: true }
        }
        case 'mismatch': return { ok: false, code: 'E_PROTOCOL', message: 'clientRequestId was reused with different content', replayed: true }
        case 'invalid-id': return { ok: false, code: 'E_PROTOCOL', message: 'invalid clientRequestId' }
        case 'unavailable': return { ok: false, code: 'E_INTERNAL', message: 'mutation journal unavailable' }
        case 'expired': return { ok: false, code: 'E_PROTOCOL', message: 'clientRequestId is outside the retry window' }
        case 'full': return { ok: false, code: 'E_BUSY', message: 'mutation journal is full' }
        case 'reserve-failed': return { ok: false, code: 'E_INTERNAL', message: 'mutation journal could not persist the request' }
        case 'crashed': return { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically' }
      }
    },
    requiresValidId: true,
    // mutation 没有 lookup：权威资源由客户端重新拉取。
    parse: (raw) => {
      const out: Record<string, JournalEntry> = Object.create(null)
      for (const value of raw as MutationEntry[]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mutation entry')
        const entry = value as Record<string, unknown>
        if (typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
            typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) ||
            !['accepted', 'rejected', 'unknown'].includes(String(entry.status))) throw new Error('invalid mutation entry')
        if (entry.status === 'rejected' && !isErrorCode(entry.code)) throw new Error('invalid mutation code')
        const key = String((value as { key?: unknown }).key)
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid mutation key')
        out[key] = {
          fingerprint: entry.fingerprint as string,
          createdAt: entry.createdAt as number,
          status: entry.status as MutationEntry['status'],
          ...(isErrorCode(entry.code) ? { code: entry.code } : {}),
          ...(persistValues && entry.value !== undefined ? { value: entry.value } : {}),
        }
      }
      return out
    },
    serialize: (entries) => Object.entries(entries).map(([key, entry]) => ({ key, ...entry })),
  }
}
