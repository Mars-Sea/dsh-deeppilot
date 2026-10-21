/**
 * 连接诊断事件模型（Diagnostics）——插件唯一的「失败可观测」面。
 *
 * 为什么需要独立模块：本插件的日志出口原先是 `apply()` 里的一个闭包
 * （`console.log('[deeppilot] ' + message)`），无时间戳、无级别、无来源；
 * 连接被拒、认证失败、TLS 握手失败都各自静默结束，用户在设置页只看到
 * 「连不上」三个字。把事件模型、节流、环形缓冲与落盘收在这里，目的有三：
 *
 * 1. 一次失败 = 一条结构化事件（时间戳 + kind + reason + 来源哈希 +
 *    可选 attemptId / 关闭码 / 耗时），微信、tailscale、扫描器刷屏时仍
 *    只留可读的十几行；
 * 2. index.ts / connection-gate.ts / phone-server.ts / connection.ts 四个
 *    入口共用同一个 `record(kind, reason, extra)`，失败路径不再各自发明
 *    日志文案；
 * 3. 环形 256 条 + 按天落盘（保留 7 天、目录上限 5MB）让「刚刚那次连不上」
 *    在重启前后都能查；`recent()` / `lastFailure()` 同时供 `/phone/health`
 *    与设置页诊断区块读取。
 *
 * 硬约束（与 AGENTS.md 一致）：
 * - 事件里只出现 auditLabel 产生的来源哈希，绝不出现原始 IP；
 * - attemptId 只记录、不校验、不参与任何准入判断；长度 ≤16，字符集
 *   `[A-Za-z0-9_-]`，来源不可信（WS query `at` / HTTP header
 *   `X-DeepPilot-Attempt`）；
 * - 不打印配对码、公钥原文、APNs token、relay 凭据与消息正文。detail
 *   字段只接受代码生成的短文本（如 socket 错误码），最长 160 字符。
 *
 * 与 `diagnostics.debug` 的关系：本模块的事件**无条件记录**。那个开关只
 * 控制现有的 per-frame / 推送日志，失败事件若也绑到它上面，用户不开调试
 * 开关就永远看不到为什么连不上——这正是本轮要修的 P0。
 */

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// ---------- 日志行 ----------

/** 日志级别：失败一律 warn，成功与状态变更 info。 */
export type LogLevel = 'info' | 'warn'

/**
 * 统一日志行格式：`[deeppilot] <ISO 时间戳> <LEVEL> <message>`。
 *
 * 时间戳是 P0 的可观测性基线：没有它，用户贴回来的日志无法与手机端时间
 * 对齐，也无法判断「刚才那次」是哪一次。ISO-8601（UTC）避免时区误读。
 */
export function formatLogLine(level: LogLevel, message: string, at: number = Date.now()): string {
  return `[deeppilot] ${new Date(at).toISOString()} ${level.toUpperCase()} ${message}`
}

/**
 * 插件日志函数。单参调用即 info；失败路径显式传 'warn'。
 * 返回值的双参签名可以安全地传给只接受 `(message: string) => void` 的
 * 既有依赖（PushGateway / HostBridge / 两个 transport 行）。
 */
export function createLogger(): (message: string, level?: LogLevel) => void {
  return (message: string, level: LogLevel = 'info'): void => {
    console.log(formatLogLine(level, message))
  }
}

// ---------- 事件模型 ----------

/** 事件类型：覆盖一次握手从传输层到认证层的全部可失败点。 */
export type DiagnosticKind =
  /** WS upgrade 在建立 socket 之前被拒（禁用、名额、降级、限流）。 */
  | 'upgrade-rejected'
  /** HTTP 配对请求被拒（码无效、注册表满、限流）。 */
  | 'pair-rejected'
  /** c2s.auth.prove 失败（4401 分因）或 hello 超时（4402）。 */
  | 'auth-failed'
  /** 一条 WS 连接建立成功。 */
  | 'connection-opened'
  /** 非正常关闭（关闭码不是 1000/1001）。 */
  | 'connection-closed'
  /** socket 层 error（ws.on('error') / TLS client error / HTTP clientError）。 */
  | 'connection-error'
  /** Host 身份 / LAN TLS 身份的新建、重建或读取异常。 */
  | 'identity'
  /** 设备注册表落盘失败。 */
  | 'storage'

