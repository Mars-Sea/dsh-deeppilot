/**
 * 本机预览转发（能力 `localPreview`）：一条预览连接上的全部通道。
 *
 * 职责：把手机经预览连接发来的每条「通道」接到电脑回环地址上的一个 TCP socket，
 * 双向搬运原始字节。不解析 HTTP——HTTP、WebSocket、服务器推送事件因此全部透明，
 * 页面自带的 Host / Origin 校验也不受影响（手机侧监听同一个端口）。
 *
 * 数据来源与约束（PROTOCOL.md「本机预览扩展」）：
 * - 端口必须先经 `authorize` 授权（保留端口、会话消息核对由 preview-policy 与
 *   HostBridge.sessionMentions 完成），`open` 只认已授权端口；
 * - 电脑端网页（能力 `hostWeb`，PROTOCOL.md「电脑端网页」）另有两条授权路径：
 *   `hostWeb` 授权 DSH 网页端端口并下发登录地址；具备 `hostweb.open` 的设备
 *   在开关打开时，`authorize` 不再核对会话消息（可不带 sessionId）。这类授权随开关
 *   失效：关闭后新请求被拒、已开通道在下一批数据时以 disabled 断开；
 * - 每条通道每个方向 256 KiB 窗口，由接收方用 credit 归还。经 Funnel 时插件这一侧
 *   看不到手机侧的积压（ws.bufferedAmount 只反映到 Funnel helper 为止），所以下行
 *   不能只靠发送缓冲判断快慢，必须端到端发额度；
 * - 另外仍看本连接的发送缓冲：32 条通道各 256 KiB 在途可能超过 4 MiB 的慢客户端
 *   断开线，缓冲偏高时暂缓下发，避免整条连接被 1013 断开。
 */

import { connect as netConnect, type Socket } from 'node:net'
import { deflateRawSync } from 'node:zlib'
import type {
  PreviewCloseReason,
  PreviewErrorReason,
} from './protocol.ts'
import type { S2CType } from './wire-registry.ts'
import type { WireErrorCode } from './wire-errors.ts'
import { isReservedPreviewPort, parseLoopbackUrl, type LoopbackTarget } from './preview-policy.ts'
import type { HostWebEntry } from './host-web.ts'

/** 每条通道每个方向的初始窗口（按解压后字节计）。 */
export const PREVIEW_INITIAL_WINDOW = 256 * 1024
/** 单个数据帧的最大原始字节数。 */
export const PREVIEW_MAX_CHUNK = 64 * 1024
/** 单条预览连接同时打开的通道上限：够浏览器每源 6 条并发加若干条 WebSocket 长连接。 */
export const PREVIEW_MAX_STREAMS = 32
/** 连接电脑上服务的超时。 */
export const PREVIEW_CONNECT_TIMEOUT_MS = 5_000
/** 发送窗口上限：客户端多给的额度截断到这里，防止一个错误的 credit 让窗口无限放大。 */
const MAX_SEND_WINDOW = 4 * PREVIEW_INITIAL_WINDOW
/** 小于这个大小不压缩：deflate 头开销抵不上收益。 */
const COMPRESS_MIN_BYTES = 1024
/** 压缩后必须不超过原大小的这个比例才用压缩结果（图片等已压缩内容会被跳过）。 */
const COMPRESS_MAX_RATIO = 0.9
/** 本连接发送缓冲超过这个值时暂缓下发数据帧，远低于 4 MiB 的慢客户端断开线。 */
const WRITABLE_HIGH_WATER = 1024 * 1024
/** 发送缓冲偏高时的重试间隔。 */
const FLUSH_RETRY_MS = 20

export const MAX_STREAM_ID = 2 ** 31 - 1

/** 连接注入的出口与环境；测试可替换任意一项。 */
export interface PreviewTunnelDeps {
  /** 发 JSON 帧；`id` 用于把响应与请求关联。 */
  send(type: S2CType, payload: unknown, id?: string): void
  /** 发格式 1 二进制帧（头部 payload + 原始字节）。 */
  sendBinary(type: S2CType, payload: unknown, body: Uint8Array): void
  /** 本连接发送缓冲是否还有余量；缺省视为总有余量。 */
  writable?(): boolean
  /** 设置页开关「允许手机预览本机网页」的当前值；每次请求与每批数据都重新读取。 */
  isEnabled(): boolean
  /** 插件自身正在使用的端口（局域网监听、Funnel 源站），每次授权时现取。 */
  reservedPorts(): Iterable<number>
  /** 会话消息里是否出现过 `needle`；null 表示会话读取失败。 */
  sessionMentions(sessionId: string, needle: string): Promise<boolean | null>
  /** 设置页开关「允许手机打开电脑端网页」的当前值；缺省视为关闭。 */
  isHostWebEnabled?(): boolean
  /** 本连接的设备是否具备 scope `hostweb.open`；缺省视为不具备。 */
  hasHostWebScope?(): boolean
  /** 现算网页端登录地址；宿主不支持时 undefined。返回值带凭据，不得记录。 */
  hostWeb?(): HostWebEntry | undefined
  /** 建 TCP 连接；缺省用 node:net。测试可注入假 socket。 */
  connect?(host: string, port: number): Socket
  /** 诊断日志；只记端口与原因，不记 URL 路径和内容。 */
  log?(message: string): void
}

