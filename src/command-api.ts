import type { Context } from '@deepseek-ai/cordis'
import type { SessionExportFormat } from './protocol.ts'

export interface CommandSummary {
  name: string
  description: string
  definitionId?: string
  input?: { hint: string; attachments?: boolean }
}
export interface CommandCatalog { commands: CommandSummary[]; permissions: boolean; export: boolean }
export interface CommandExecution { commandId: string; result: { kind: 'success' | 'error'; text?: string; sourceEventSeq?: number } }
export interface CommandAttachment { type: 'image' | 'document'; name: string; mediaType: string; data: string }
export interface PermissionOption { value: string; name: string; description?: string; confirmation: boolean }
export interface PermissionCatalog { options: PermissionOption[]; currentValue?: string }
export interface CommandApi {
  list(sessionId: string): Promise<CommandCatalog>
  execute(sessionId: string, line: string, attachments: CommandAttachment[], expectedDefinitionId?: string): Promise<CommandExecution>
  permissions(sessionId: string): Promise<PermissionCatalog>
  feedback(sessionId: string, text: string, category?: string): Promise<void>
  readonly markdownAvailable?: boolean
  export(sessionId: string, signal: AbortSignal, format?: SessionExportFormat): Promise<Response>
}

/**
 * 给本域自造的失败带上 Host 风格的码。
 *
 * 这些失败不是上游返回的，而是插件在这里判定出来的，所以必须自己声明语义：
 * 没有码的抛出物在 wire-errors 的域表里查不到，一律落进 `E_INTERNAL`，手机端
 * 便无法区分「指令不存在」「定义已变化」「这个指令不收附件」——它们对用户的
 * 下一步动作要求完全不同。码的取值见 `src/wire-errors.ts` 的 `command` 域表。
 */