/** 一条诊断事件。字段刻意保持扁平、可 JSON 序列化。 */
export interface DiagnosticEvent {
  /** 事件发生时刻（Unix ms）。 */
  ts: number
  kind: DiagnosticKind
  /** 分因枚举，形如 `nonce-mismatch` / `too-many-connections`；代码内常量。 */
  reason: string
  /** 客户端自带的尝试 id（仅用于串联一次握手的多条日志）。 */
  attemptId?: string
  /** 来源的审计哈希（auditLabel），不是原始 IP。 */
  source?: string
  /** WS 关闭码；只在有 socket 的事件上出现。 */
  closeCode?: number
  /** 从建连到关闭的存活时长（毫秒）。 */
  durationMs?: number
  /** 关闭时这条连接是否已通过认证。 */
  authenticated?: boolean
  /** 代码生成的短说明（socket 错误码等），已去控制字符并截断。 */
  detail?: string
  /** 日志级别；不进入 report wire，只用于本地筛选「最近失败」。 */
  level: LogLevel
}

/** record 的可选附加信息。 */
export interface DiagnosticExtra {
  attemptId?: string
  source?: string
  closeCode?: number
  durationMs?: number
  authenticated?: boolean
  detail?: string
  /** 覆盖默认级别：成功事件（连接建立、host-id 新建）用 'info'。 */
  level?: LogLevel
}

/**
 * 四个入口（index / connection-gate / phone-server / connection）共用的
 * 最小记录面。依赖方只拿这个接口，单测可以用一个收数组的假实现替换整个
 * 落盘与节流机制。
 */
export type DiagnosticsRecorder = Pick<DiagnosticsStore, 'record'>

const MAX_DETAIL_CHARS = 160
const MAX_REASON_CHARS = 64
const DEFAULT_CAPACITY = 256
/** 同 kind + reason + source 在 60 秒内只输出一行。 */
const DEFAULT_THROTTLE_MS = 60_000
/** 日志目录总量上限：超过后停止落盘，但内存环形与终端日志继续工作。 */
export const MAX_DIAGNOSTICS_BYTES = 5 * 1024 * 1024
/** 按天滚动文件保留的日历天数（含今天）。 */
export const DIAGNOSTICS_RETENTION_DAYS = 7

const INFO_KINDS: ReadonlySet<DiagnosticKind> = new Set(['connection-opened'])

function defaultLevel(kind: DiagnosticKind): LogLevel {
  return INFO_KINDS.has(kind) ? 'info' : 'warn'
}

/** 事件文本一律单行：换成空格并去掉控制字符，避免日志被注入换行。 */
function sanitizeText(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

function normalizeReason(reason: string): string {
  // reason 是代码内常量；仍然收敛一次，防止未来有人把上游错误消息塞进来。
  return sanitizeText(reason, MAX_REASON_CHARS).replace(/\s+/g, '-')
}

/**
 * 来源只允许短标识（auditLabel 的 12 位十六进制）。原始 IP 含 `.` / `:`，
 * 会在这一步被丢弃——即便某个调用方忘了哈希，也不会有 IP 落进日志。
 */
function normalizeSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined
}

// ---------- attemptId（不可信输入） ----------

export const ATTEMPT_ID_HEADER = 'x-deeppilot-attempt'
/** 只允许 URL 安全字符，最长 16：记录用，永不回显或参与判定。 */
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

/** 归一化一个客户端提供的 attemptId；不合法即丢弃（不报错、不拒绝请求）。 */
export function normalizeAttemptId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return ATTEMPT_ID_PATTERN.test(value) ? value : undefined
}

