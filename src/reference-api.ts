import type { Context } from '@deepseek-ai/cordis'

/**
 * 输入框 `@` 引用候选（PROTOCOL.md「输入框引用扩展」）。
 *
 * 数据来源都是 DSH 官方 Remote，经 `typertGateway` 以 owner 身份调用，与 Web 端同一条发现链路：
 * - 文件：`fileReferences/list {agentId, query}` → `[{path, kind}]`，由主机挂载的提供方
 *   （如 `dsh-file-reference-local`）在该会话工作目录里排序给出。只给路径，不读文件内容。
 * - 会话：`sessionReferenceResolver/candidates {agentId, query}` → 带规范 mention
 *   `@[label](dsh-session:…)` 的候选；手机发送时原样放进提示词，主机负责改写与注入快照。
 *
 * 两类服务都是可选挂载（兼容下限 0.2.1-rc.5 没有保证），所以每次按当前服务是否存在判定，
 * 一类缺席不影响另一类。会话候选不下发工作目录，只给 `sameWorkspace`，避免把本机路径带到手机。
 */

export interface FileReferenceItem { path: string; kind: 'file' | 'directory' }
export interface SessionReferenceItem { sessionId: string; label: string; mention: string; sameWorkspace: boolean }
export interface ReferenceSource<T> { available: boolean; items: T[] }
export interface ReferenceCandidates {
  files: ReferenceSource<FileReferenceItem>
  sessions: ReferenceSource<SessionReferenceItem>
}

/** 手机候选列表上限：文件 30、会话 10（会话端主机默认还会给到 50，这里截断）。 */
export const FILE_REFERENCE_LIMIT = 30
export const SESSION_REFERENCE_LIMIT = 10
/** 补全是交互式请求，慢于此值的结果对用户已无意义。 */
const REFERENCE_TIMEOUT_MS = 5_000

const SESSION_MENTION = /^@\[[^\n]*\]\(dsh-session:[A-Za-z0-9_-]+\)$/

export class DshReferenceApi {
  private peer: unknown
  constructor(private readonly ctx: Context) {}

  private get gatewayReady(): boolean {
    return typeof (this.ctx.get('typertGateway') as any)?.invoke === 'function'
  }
  get filesAvailable(): boolean { return this.gatewayReady && this.ctx.get('fileReferences') !== undefined }
  get sessionsAvailable(): boolean { return this.gatewayReady && this.ctx.get('sessionReferenceResolver') !== undefined }
  get available(): boolean { return this.filesAvailable || this.sessionsAvailable }

  private owner(): unknown {
    const connection = this.ctx.get('connection') as any
    // 与命令接口相同：独立的一元调用身份，不参与审批竞争。
    return this.peer ??= connection?.createPeer?.({ principal: { kind: 'owner' }, interactions: 'none' }) ?? connection?.operator
  }

  private async invoke(namespace: string, method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const gateway = this.ctx.get('typertGateway') as any
    return unwrapRemote(await gateway.invoke({ namespace, method, args, peer: this.owner(), signal }))
  }

  /**
   * 并行读两类候选。单类失败（超时、旧主机没有对应 Remote）只让该类为空，
   * 不拖垮另一类；两类都不可用由调用方在能力位上拦下。
   */
  async list(sessionId: string, query: string, signal?: AbortSignal): Promise<ReferenceCandidates> {
    const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(REFERENCE_TIMEOUT_MS)])
    const filesAvailable = this.filesAvailable
    const sessionsAvailable = this.sessionsAvailable
    const [files, sessions] = await Promise.all([
      filesAvailable
        ? this.invoke('fileReferences', 'list', { agentId: sessionId, query }, bounded).then(fileItems, () => [])
        : Promise.resolve([]),
      sessionsAvailable
        ? this.invoke('sessionReferenceResolver', 'candidates', { agentId: sessionId, query }, bounded).then(sessionItems, () => [])
        : Promise.resolve([]),
    ])
    return {
      files: { available: filesAvailable, items: files },
      sessions: { available: sessionsAvailable, items: sessions },
    }
  }
}

/**
 * 网关对不同 Remote 的返回形态不一：有的直接给值（如 `commands/list`），有的给
 * `RemoteResult {ok, value | error}`（如 `sessionFeedback/record`）。两种都接受，失败抛出。
 */
export function unwrapRemote(result: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as any).ok === 'boolean') {
    if ((result as any).ok) return (result as any).value
    throw Object.assign(new Error((result as any).error?.message ?? 'reference lookup failed'), { code: (result as any).error?.code })
  }
  return result
}

/** 只保留形状合法的行；主机排序原样保留。 */
export function fileItems(rows: unknown): FileReferenceItem[] {
  if (!Array.isArray(rows)) return []
  const items: FileReferenceItem[] = []
  for (const row of rows) {
    if (items.length >= FILE_REFERENCE_LIMIT) break
    const path = (row as any)?.path
    const kind = (row as any)?.kind
    if (typeof path !== 'string' || !path || path.length > 4096 || (kind !== 'file' && kind !== 'directory')) continue
    items.push({ path, kind })
  }
  return items
}

/** 标签优先用主机给的显示标题（子代理的创建标签），与规范 mention 里的文字一致。 */
export function sessionItems(rows: unknown): SessionReferenceItem[] {
  if (!Array.isArray(rows)) return []
  const items: SessionReferenceItem[] = []
  for (const row of rows) {
    if (items.length >= SESSION_REFERENCE_LIMIT) break
    const r = row as any
    const label = typeof r?.displayTitle === 'string' && r.displayTitle ? r.displayTitle : r?.label
    if (typeof r?.sessionId !== 'string' || !r.sessionId || typeof label !== 'string' || !label ||
        typeof r.mention !== 'string' || r.mention.length > 4096 || !SESSION_MENTION.test(r.mention)) continue
    items.push({ sessionId: r.sessionId, label, mention: r.mention, sameWorkspace: r.sameWorkspace === true })
  }
  return items
}