/**
 * 端口授权的来路：`mention` 来自会话消息核对，只受本机预览开关约束；`hostWeb` 来自
 * 电脑端网页授权，另受其开关约束。
 */
type GrantSource = 'mention' | 'hostWeb'

/** 电脑端网页被拒的原因（开关关闭优先于缺 scope：前者是用户能在设置页解决的）。 */
type HostWebDenial = 'hostweb-disabled' | 'hostweb-forbidden'

interface PreviewStream {
  readonly id: number
  readonly socket: Socket
  /** 所用端口授权的来路；数据转发前据此复核开关。 */
  readonly source: GrantSource
  /** 还能往手机发的字节数（手机发放的额度余量）。 */
  sendWindow: number
  /** 手机还能发来的字节数（本端发放的额度余量）。 */
  recvWindow: number
  /** 因窗口或发送缓冲暂存、尚未下发的数据。 */
  readonly pending: Buffer[]
  /** 电脑上的服务已结束：待 pending 下发完再告诉手机 eof。 */
  ended: boolean
  closed: boolean
}

interface PortGrant {
  connectHosts: readonly string[]
  source: GrantSource
}

export class PreviewTunnel {
  private readonly streams = new Map<number, PreviewStream>()
  /** 已授权端口 → 实际连接地址；连接关闭即作废。 */
  private readonly grants = new Map<number, PortGrant>()
  private flushTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly deps: PreviewTunnelDeps) {}

  /** 当前打开的通道数（测试与诊断用）。 */
  get streamCount(): number {
    return this.streams.size
  }

  // ---------- 控制帧 ----------

  /**
   * c2s.preview.authorize：检查开关、URL、保留端口，再核对会话消息；通过后记录授权。
   * 电脑端网页放宽（开关打开且设备具备 `hostweb.open`）时，会话里没出现过的端口也放行，
   * 不带 sessionId 时只走这条路径。
   */
  async authorize(id: string | undefined, sessionId: string | undefined, rawUrl: string): Promise<void> {
    if (!this.deps.isEnabled()) return this.fail(id, 'E_FORBIDDEN', 'disabled', 'local preview is disabled')
    const target = parseLoopbackUrl(rawUrl)
    if (target === undefined) return this.fail(id, 'E_PROTOCOL', 'bad-url', 'url must be http on a loopback host with an explicit port')
    if (isReservedPreviewPort(target.port, this.deps.reservedPorts())) {
      return this.fail(id, 'E_FORBIDDEN', 'reserved-port', `port ${target.port} is reserved`)
    }
    if (sessionId === undefined) {
      const denial = this.hostWebDenial()
      if (denial !== undefined) return this.fail(id, 'E_FORBIDDEN', denial, 'host web access is not allowed')
      return this.grant(id, target, 'hostWeb')
    }
    const mentioned = await this.deps.sessionMentions(sessionId, target.mention)
    if (this.disposed) return
    if (mentioned === true) return this.grant(id, target, 'mention')
    // 先核对会话再看放宽：会话里出现过的端口记为 mention，关掉电脑端网页开关后仍可用。
    if (this.hostWebDenial() === undefined) return this.grant(id, target, 'hostWeb')
    if (mentioned === null) return this.fail(id, 'E_NOT_FOUND', 'session-not-found', 'session history unavailable')
    return this.fail(id, 'E_FORBIDDEN', 'not-mentioned', `port ${target.port} not mentioned in session`)
  }

  /**
   * c2s.preview.hostWeb：授权 DSH 网页端端口并下发带登录令牌的地址。网页端端口在保留名单里，
   * 只能经这条路径授权。登录地址是凭据：只发给手机，日志只记端口。
   */
  hostWeb(id: string | undefined): void {
    if (this.disposed) return
    if (!this.deps.isEnabled()) return this.fail(id, 'E_FORBIDDEN', 'disabled', 'local preview is disabled')
    const denial = this.hostWebDenial()
    if (denial !== undefined) return this.fail(id, 'E_FORBIDDEN', denial, 'host web access is not allowed')
    const entry = this.deps.hostWeb?.()
    if (entry === undefined) {
      return this.fail(id, 'E_UNSUPPORTED', 'hostweb-unavailable', 'DSH Web is not served over plain HTTP on a loopback address')
    }
    const { target, url } = entry
    this.grants.set(target.port, { connectHosts: target.connectHosts, source: 'hostWeb' })
    this.deps.log?.(`preview host web authorized port=${target.port}`)
    this.deps.send('s2c.preview.hostWeb', { port: target.port, origin: target.origin, url }, id)
  }

  /** c2s.preview.open：连接已授权端口，成功回 opened。 */
  async open(id: string | undefined, streamId: number, port: number): Promise<void> {
    if (!this.deps.isEnabled()) return this.fail(id, 'E_FORBIDDEN', 'disabled', 'local preview is disabled')
    const grant = this.grants.get(port)
    if (grant === undefined) return this.fail(id, 'E_FORBIDDEN', 'not-authorized', `port ${port} not authorized`)
    if (grant.source === 'hostWeb') {
      const denial = this.hostWebDenial()
      if (denial !== undefined) return this.fail(id, 'E_FORBIDDEN', denial, 'host web access is not allowed')
    }
    if (this.streams.has(streamId)) return this.fail(id, 'E_PROTOCOL', 'duplicate-stream', `stream ${streamId} in use`)
    if (this.streams.size >= PREVIEW_MAX_STREAMS) return this.fail(id, 'E_BUSY', 'too-many-streams', 'too many preview streams')
    const socket = await this.connectFirst(grant.connectHosts, port)
    if (socket === undefined) return this.fail(id, 'E_NOT_FOUND', 'connect-refused', `nothing listening on port ${port}`)
    // 连接期间可能已被关闭或重复占用（并发 open 同一 id）：后到的一条直接放弃。
    if (this.disposed || this.streams.has(streamId)) {
      socket.destroy()
      if (!this.disposed) this.fail(id, 'E_PROTOCOL', 'duplicate-stream', `stream ${streamId} in use`)
      return
    }
    const stream: PreviewStream = {
      id: streamId,
      socket,
      source: grant.source,
      sendWindow: PREVIEW_INITIAL_WINDOW,
      recvWindow: PREVIEW_INITIAL_WINDOW,
      pending: [],
      ended: false,
      closed: false,
    }
    this.streams.set(streamId, stream)
    // 先回 opened，再挂数据监听：手机必须先知道通道存在，才能认领随后的数据帧。
    this.deps.send('s2c.preview.opened', { streamId }, id)
    socket.on('data', (chunk: Buffer) => this.onSocketData(stream, chunk))
    socket.on('end', () => {
      stream.ended = true
      this.flush(stream)
    })
    socket.on('error', () => this.closeStream(stream, 'error', true))
    socket.on('close', () => {
      // 'end' 之后的正常关闭由 flush 在 pending 排空时发 eof；其余情况（对端直接重置）
      // 以 error 告知手机。
      if (!stream.ended) this.closeStream(stream, 'error', true)
    })
  }

  /** c2s.preview.credit：手机归还下行额度。 */
  credit(streamId: number, bytes: number): void {
    const stream = this.streams.get(streamId)
    if (stream === undefined) return
    stream.sendWindow = Math.min(MAX_SEND_WINDOW, stream.sendWindow + bytes)
    this.flush(stream)
  }

  /** c2s.preview.close：手机关闭通道；立即销毁 socket，不回帧。 */
  close(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (stream !== undefined) this.closeStream(stream, 'eof', false)
  }

  // ---------- 数据帧 ----------

  /** 上行数据帧（c2s.preview.data）。未知通道的数据直接丢弃（关闭与在途数据的竞态）。 */
  data(streamId: number, body: Buffer): void {
    const stream = this.streams.get(streamId)
    if (stream === undefined || stream.closed) return
    if (!this.allows(stream)) return this.closeStream(stream, 'disabled', true)
    if (body.length === 0 || body.length > PREVIEW_MAX_CHUNK || body.length > stream.recvWindow) {
      return this.closeStream(stream, 'flow-control', true)
    }
    stream.recvWindow -= body.length
    const length = body.length
    // 写完（交给内核）才归还额度：手机据此控制在途字节，电脑上的服务读得慢时手机自然停下。
    stream.socket.write(body, (error) => {
      if (error || stream.closed) return
      stream.recvWindow += length
      this.deps.send('s2c.preview.credit', { streamId: stream.id, bytes: length })
    })
  }

  /** 预览连接关闭：销毁全部 socket，作废授权。之后的一切调用都是空操作。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    for (const stream of this.streams.values()) {
      stream.closed = true
      stream.socket.destroy()
    }
    this.streams.clear()
    this.grants.clear()
  }

  // ---------- 内部 ----------

  /** 记录端口授权并回 authorized。会话来路的授权不被放宽来路覆盖（它不随电脑端网页开关失效）。 */
  private grant(id: string | undefined, target: LoopbackTarget, source: GrantSource): void {
    if (this.disposed) return
    const existing = this.grants.get(target.port)
    if (existing?.source !== 'mention') this.grants.set(target.port, { connectHosts: target.connectHosts, source })
    this.deps.log?.(`preview authorized port=${target.port} via=${source}`)
    this.deps.send('s2c.preview.authorized', { port: target.port, origin: target.origin }, id)
  }

  /** 电脑端网页当前是否放行；放行时返回 undefined。每次现取：开关可热更新。 */
  private hostWebDenial(): HostWebDenial | undefined {
    if (this.deps.isHostWebEnabled?.() !== true) return 'hostweb-disabled'
    if (this.deps.hasHostWebScope?.() !== true) return 'hostweb-forbidden'
    return undefined
  }

  /** 通道是否仍可转发：本机预览开关总要打开；电脑端网页来路另需其开关与 scope。 */
  private allows(stream: PreviewStream): boolean {
    if (!this.deps.isEnabled()) return false
    return stream.source === 'mention' || this.hostWebDenial() === undefined
  }

  private onSocketData(stream: PreviewStream, chunk: Buffer): void {
    if (stream.closed) return
    if (!this.allows(stream)) return this.closeStream(stream, 'disabled', true)
    stream.pending.push(chunk)
    this.flush(stream)
  }

  /**
   * 在窗口与发送缓冲允许的范围内下发 pending。窗口用尽时暂停读 socket（TCP 背压
   * 自然传回电脑上的服务），额度回来再恢复。
   */
  private flush(stream: PreviewStream): void {
    if (stream.closed || this.disposed) return
    while (stream.pending.length > 0 && stream.sendWindow > 0) {
      if (this.deps.writable && !this.deps.writable()) {
        this.scheduleFlush()
        break
      }
      const head = stream.pending[0]!
      const size = Math.min(head.length, stream.sendWindow, PREVIEW_MAX_CHUNK)
      const piece = head.subarray(0, size)
      if (size === head.length) stream.pending.shift()
      else stream.pending[0] = head.subarray(size)
      stream.sendWindow -= size
      this.sendData(stream.id, piece)
    }
    if (stream.pending.length > 0) {
      stream.socket.pause()
      return
    }
    if (stream.ended) {
      this.closeStream(stream, 'eof', true)
      return
    }
    stream.socket.resume()
  }

  private sendData(streamId: number, piece: Buffer): void {
    if (piece.length >= COMPRESS_MIN_BYTES) {
      const compressed = deflateRawSync(piece, { level: 1 })
      if (compressed.length <= piece.length * COMPRESS_MAX_RATIO) {
        this.deps.sendBinary('s2c.preview.data', { streamId, z: true }, compressed)
        return
      }
    }
    this.deps.sendBinary('s2c.preview.data', { streamId }, piece)
  }

  /** 发送缓冲偏高：稍后对全部通道重试一次（合并成一个计时器）。 */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      for (const stream of this.streams.values()) this.flush(stream)
    }, FLUSH_RETRY_MS)
    this.flushTimer.unref?.()
  }

  /** 关闭一条通道；`notify` 为 true 时告诉手机原因（手机主动关闭时不回帧）。 */
  private closeStream(stream: PreviewStream, reason: PreviewCloseReason, notify: boolean): void {
    if (stream.closed) return
    stream.closed = true
    stream.pending.length = 0
    this.streams.delete(stream.id)
    stream.socket.destroy()
    if (notify && !this.disposed) this.deps.send('s2c.preview.closed', { streamId: stream.id, reason })
    if (reason !== 'eof') this.deps.log?.(`preview stream closed reason=${reason}`)
  }

  /** 按顺序尝试连接地址（localhost 先 IPv4 后 IPv6）；全部失败返回 undefined。 */
  private async connectFirst(hosts: readonly string[], port: number): Promise<Socket | undefined> {
    for (const host of hosts) {
      const socket = await this.connectOne(host, port)
      if (socket !== undefined) return socket
    }
    return undefined
  }

  private connectOne(host: string, port: number): Promise<Socket | undefined> {
    return new Promise((resolve) => {
      const socket = this.deps.connect ? this.deps.connect(host, port) : netConnect({ host, port })
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('error', onError)
        if (!ok) socket.destroy()
        resolve(ok ? socket : undefined)
      }
      const onConnect = (): void => finish(true)
      const onError = (): void => finish(false)
      const timer = setTimeout(() => finish(false), PREVIEW_CONNECT_TIMEOUT_MS)
      timer.unref?.()
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  private fail(id: string | undefined, code: WireErrorCode, reason: PreviewErrorReason, message: string): void {
    if (this.disposed) return
    this.deps.send('s2c.error', { code, message, reason }, id)
  }
}