/**
 * 从一条 HTTP / WS 升级请求里取 attemptId。
 *
 * 优先 HTTP header（真实 HTTP 客户端可自由设置），其次 WS 升级 URL 的
 * `?at=`（浏览器 / URLSession 的 WS 握手无法自定义 header）。两个来源都
 * 经过同一份长度与字符集校验；任何异常（畸形 URL、数组头）都按「没有
 * attemptId」处理——这是纯观测字段，绝不能因为它让握手失败。
 */
export function attemptIdFromRequest(request: {
  url?: string | undefined
  headers?: Readonly<Record<string, string | string[] | undefined>> | undefined
}): string | undefined {
  const header = request.headers?.[ATTEMPT_ID_HEADER]
  const fromHeader = normalizeAttemptId(Array.isArray(header) ? header[0] : header)
  if (fromHeader !== undefined) return fromHeader
  if (typeof request.url !== 'string' || request.url.length === 0) return undefined
  try {
    return normalizeAttemptId(new URL(request.url, 'http://phone.local').searchParams.get('at'))
  } catch {
    return undefined
  }
}

// ---------- 事件存储 ----------

export interface DiagnosticsOptions {
  /** 落盘目录（插件数据目录下的 diagnostics/）；缺省时只保留内存环形。 */
  dir?: string
  /** 环形缓冲上限，默认 256。 */
  capacity?: number
  /** 同 kind+reason+source 的日志节流窗口，默认 60s。 */
  throttleMs?: number
  /** 时钟注入（测试用）。 */
  now?: () => number
  /** 日志输出注入（测试用）；缺省 console.log。 */
  write?: (line: string) => void
}

interface ThrottleEntry {
  lastTs: number
  /** 上次输出之后被抑制的事件数；恢复输出时带在行尾。 */
  suppressed: number
}

/**
 * 内存环形 + 节流日志 + 按天落盘。
 *
 * 职责边界：它不做任何策略判断（不决定是否拒绝连接），只负责把调用方
 * 已经判定的失败事实记下来。因此它可以在四个入口之间安全共用。
 */
export class DiagnosticsStore {
  private readonly events: DiagnosticEvent[] = []
  private readonly throttles = new Map<string, ThrottleEntry>()
  private readonly capacity: number
  private readonly throttleMs: number
  private readonly now: () => number
  private readonly write: (line: string) => void
  private readonly dir: string | undefined
  private tail: Promise<void> = Promise.resolve()
  /** 已统计过的文件大小，避免每次 append 前都 stat。 */
  private readonly fileSizes = new Map<string, number>()
  private directoryBytes = 0
  /** 最近一次执行过保留期清理的 UTC 日期（YYYY-MM-DD）。 */
  private prunedDay: string | undefined
  /** 落盘自身失败只报一次：否则磁盘满会把日志刷成新的刷屏源。 */
  private writeFailureReported = false

  constructor(options: DiagnosticsOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
    this.now = options.now ?? Date.now
    this.write = options.write ?? ((line: string) => { console.log(line) })
    this.dir = options.dir
  }

  /**
   * 记录一条事件。事件总是进入内存环形；终端日志与落盘按
   * kind + reason + source 节流（60s 一行，恢复时标注 suppressed 次数）。
   * 返回完整事件，方便调用方测试与断言。
   */
  record(kind: DiagnosticKind, reason: string, extra: DiagnosticExtra = {}): DiagnosticEvent {
    const ts = this.now()
    // attemptId 来自客户端：在这里再收敛一次，任何入口传进来的非法值都丢弃。
    const attemptId = normalizeAttemptId(extra.attemptId)
    const source = normalizeSource(extra.source)
    const event: DiagnosticEvent = {
      ts,
      kind,
      reason: normalizeReason(reason),
      level: extra.level ?? defaultLevel(kind),
      ...(attemptId !== undefined ? { attemptId } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(extra.closeCode !== undefined ? { closeCode: extra.closeCode } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(extra.durationMs)) } : {}),
      ...(extra.authenticated !== undefined ? { authenticated: extra.authenticated } : {}),
      ...(extra.detail !== undefined ? { detail: sanitizeText(extra.detail, MAX_DETAIL_CHARS) } : {}),
    }