function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** 只经官方 Gateway 调用命令，保留其 Agent 解析、作用域覆盖和生命周期记录。 */
export class DshCommandApi implements CommandApi {
  private peer: unknown
  constructor(private readonly ctx: Context) {}
  get available(): boolean {
    return this.ctx.get('commands') !== undefined && typeof (this.ctx.get('typertGateway') as any)?.invoke === 'function'
  }
  get markdownAvailable(): boolean {
    const connection = this.connection()
    // 共享 fetch 方法在无导出插件时也存在；实际路由和正文读取依赖都就绪才宣告能力。
    // alpha2 的连接服务持有此路由表；旧宿主或未知实现没有表时保守关闭入口。
    const route = connection?.fetchRoutes instanceof Map ? connection.fetchRoutes.get('/api/session.markdown') : undefined
    return typeof connection?.createSharedFetchHandler === 'function' &&
      route?.methods instanceof Set && route.methods.has('GET') && typeof route.fetch === 'function' &&
      typeof (this.ctx.get('sessionQuery') as any)?.readSession === 'function'
  }
  private connection(): any { return this.ctx.get('connection') }
  private owner(): unknown {
    const connection = this.connection()
    // 独立的一元调用身份不参与审批竞争；旧版使用连接提供的 operator。
    return this.peer ??= connection?.createPeer?.({ principal: { kind: 'owner' }, interactions: 'none' }) ?? connection?.operator
  }
  private invoke(namespace: string, method: string, args: Record<string, unknown>): Promise<any> {
    const gateway = this.ctx.get('typertGateway') as any
    return gateway.invoke({ namespace, method, args, peer: this.owner(), signal: AbortSignal.timeout(10 * 60_000) })
  }
  async list(sessionId: string): Promise<CommandCatalog> {
    const rows = await this.invoke('commands', 'list', { agentId: sessionId }) as CommandSummary[]
    const names = new Set<string>()
    const commands = rows.map(row => {
      if (!/^[a-z][a-z0-9_-]{0,127}$/.test(row.name) || names.has(row.name) || typeof row.description !== 'string') throw fail('command/invalid-response', '命令目录无效')
      names.add(row.name)
      return { name: row.name, description: row.description,
        ...(typeof row.definitionId === 'string' ? { definitionId: row.definitionId } : {}),
        ...(row.input && typeof row.input.hint === 'string' ? { input: { hint: row.input.hint, attachments: row.input.attachments === true } } : {}) }
    })
    return { commands, permissions: this.ctx.get('permissionPresets') !== undefined,
      export: typeof this.connection()?.createSharedFetchHandler === 'function' }
  }
  async execute(sessionId: string, line: string, attachments: CommandAttachment[], expectedDefinitionId?: string): Promise<CommandExecution> {
    const catalog = await this.list(sessionId)
    const name = /^\/([a-z][a-z0-9_-]*)(?=\s|$)/.exec(line)?.[1]
    const command = catalog.commands.find(row => row.name === name)
    if (!command) throw fail('command/not-found', '当前会话没有这个指令')
    if (expectedDefinitionId !== undefined && command.definitionId !== expectedDefinitionId) throw fail('command/definition-changed', '指令定义已变化，请重新选择')
    if (attachments.length && command.input?.attachments !== true) throw fail('command/attachments-unsupported', '这个指令不接受附件')
    const submittedAttachments: unknown[] = []
    for (const item of attachments) {
      if (item.type === 'image') submittedAttachments.push({ type: 'image', mediaType: item.mediaType, data: item.data })
      else {
        // 移动端文档已提取为正文；按文本文件上传，不冒充原始 PDF 或二进制文件。
        const uploaded = await this.invoke('fileUploads', 'upload', { agentId: sessionId, request: { name: item.name + '.txt', data: item.data } })
        submittedAttachments.push({ type: 'file', receiptId: uploaded.receiptId })
      }
    }
    const result = await this.invoke('commands', 'execute', { agentId: sessionId, line, submittedAttachments })
    if (!result || typeof result.commandId !== 'string' || !['success', 'error'].includes(result.result?.kind)) throw fail('command/invalid-response', '指令执行响应无效')
    return { commandId: result.commandId, result: { kind: result.result.kind,
      ...(typeof result.result.text === 'string' ? { text: result.result.text } : {}),
      ...(Number.isSafeInteger(result.result.sourceEventSeq) && result.result.sourceEventSeq >= 0 ? { sourceEventSeq: result.result.sourceEventSeq } : {}) } }
  }
  async permissions(sessionId: string): Promise<PermissionCatalog> {
    const service = this.ctx.get('permissionPresets') as any
    if (!service) throw fail('command/permissions-unsupported', '当前主机不支持权限预设')
    const catalog = await this.invoke('permissionPresets', 'catalog', {})
    const projection = await (this.ctx.get('sessionController') as any).projections({ sessionId }, new AbortController().signal)
    const currentValue = projection?.values?.permissions?.currentValue
    const seen = new Set<string>()
    const options = catalog.options.map((option: any) => {
      if (typeof option.value !== 'string' || !option.value.trim() || option.value.length > 512 || /[\r\n]/.test(option.value) || seen.has(option.value) || typeof option.name !== 'string') throw fail('command/invalid-response', '权限目录无效')
      seen.add(option.value)
      return { value: option.value, name: option.name,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
        confirmation: option.value === 'auto' || service.resolve(option.value).sandbox === 'danger-full-access' }
    })
    return { ...(typeof currentValue === 'string' ? { currentValue } : {}), options }
  }
  async feedback(sessionId: string, text: string, category?: string): Promise<void> {
    const result = await this.invoke('sessionFeedback', 'record', { request: { sessionId, ...(text.trim() ? { text: text.trim() } : {}), ...(category ? { category } : {}) } })
    // 上游拒绝时用它自己的码（`session/not-found` 等），插件只提供兜底：
    // 反馈保存失败的原因对手机是可执行的，压成一句通用失败会丢掉它。
    if (result?.ok !== true) throw fail(typeof result?.error?.code === 'string' ? result.error.code : 'command/invalid-response', typeof result?.error?.message === 'string' ? result.error.message : '反馈未能保存')
  }
  async export(sessionId: string, signal: AbortSignal, format?: SessionExportFormat): Promise<Response> {
    // 完整归档与对话正文各用官方路由；缺省沿用原 URL，保留子会话和附件。
    const markdown = format === 'markdown'
    const path = markdown ? '/api/session.markdown?sessionId=' : '/api/session.export?includeDescendants=true&sessionId='
    const response = await this.connection().createSharedFetchHandler('/api').fetch(
      new Request('http://localhost' + path + encodeURIComponent(sessionId), { signal }), this.owner())
    const contentType = response.headers.get('content-type')
    const matches = markdown ? contentType?.split(';')[0]?.trim().toLowerCase() === 'text/markdown' : contentType?.includes('application/zip')
    if (!response.ok || !response.body || !matches) throw fail('command/export-unavailable', markdown ? '主机未能生成会话对话正文' : '主机未能生成会话日志归档')
    return response
  }
}