    this.events.push(event)
    while (this.events.length > this.capacity) this.events.shift()

    const throttleKey = `${kind}\u0000${event.reason}\u0000${event.source ?? '-'}`
    const previous = this.throttles.get(throttleKey)
    let suppressed = 0
    if (previous !== undefined && ts - previous.lastTs < this.throttleMs) {
      previous.suppressed += 1
      return event
    }
    if (previous !== undefined) suppressed = previous.suppressed
    this.throttles.set(throttleKey, { lastTs: ts, suppressed: 0 })

    this.write(formatEventLine(event, suppressed))
    this.persist(event, suppressed)
    return event
  }

  /** 最近 `limit` 条事件（时间升序），供 health / report / 测试读取。 */
  recent(limit = 20): DiagnosticEvent[] {
    const size = Math.max(0, Math.trunc(limit))
    return this.events.slice(-size)
  }

  /** 最近 `limit` 条失败事件（warn 级），新→旧排序前的升序切片。 */
  recentFailures(limit = 10): DiagnosticEvent[] {
    const failures = this.events.filter((event) => event.level === 'warn')
    const size = Math.max(0, Math.trunc(limit))
    return failures.slice(-size)
  }

  /** 最近一条失败事件；没有失败时 undefined。 */
  lastFailure(): DiagnosticEvent | undefined {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]
      if (event !== undefined && event.level === 'warn') return event
    }
    return undefined
  }

  /** 等价于「诊断面板复制」/health 需要的最近失败摘要。 */
  lastFailureSummary(): Pick<DiagnosticEvent, 'kind' | 'reason' | 'ts'> | undefined {
    const failure = this.lastFailure()
    return failure === undefined ? undefined : { kind: failure.kind, reason: failure.reason, ts: failure.ts }
  }

  /** 等待所有排队中的落盘完成（测试与进程收尾用）。 */
  async flush(): Promise<void> {
    await this.tail
  }

  /** 进程收尾：不再有新的写入队列，等待既有写入落盘。 */
  async dispose(): Promise<void> {
    await this.flush()
  }

  // ---------- 落盘 ----------

  /**
   * 追加一行 JSONL。写入串行、失败静默（只报一次），绝不阻塞调用方——
   * 诊断日志不能反过来拖慢或搞崩握手路径。
   */
  private persist(event: DiagnosticEvent, suppressed: number): void {
    const dir = this.dir
    if (dir === undefined) return
    const day = utcDay(event.ts)
    const path = join(dir, `diagnostics-${day}.jsonl`)
    const payload = suppressed > 0 ? { ...event, suppressed } : event
    const line = JSON.stringify(payload) + '\n'
    const bytes = Buffer.byteLength(line)

    this.tail = this.tail.then(async () => {
      try {
        await this.prepareDirectory(dir, day)
        const knownSize = this.fileSizes.get(path)
        const currentSize = knownSize ?? await stat(path).then((info) => info.size).catch(() => 0)
        this.fileSizes.set(path, currentSize)
        if (this.directoryBytes + bytes > MAX_DIAGNOSTICS_BYTES) return
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await appendFile(path, line, { mode: 0o600 })
        this.fileSizes.set(path, currentSize + bytes)
        this.directoryBytes += bytes
      } catch (error) {
        this.reportWriteFailure(error)
      }
    })
    this.tail = this.tail.catch(() => {})
  }

  /**
   * 每天第一次落盘时清理保留期之外的文件并统计目录大小；同时限制目录
   * 总量（5MB）。清理失败不影响当次写入。
   */
  private async prepareDirectory(dir: string, day: string): Promise<void> {
    if (this.prunedDay === day) return
    const names = await readdir(dir).catch(() => [] as string[])
    const cutoffDay = utcDayMinus(day, DIAGNOSTICS_RETENTION_DAYS - 1)
    let total = 0
    for (const name of names) {
      const match = /^diagnostics-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (match === null) continue
      const full = join(dir, name)
      if (match[1] !== undefined && match[1] < cutoffDay) {
        await unlink(full).catch(() => {})
        this.fileSizes.delete(full)
        continue
      }
      const size = await stat(full).then((info) => info.size).catch(() => 0)
      this.fileSizes.set(full, size)
      total += size
    }
    this.directoryBytes = total
    this.prunedDay = day
  }

  private reportWriteFailure(error: unknown): void {
    if (this.writeFailureReported) return
    this.writeFailureReported = true
    this.write(formatLogLine('warn', 'diagnostics write failed: ' + sanitizeText(String(error), MAX_DETAIL_CHARS)))
  }
}

/** 一条事件的终端日志文本（不含前缀时间戳，由 formatLogLine 统一加）。 */
function formatEventLine(event: DiagnosticEvent, suppressed: number): string {
  const parts: string[] = [event.kind, event.reason]
  if (event.source !== undefined) parts.push('src=' + event.source)
  if (event.attemptId !== undefined) parts.push('attempt=' + event.attemptId)
  if (event.closeCode !== undefined) parts.push('code=' + String(event.closeCode))
  if (event.durationMs !== undefined) parts.push('durationMs=' + String(event.durationMs))
  if (event.authenticated !== undefined) parts.push('auth=' + (event.authenticated ? 'yes' : 'no'))
  if (suppressed > 0) parts.push('suppressed=' + String(suppressed))
  if (event.detail !== undefined) parts.push('detail=' + event.detail)
  return formatLogLine(event.level, parts.join(' '), event.ts)
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** 日期字符串（YYYY-MM-DD）往前推 `days` 天；保留期计算用。 */
function utcDayMinus(day: string, days: number): string {
  const date = new Date(day + 'T00:00:00.000Z')
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

// ---------- /phone/health 载荷 ----------

export interface HealthPayloadInput {
  /** 插件 apply() 的启动时刻。 */
  startedAt: number
  enabled: boolean
  protocolVersion: number
  serverVersion: string
  /** 数据面（HostBridge）是否已经挂上。 */
  dataPlaneActive: boolean
  /** LAN 传输相位与端口；来自 TransportReconciler.status()。 */
  localPhase: string
  localPort: number
  /** 本次进程是否重建过 LAN TLS 身份。 */
  tlsIdentityRegenerated: boolean
  /** 最近一次失败；没有则为 undefined。 */
  lastFailure: Pick<DiagnosticEvent, 'kind' | 'reason' | 'ts'> | undefined
}

/**
 * `/phone/health` 的响应体：**只加不删**。
 *
 * 原有 `ok/enabled/protocolVersion/serverVersion/dataPlane` 保持原义；
 * 新增字段只描述「这台电脑此刻能不能被连上」，不含 debug 开关状态，
 * 也不返回局域网地址候选（那是配对页的职责，health 不该成为扫描器
 * 的地址字典）：
 * - `local`：LAN 传输此刻的相位与端口；
 * - `dataPlanePhase`：数据面 active / inactive；
 * - `tlsRebuilt`：本次运行是否重建过 TLS 身份（手机据此判断是否需要重新配对）；
 * - `startedAt`：插件启动时刻；
 * - `lastFailure`：最近一次失败的类型、分因与时间。
 */
export function buildHealthPayload(input: HealthPayloadInput): Record<string, unknown> {
  return {
    ok: true,
    enabled: input.enabled,
    protocolVersion: input.protocolVersion,
    serverVersion: input.serverVersion,
    dataPlane: input.dataPlaneActive,
    dataPlanePhase: input.dataPlaneActive ? 'active' : 'inactive',
    local: { phase: input.localPhase, port: input.localPort },
    tlsRebuilt: input.tlsIdentityRegenerated,
    startedAt: input.startedAt,
    lastFailure: input.lastFailure === undefined
      ? null
      : { kind: input.lastFailure.kind, reason: input.lastFailure.reason, ts: input.lastFailure.ts },
  }
}
