import type { MessageProjection, SessionEventKind, ToolEditProjection, ToolTargetProjection } from './protocol.ts'
import type { SessionEventLike } from './host-api.ts'
import { projectedDocument } from './document-payload.ts'

export const MAX_MESSAGE_PROJECTION_BYTES = 256 * 1024
/// Aggregate message-array budget for one tail/history frame. The complete
/// envelope stays below the legacy iOS 1 MB decoder cap with ample metadata
/// headroom, while each individual projection keeps its 256 KB allowance.
export const MAX_SESSION_PAGE_MESSAGES_BYTES = 900 * 1024

/** One durable host event sequence becomes exactly one phone message row.
 * Keep the last projection when a host history response repeats an event. */
export function canonicalSessionMessages(messages: MessageProjection[]): MessageProjection[] {
  const bySequence = new Map<number, MessageProjection>()
  for (const message of messages) bySequence.set(message.seq, message)
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq)
}

export function limitSessionPageMessages(messages: MessageProjection[]): {
  messages: MessageProjection[]
  dropped: number
} {
  const canonical = canonicalSessionMessages(messages)
  let bytes = 2 // JSON array brackets
  const kept: MessageProjection[] = []
  for (let index = canonical.length - 1; index >= 0; index -= 1) {
    const message = canonical[index]!
    const candidateBytes = jsonBytes(message) + (kept.length > 0 ? 1 : 0)
    if (bytes + candidateBytes > MAX_SESSION_PAGE_MESSAGES_BYTES) break
    kept.unshift(message)
    bytes += candidateBytes
  }
  return { messages: kept, dropped: canonical.length - kept.length }
}

export function projectEvent(sessionId: string, event: SessionEventLike): { kind: SessionEventKind; data: Record<string, unknown> } | null {
  switch (event.type) {
    case 'turn/start':
      return { kind: 'turn.start', data: {} };
    case 'turn/end': {
      const data = event.data as { reason?: { kind?: string } } | undefined;
      const ok = data?.reason?.kind === 'completed';
      const errorText = ok ? undefined : turnEndFailureText(event.data);
      return {
        kind: 'turn.end',
        data: {
          ok,
          ...(errorText ? limitRealtimeText({ text: errorText, ts: tsOf(event) }) : {}),
        },
      };
    }
    case 'system/message': {
      // DSH 0.1.5 (session format V3) records the system prompt in message
      // history as a native surface event: {turn, step, message: SystemMessage}.
      // The SystemMessage content is model-facing prompt prose, not
      // conversation content — projecting it onto the phone's message list
      // would duplicate it on every page and leak prompt internals the user
      // never typed. Skip it explicitly (rather than via `default`) so a
      // future shape change forces a deliberate decision here.
      return null;
    }
    case 'user/message':
      return {
        kind: 'message.final',
        data: { ...limitMessageProjection({
          seq: event.seq,
          role: userRoleOf(event.data),
          text: messageText(event.data),
          ...attachmentProjection(event.data),
          ...(contextProjectionOf(event.data)),
          ts: tsOf(event),
        }) },
      };
    case 'assistant/chunk': {
      if (chunkTypeOf(event.data) === 'reasoning-delta') {
        return { kind: 'thinking.delta', data: limitRealtimeText({ text: chunkText(event.data), ts: tsOf(event) }) };
      }
      return { kind: 'message.delta', data: limitRealtimeText({ text: chunkText(event.data), ts: tsOf(event) }) };
    }
    case 'assistant/message': {
      const text = messageText(event.data);
      const thinking = messageThinking(event.data);
      // Pure-reasoning or tool-only steps carry no visible answer; emitting
      // them produced empty bubbles on the phone.
      if (!text.trim() && !thinking.trim()) return null;
      return {
        kind: 'message.final',
        data: { ...limitMessageProjection({ seq: event.seq, role: 'assistant', text, ...(thinking ? { thinking } : {}), ts: tsOf(event) }) },
      };
    }
    case 'tool/call': {
      const data = event.data as { name?: string; arguments?: string; callId?: string } | undefined;
      return {
        kind: 'tool.start',
        data: {
          seq: event.seq,
          role: 'tool',
          tool: {
            name: String(data?.name ?? 'tool'),
            state: 'running',
            summary: summarizeArgs(data?.arguments),
            // Echo the invocation id so clients can pair the later result with
            // this exact row instead of guessing.
            ...(data?.callId ? { callId: String(data.callId) } : {}),
            ...editField(data?.name, data?.arguments),
            ...targetField(data?.name, data?.arguments),
          },
          ts: tsOf(event)
        }
      };
    }
    case 'tool/result': {
      const { callId, failed, message } = toolResultOf(event.data);
      const ok = !failed;
      const result = limitMessageProjection({
        seq: event.seq, role: 'tool', ts: tsOf(event),
        tool: { name: 'result', state: ok ? 'ok' : 'error', summary: ok ? summarizeResult(message?.content) : '失败' },
        ...(ok ? attachmentProjection(message) : {}),
      });
      return {
        kind: 'tool.end',
        data: {
          seq: result.seq, role: result.role, ts: result.ts, ok,
          summary: result.tool?.summary,
          ...(result.attachments ? { attachments: result.attachments } : {}),
          ...(callId ? { callId } : {}),
        }
      };
    }
    default:
      return null;
  }
}

/** Native results carry identity and failure on message; retain older Host fields. */
function toolResultOf(value: unknown) {
  const data = value as {
    callId?: string
    error?: unknown
    message?: { toolCallId?: string; isError?: boolean; content?: unknown }
  } | undefined
  return {
    callId: data?.message?.toolCallId || data?.callId,
    failed: data?.message?.isError === true || data?.error !== undefined,
    message: data?.message,
  }
}

function tsOf(event: SessionEventLike): number {
  return typeof event.time === 'number' ? event.time : Date.now();
}

// ---------- 模型错误与重试状态归一化 ----------
//
// 职责：将 DSH 宿主的 LlmFailure（来自 turn/end reason.error 或 llm/retry failure）
// 与非正常 turn/end 原因转成面向用户的中文说明，保留原始错误码在括号内便于排查。
// 数据来源：@deepseek-ai/dsh-agent-loop（turn/end）与 @deepseek-ai/dsh-llm-retry（llm/retry）。

const LLM_ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  AUTH: 'API 密钥无效或鉴权失败',
  INVALID_CREDENTIAL: 'API 密钥格式无效',
  MISSING_CREDENTIAL: '未配置 API 密钥',
  QUOTA: '当前请求的额度已用尽',
  ACCOUNT_QUOTA: '当前请求的额度已用尽',
  RATE_LIMIT: '请求频率超限或并发受限',
  SERVER: '上游模型服务异常',
  TIMEOUT: '模型请求超时',
  TRANSPORT: '模型网络连接中断',
  CONTEXT_WINDOW_EXCEEDED: '请求内容超出模型上下文窗口上限',
  EMPTY_RESPONSE: '模型返回了空响应',
  MALFORMED_RESPONSE: '模型响应格式异常',
  STREAM_CLOSED: '模型输出流意外中断',
  NO_ADAPTER: '未找到匹配的模型提供方适配器',
  UNKNOWN_MODEL: '未配置该模型',
  INVALID_CONFIG: '模型或提供方配置无效',
  PI_AI_ERROR: '模型请求失败',
  TOOL_ACTIVATION_FAILED: '工具激活失败',
  UNKNOWN: '模型请求异常',
}

/** 将宿主 LlmFailure 对象格式化为中文报错文案，原错误码置于末尾括号内。 */
export function formatLlmFailure(failure: unknown): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined
  const record = failure as { code?: unknown; message?: unknown }
  const code = typeof record.code === 'string' && record.code.trim().length > 0
    ? record.code.trim()
    : undefined
  const message = typeof record.message === 'string'
    ? record.message.replace(/\s+/g, ' ').trim()
    : ''
  if (!code && !message) return undefined
  const label = code ? (LLM_ERROR_CODE_LABELS[code] ?? '模型请求失败') : '模型请求失败'
  const codeSuffix = code && !message.endsWith(`（${code}）`) && !message.endsWith(`(${code})`)
    ? `（${code}）`
    : ''
  if (!message) return `${label}${codeSuffix}`
  if (/^[\u4e00-\u9fff]/.test(message) || message.includes(label)) {
    return `${message}${codeSuffix}`
  }
  return `${label}：${message}${codeSuffix}`
}

/**
 * 从 turn/end 事件载荷提取异常结束原因（用于时间线 `role: "error"` 消息行、
 * `s2c.session.event(turn.end)` 的 `data.text` 以及 `session.error` 通知正文）。
 *
 * - `completed` 或缺失 `reason` 时返回 undefined；
 * - 用户主动取消（`aborted.reason.kind === 'user'`）不在聊天时间线插入错误卡片，
 *   返回 undefined（通知侧仍按 `ok: false` 发送 `session.error`）。
 */
export function turnEndFailureText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const reason = (data as { reason?: unknown }).reason
  if (!reason || typeof reason !== 'object') return undefined
  const r = reason as { kind?: unknown; error?: unknown; reason?: unknown }
  if (typeof r.kind !== 'string' || r.kind === 'completed') return undefined
  switch (r.kind) {
    case 'error':
      return formatLlmFailure(r.error) ?? '本轮运行失败（ERROR）'
    case 'interrupted':
      return 'DSH 进程在本轮完成前退出，本轮已中止（INTERRUPTED）'
    case 'max-tokens':
      return '已达到输出 Token 上限，回答被截断（MAX_TOKENS）'
    case 'blocked':
      return '本轮运行受阻（BLOCKED）'
    case 'aborted': {
      const cause = r.reason as { kind?: unknown; reason?: unknown } | undefined
      if (cause?.kind === 'hook') {
        if (cause.reason === 'deepseek-account/signed-out') {
          return '任务已因退出登录而停止（ACCOUNT_SIGNED_OUT）'
        }
        const hookReason = typeof cause.reason === 'string' ? cause.reason.trim() : ''
        return hookReason
          ? `任务已被钩子中止：${hookReason}（ABORTED）`
          : '任务已被钩子中止（ABORTED）'
      }
      return undefined
    }
    default:
      return `本轮异常结束（${r.kind.toUpperCase()}）`
  }
}

/**
 * 从 `llm/retry` 事件载荷提取单行重试活动描述（上限 160 个 Unicode 码点，供
 * `SessionSummary.activity` 在会话列表、详情页与锁屏实时活动中展示）。
 */
export function retryActivityText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as { retry?: unknown; maxRetries?: unknown; mode?: unknown; failure?: unknown }
  const retry = typeof record.retry === 'number' && Number.isFinite(record.retry) && record.retry > 0
    ? Math.trunc(record.retry)
    : undefined
  const maxRetries = typeof record.maxRetries === 'number' && Number.isFinite(record.maxRetries) && record.maxRetries > 0
    ? Math.trunc(record.maxRetries)
    : undefined
  const progress = retry !== undefined
    ? (record.mode === 'normal' && maxRetries !== undefined ? `（${retry}/${maxRetries}）` : `（第 ${retry} 次）`)
    : ''
  const failure = formatLlmFailure(record.failure)
  const text = `正在重试模型请求${progress}${failure ? '：' + failure : ''}`
  return Array.from(text).slice(0, 160).join('')
}

// ---------- user-role source classification ----------
//
// The DSH host logs every model-visible user-role message as `user/message`,
// but only some of them are human prompts: synthetic `agent.inject()` context
// (runtime-context snapshots, background-job notices, workspace instructions,
// skill content, …) rides the same event type. The durable message carries a
// `source` whose `kind` tells them apart, and the host's own trajectory view
// renders only `source.kind === 'user'` as a human prompt — everything else is
// injected context. The bridge mirrors that classification so the phone can
// keep the two apart instead of guessing from text shapes.

/** Read the durable message source off one user/message payload. Handles both
 * bare-message payloads and older `{message: {...}}` wrappers; undefined when
 * the shape carries no readable source (legacy hosts). */
function userMessageSource(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as { source?: unknown; message?: { source?: unknown } };
  if (obj.source && typeof obj.source === 'object') {
    return obj.source as Record<string, unknown>;
  }
  if (obj.message && typeof obj.message === 'object' &&
      obj.message.source && typeof obj.message.source === 'object') {
    return obj.message.source as Record<string, unknown>;
  }
  return undefined;
}

/** Source kind of one user/message payload (`user`, `schedule`, injected
 * context kinds, …); undefined on legacy hosts that record no source. */
export function userMessageSourceKind(data: unknown): string | undefined {
  const kind = userMessageSource(data)?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/** Wire role for one user/message payload. A payload without any readable
 * source degrades to 'user' so history written by older hosts stays visible;
 * a present source follows the host's own trajectory rule — anything whose
 * `kind` is not 'user' is injected context and projects as 'system'. */
function userRoleOf(data: unknown): 'user' | 'system' {
  const source = userMessageSource(data);
  if (!source) return 'user';
  return source.kind === 'user' ? 'user' : 'system';
}

/** Producer name of one injected-context source, mirroring how the DSH client
 * runtime derives its trajectory label: plugin name, skill name, instruction
 * paths, session-reference labels, or the raw kind as fallback. */
function contextLabelOf(source: Record<string, unknown>): string | undefined {
  const kind = typeof source.kind === 'string' ? source.kind : '';
  const joined = (member: string): string | undefined => {
    const list = source[member];
    if (!Array.isArray(list)) return undefined;
    const names = list.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      return [typeof record.label === 'string' ? record.label :
        (typeof record.path === 'string' ? record.path : '')];
    }).filter((name) => name.length > 0);
    return names.length > 0 ? names.join(', ') : undefined;
  };
  switch (kind) {
    case 'session-reference':
      return joined('references') ?? (kind || undefined);
    case 'agent-instructions':
      return joined('changes') ?? (kind || undefined);
    case 'plugin':
      return typeof source.plugin === 'string' && source.plugin.length > 0 ? source.plugin : kind || undefined;
    case 'skill-invocation':
      return typeof source.name === 'string' && source.name.length > 0 ? source.name : kind || undefined;
    default:
      return kind || undefined;
  }
}

/** Semantic ContextForm declared by the producer ('snapshot', 'notice', …);
 * anything unrecognized stays undefined so clients render it opaque. */
function contextFormOf(source: Record<string, unknown>): string | undefined {
  if (typeof source.form !== 'string' || source.form.length === 0) return undefined;
  // Same known-vocabulary guard as the host's trajectory UI.
  const known = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'];
  return known.includes(source.form) ? source.form : undefined;
}

/** Optional `context` metadata for one system row; {} on user rows. */
function contextProjectionOf(data: unknown): { context?: { label?: string; form?: string } } {
  if (userRoleOf(data) !== 'system') return {};
  const source = userMessageSource(data);
  if (!source) return {};
  const label = contextLabelOf(source);
  const form = contextFormOf(source);
  if (!label && !form) return {};
  return { context: { ...(label ? { label } : {}), ...(form ? { form } : {}) } };
}

/** Extract plain text from user/assistant message payloads across shapes. */
export function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const obj = data as { content?: unknown; text?: unknown; message?: unknown };
  if (typeof obj.text === 'string') return obj.text;
  // Session events wrap the message: {turn, step, message: {role, content}}
  if (obj.message && typeof obj.message === 'object') return messageText(obj.message);
  return contentText(obj.content);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const piece = part as { type?: string; text?: string };
        if (piece.type === 'text' && typeof piece.text === 'string') {
          return projectedDocument(piece.text) ? '' : piece.text
        }
      }
      return '';
    }).join('');
  }
  return '';
}

function messageAttachments(data: unknown): Array<{
  kind: 'image' | 'document'
  name?: string
  mediaType?: string
  attachmentId?: string
  width?: number
  height?: number
  truncated?: boolean
}> {
  if (!data || typeof data !== 'object') return [];
  const obj = data as { content?: unknown; message?: unknown };
  if (obj.message && typeof obj.message === 'object') return messageAttachments(obj.message);
  if (!Array.isArray(obj.content)) return [];
  const attachments: Array<{
    kind: 'image' | 'document'
    name?: string
    mediaType?: string
    attachmentId?: string
    width?: number
    height?: number
    truncated?: boolean
  }> = []
  for (const part of obj.content) {
    if (!part || typeof part !== 'object') continue
    // The host normalizes uploaded bytes into an ImageAttachmentRef
    // (attachmentId/mediaType/bytes/width/height...); the id is what clients
    // need to read the image back through c2s.session.attachment.
    const block = part as {
      type?: string
      text?: unknown
      attachment?: {
        name?: unknown
        mediaType?: unknown
        attachmentId?: unknown
        width?: unknown
        height?: unknown
      }
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      const document = projectedDocument(block.text)
      if (document) {
        attachments.push({
          kind: 'document',
          name: document.name,
          mediaType: document.mediaType,
          ...(document.truncated ? { truncated: true } : {}),
        })
      }
      continue
    }
    if (block.type !== 'image' || !block.attachment) continue
    const attachmentId = typeof block.attachment.attachmentId === 'string' && block.attachment.attachmentId.length > 0
      ? block.attachment.attachmentId
      : undefined;
    const width = typeof block.attachment.width === 'number' && Number.isFinite(block.attachment.width)
      ? block.attachment.width
      : undefined;
    const height = typeof block.attachment.height === 'number' && Number.isFinite(block.attachment.height)
      ? block.attachment.height
      : undefined;
    attachments.push({
      kind: 'image',
      ...(typeof block.attachment.name === 'string' ? { name: block.attachment.name } : {}),
      ...(typeof block.attachment.mediaType === 'string' ? { mediaType: block.attachment.mediaType } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    })
  }
  return attachments
}

function attachmentProjection(data: unknown): { attachments?: ReturnType<typeof messageAttachments> } {
  const attachments = messageAttachments(data);
  return attachments.length > 0 ? { attachments } : {};
}

/**
 * 宿主持久化图片引用（ImageAttachmentRef）的原样对象。
 *
 * 只要求 `attachmentId`；其余字段（mediaType/bytes/width/height/name/
 * originalDimensions…）由宿主生成、由宿主读取时自行核对，这里原样保留、不做
 * 字段裁剪，免得宿主以后新增必填字段时被插件悄悄丢掉。
 */
export type HostImageRef = Readonly<Record<string, unknown> & { attachmentId: string }>

/**
 * 取出一条事件里手机能看到的图片引用，供附件读回补全参数。
 *
 * 范围与投影保持一致：只看 user/message 与成功的 tool/result——手机只会拿到这两
 * 类行上的 attachmentId，不在投影里的图片也不该被读回。
 * 职责：DSH 0.2.2 起宿主读图接口要完整引用，且不再核对会话是否引用过这张图；
 * Bridge 用这里收集的引用同时完成「补全参数」和「会话归属校验」。
 */
export function eventImageRefs(event: SessionEventLike): HostImageRef[] {
  let message: unknown
  if (event.type === 'user/message') message = event.data
  else if (event.type === 'tool/result') {
    const result = toolResultOf(event.data)
    if (result.failed) return []
    message = result.message
  } else return []
  if (!message || typeof message !== 'object') return []
  // user/message 外层是 {turn, step, message}，tool/result 已经是 message 本身。
  const inner = (message as { message?: unknown }).message
  const content = (inner && typeof inner === 'object' ? inner as { content?: unknown } : message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const refs: HostImageRef[] = []
  for (const part of content) {
    const block = part as { type?: unknown; attachment?: unknown } | null
    if (!block || block.type !== 'image') continue
    const ref = block.attachment as { attachmentId?: unknown } | undefined
    if (!ref || typeof ref !== 'object') continue
    if (typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0) continue
    refs.push({ ...(ref as Record<string, unknown>), attachmentId: ref.attachmentId })
  }
  return refs
}

/** Extract reasoning ("thinking") text from assistant message payloads. */
function messageThinking(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as { content?: unknown; message?: unknown };
  // Session events wrap the message: {turn, step, message: {role, content}}
  if (obj.message && typeof obj.message === 'object') return messageThinking(obj.message);
  return reasoningContent(obj.content);
}

function reasoningContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (part && typeof part === 'object') {
      const piece = part as { type?: string; text?: string };
      if (piece.type === 'reasoning' && typeof piece.text === 'string') return piece.text;
    }
    return '';
  }).join('');
}

/** Stream chunk type of an assistant/chunk payload ('' when unwrapped). */
function chunkTypeOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as { chunk?: unknown };
  if (obj.chunk && typeof obj.chunk === 'object') {
    return String((obj.chunk as { type?: unknown }).type ?? '');
  }
  // Unwrapped payloads carry plain text deltas.
  return 'text-delta';
}

function chunkText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  // StreamChunk shape: {turn, step, chunk: {type: 'text-delta'|'reasoning-delta', text}}
  const obj = data as { chunk?: unknown };
  if (obj.chunk && typeof obj.chunk === 'object') {
    const inner = obj.chunk as { type?: string; text?: string };
    if ((inner.type === 'text-delta' || inner.type === 'reasoning-delta') && typeof inner.text === 'string') {
      return inner.text;
    }
    return '';
  }
  const direct = data as { text?: unknown };
  return typeof direct.text === 'string' ? direct.text : '';
}

function editField(name: unknown, raw: unknown): { edit?: ToolEditProjection } {
  const edit = toolEditOf(name, raw)
  return edit ? { edit } : {}
}

function targetField(name: unknown, raw: unknown): { target?: ToolTargetProjection } {
  const target = toolTargetOf(name, raw)
  return target ? { target } : {}
}

/** `tool.target.value` / `scope` 的 UTF-8 上限。 */
export const MAX_TOOL_TARGET_VALUE_BYTES = 1024
/** `tool.target.label` 的 UTF-8 上限。 */
export const MAX_TOOL_TARGET_LABEL_BYTES = 256

/** 读写文件类工具：路径即操作对象。 */
const PATH_TARGET_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor'])
/** 搜索类工具：搜索式为主值，搜索目录为范围。 */
const PATTERN_TARGET_TOOLS = new Set(['grep', 'glob'])
/** 网页类工具：有网址给网址，否则给查询词。 */
const WEB_TARGET_TOOLS = new Set(['web_fetch', 'web_search'])
/** 协作类工具：对象是另一个智能体或后台任务，按工具各取一个能认出对象的参数。 */
const TEXT_TARGET_KEYS: Record<string, readonly string[]> = {
  send_message: ['agent', 'target', 'agent_id'],
  spawn_teammate: ['name'],
  subagent: ['description'],
  job_output: ['job_id'],
}

/**
 * 从工具调用的原始参数里挑出操作对象，归一化成 `ToolTargetProjection`。
 *
 * 为什么需要它：`tool.summary` 在结果回来后被替换成结果摘要（read 变成文件正文片段），
 * 客户端从此拿不到「读的是哪个文件」。target 只在调用时生成一次，结果合并时不动。
 * 规则表之外的工具、无法解析或缺少对应参数时返回 undefined，客户端退回 summary。
 * 参数名只在这里出现，客户端不依赖宿主工具参数命名。
 */
export function toolTargetOf(name: unknown, raw: unknown): ToolTargetProjection | undefined {
  if (typeof name !== 'string' || typeof raw !== 'string' || raw.length === 0) return undefined
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    args = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  /** 取第一个非空字符串参数。 */
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
  }

  if (PATH_TARGET_TOOLS.has(name)) {
    const path = pick('file_path', 'path')
    return path ? { kind: 'path', value: boundPath(path) } : undefined
  }
  if (name === 'bash') {
    const command = pick('command')
    if (!command) return undefined
    const label = pick('description')
    return {
      kind: 'command',
      value: boundText(command, MAX_TOOL_TARGET_VALUE_BYTES),
      ...(label ? { label: boundText(label, MAX_TOOL_TARGET_LABEL_BYTES) } : {}),
    }
  }
  if (PATTERN_TARGET_TOOLS.has(name)) {
    const pattern = pick('pattern')
    if (!pattern) return undefined
    const scope = pick('path')
    return {
      kind: 'pattern',
      value: boundText(pattern, MAX_TOOL_TARGET_VALUE_BYTES),
      ...(scope ? { scope: boundPath(scope) } : {}),
    }
  }
  if (WEB_TARGET_TOOLS.has(name)) {
    const url = pick('url')
    if (url) return { kind: 'url', value: boundText(url, MAX_TOOL_TARGET_VALUE_BYTES) }
    const query = pick('query')
    return query ? { kind: 'text', value: boundText(query, MAX_TOOL_TARGET_VALUE_BYTES) } : undefined
  }
  const keys = TEXT_TARGET_KEYS[name]
  if (keys) {
    const text = pick(...keys)
    return text ? { kind: 'text', value: boundText(text, MAX_TOOL_TARGET_VALUE_BYTES) } : undefined
  }
  return undefined
}

/** 命令 / 文本：空白折叠成单个空格（手机上只显示一行），超限砍结尾加「…」。 */
function boundText(value: string, maxBytes: number): string {
  const flat = value.replace(/\s+/g, ' ')
  if (Buffer.byteLength(flat, 'utf8') <= maxBytes) return flat
  return truncateUtf8(flat, maxBytes - Buffer.byteLength('…', 'utf8')) + '…'
}

/** 路径：超限时砍开头、保留结尾（如 `…/Views/A.swift`），保证文件名完整可认。 */
function boundPath(value: string): string {
  const maxBytes = MAX_TOOL_TARGET_VALUE_BYTES
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const budget = maxBytes - Buffer.byteLength('…', 'utf8')
  // 从结尾往前找能放下的最长后缀；二分同 truncateUtf8。
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(value.length - mid), 'utf8') <= budget) low = mid
    else high = mid - 1
  }
  let start = value.length - low
  // 不从代理对的后半截开始。
  if (start < value.length && /[\uDC00-\uDFFF]/.test(value[start]!)) start += 1
  return '…' + value.slice(start)
}

function summarizeArgs(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') parts.push(key + '=' + truncate(value.replace(/\s+/g, ' '), 60));
    }
    return truncate(parts.join(' '), 90);
  } catch {
    return truncate(raw, 90);
  }
}

/** 宿主的文件编辑工具名（DSH `dsh-tool-str-replace-editor`）。 */
const EDITOR_TOOL_NAME = 'str_replace_editor'
/** 宿主的字符串替换工具（`file_path` / `old_string` / `new_string` / `replace_all`），实际会话里最常用。 */
const EDIT_TOOL_NAME = 'edit'
/** 宿主的整文件写入工具（`file_path` / `content`）。 */
const WRITE_TOOL_NAME = 'write'
/** 改动正文单侧上限（UTF-8 字节）；超出则两侧都不发，只标 truncated。 */
export const MAX_TOOL_EDIT_TEXT_BYTES = 16 * 1024

/**
 * 把编辑类工具调用的原始参数归一化成 `ToolEditProjection`。
 *
 * 认三种宿主工具，其他工具或无法解析的参数返回 undefined，工具行保持原样：
 * - `edit`：`old_string` → `new_string` 为 `replace`；`old_string` 为空串视为新建（`create`）。
 * - `write`：`content` 为写入后的文件全文，记作 `create`（宿主覆盖已有文件时也一样，原文拿不到）。
 * - `str_replace_editor`：`str_replace` / `create` / `insert`（`view` 不改文件）。
 * 与 iOS `ToolEditDiff.parse` 的解析口径一致：新文本缺失视为删除（空串）。
 */
export function toolEditOf(name: unknown, raw: unknown): ToolEditProjection | undefined {
  if (name !== EDITOR_TOOL_NAME && name !== EDIT_TOOL_NAME && name !== WRITE_TOOL_NAME) return undefined
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    args = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (name === EDIT_TOOL_NAME || name === WRITE_TOOL_NAME) {
    const edit = plainEditOf(name, args)
    return edit ? boundedEdit(edit) : undefined
  }
  const path = args.path
  if (typeof path !== 'string' || path.length === 0) return undefined
  let edit: ToolEditProjection
  switch (args.command) {
    case 'str_replace':
      if (typeof args.old_str !== 'string') return undefined
      edit = { path, operation: 'replace', oldText: args.old_str, newText: typeof args.new_str === 'string' ? args.new_str : '' }
      break
    case 'create':
      if (typeof args.file_text !== 'string') return undefined
      edit = { path, operation: 'create', newText: args.file_text }
      break
    case 'insert':
      if (typeof args.new_str !== 'string') return undefined
      edit = {
        path, operation: 'insert', newText: args.new_str,
        ...(Number.isSafeInteger(args.insert_line) ? { insertLine: args.insert_line as number } : {}),
      }
      break
    default:
      return undefined
  }
  return boundedEdit(edit)
}

/** `edit` / `write` 的参数（路径键为 `file_path`）。 */
function plainEditOf(name: string, args: Record<string, unknown>): ToolEditProjection | undefined {
  const path = args.file_path
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (name === WRITE_TOOL_NAME) {
    return typeof args.content === 'string' ? { path, operation: 'create', newText: args.content } : undefined
  }
  if (typeof args.old_string !== 'string') return undefined
  const newText = typeof args.new_string === 'string' ? args.new_string : ''
  return args.old_string.length === 0
    ? { path, operation: 'create', newText }
    : { path, operation: 'replace', oldText: args.old_string, newText }
}

/** 任一侧正文超过上限时两侧都不发，只留路径、操作与 truncated。 */
function boundedEdit(edit: ToolEditProjection): ToolEditProjection {
  const oversized = [edit.oldText, edit.newText]
    .some((text) => text !== undefined && Buffer.byteLength(text, 'utf8') > MAX_TOOL_EDIT_TEXT_BYTES)
  return oversized ? withoutEditBodies(edit) : edit
}

/** 去掉改动正文，只留路径、操作与 truncated 标记（超限或整条消息超限时用）。 */
function withoutEditBodies(edit: ToolEditProjection): ToolEditProjection {
  return {
    path: edit.path,
    operation: edit.operation,
    ...(edit.insertLine !== undefined ? { insertLine: edit.insertLine } : {}),
    truncated: true,
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * `touched`（可选，增量 tail 用）：记录每一行最后一次被哪个事件改动，键为行的 seq。
 * 行由自身事件生成时等于它的 seq；工具结果合并回较早的工具调用行时更新为结果事件的
 * seq。增量 tail 据此找出「sinceSeq 之后改动过的行」，而不只是 seq 更大的行。
 */
export function projectHistory(
  events: Array<{ event: SessionEventLike; view?: unknown }>,
  touched?: Map<number, number>,
): MessageProjection[] {
  const messages: MessageProjection[] = [];
  const toolByCall = new Map<string, MessageProjection>();
  for (const entry of events) {
    const event = entry.event;
    const base = { seq: event.seq, ts: tsOf(event) };
    touched?.set(event.seq, Math.max(touched.get(event.seq) ?? event.seq, event.seq));
    switch (event.type) {
      // DSH 0.1.5 (session format V3) records the system prompt in message
      // history as a native `system/message` surface event. It is
      // model-facing prompt prose, not conversation content — see
      // projectEvent for the rationale. Skip explicitly.
      case 'system/message':
        break;
      case 'user/message':
        messages.push({
          ...base,
          role: userRoleOf(event.data),
          text: messageText(event.data),
          ...attachmentProjection(event.data),
          ...(contextProjectionOf(event.data)),
        });
        break;
      case 'assistant/message': {
        const text = messageText(event.data);
        const thinking = messageThinking(event.data);
        if (!text.trim() && !thinking.trim()) break;
        messages.push({ ...base, role: 'assistant', text, ...(thinking ? { thinking } : {}) });
        break;
      }
      case 'tool/call': {
        const data = event.data as { name?: string; arguments?: string; callId?: string } | undefined;
        const row: MessageProjection = {
          ...base,
          role: 'tool',
          tool: {
            name: String(data?.name ?? 'tool'),
            state: 'running',
            summary: summarizeArgs(data?.arguments),
            ...editField(data?.name, data?.arguments),
            ...targetField(data?.name, data?.arguments),
          },
        };
        messages.push(row);
        if (data?.callId) toolByCall.set(String(data.callId), row);
        break;
      }
      case 'tool/result': {
        const { callId, failed, message } = toolResultOf(event.data);
        const target = callId ? toolByCall.get(callId) : undefined;
        const summary = failed ? '失败' : summarizeResult(message?.content);
        // A tool result may carry images as well as text — browser and
        // computer-use backends return screenshots this way. `summarizeResult`
        // covers only the textual part, so project the binary blocks as
        // attachments too; otherwise the phone renders a text-only summary and
        // the image is silently dropped. The durable attachmentId is what lets
        // the client read the bytes back through c2s.session.attachment.
        const attachments = failed ? {} : attachmentProjection(message);
        if (target?.tool) {
          target.tool = { ...target.tool, state: failed ? 'error' : 'ok', summary };
          if (attachments.attachments) Object.assign(target, attachments);
          touched?.set(target.seq, Math.max(touched.get(target.seq) ?? target.seq, event.seq));
        } else {
          messages.push({
            ...base,
            role: 'tool',
            tool: { name: 'result', state: failed ? 'error' : 'ok', summary },
            ...attachments,
          });
        }
        break;
      }
      case 'turn/end': {
        const errorText = turnEndFailureText(event.data);
        if (!errorText) break;
        messages.push({
          ...base,
          role: 'error',
          text: errorText,
        });
        break;
      }
      default:
        break;
    }
  }
  return canonicalSessionMessages(messages.map(limitMessageProjection));
}

/**
 * Enforce PROTOCOL.md's per-message 256 KB ceiling by UTF-8 JSON byte size.
 * Keep structural identity and attachment references intact; progressively
 * shorten human-readable fields until the serialized projection fits.
 */
export function limitMessageProjection(message: MessageProjection): MessageProjection {
  if (jsonBytes(message) <= MAX_MESSAGE_PROJECTION_BYTES) return message
  const next: MessageProjection = {
    ...message,
    ...(message.tool ? {
      tool: {
        ...message.tool,
        name: truncateUtf8(message.tool.name, 4 * 1024),
        summary: truncateUtf8(message.tool.summary, 64 * 1024),
        // 整条消息超限时先丢改动正文（不截半段，半段对比会误导），只留路径与 truncated。
        ...(message.tool.edit ? { edit: withoutEditBodies(message.tool.edit) } : {}),
      },
    } : {}),
    ...(message.attachments ? {
      attachments: message.attachments.slice(0, 16).map((attachment) => ({
        ...attachment,
        ...(attachment.name ? { name: truncateUtf8(attachment.name, 4 * 1024) } : {}),
        ...(attachment.mediaType ? { mediaType: truncateUtf8(attachment.mediaType, 256) } : {}),
        ...(attachment.attachmentId ? { attachmentId: truncateUtf8(attachment.attachmentId, 4 * 1024) } : {}),
      })),
    } : {}),
    ...(message.context ? {
      context: {
        ...(message.context.label ? { label: truncateUtf8(message.context.label, 8 * 1024) } : {}),
        ...(message.context.form ? { form: truncateUtf8(message.context.form, 256) } : {}),
      },
    } : {}),
    truncated: true,
  }

  const textFields: Array<{
    get: () => string
    set: (value: string) => void
  }> = []
  if (typeof next.text === 'string') textFields.push({
    get: () => next.text ?? '',
    set: (value) => { next.text = value },
  })
  if (typeof next.thinking === 'string') textFields.push({
    get: () => next.thinking ?? '',
    set: (value) => { next.thinking = value },
  })
  if (next.tool) textFields.push({
    get: () => next.tool?.summary ?? '',
    set: (value) => { if (next.tool) next.tool.summary = value },
  })
  if (next.context?.label) textFields.push({
    get: () => next.context?.label ?? '',
    set: (value) => { if (next.context) next.context.label = value },
  })

  while (jsonBytes(next) > MAX_MESSAGE_PROJECTION_BYTES) {
    const largest = textFields
      .map((field) => ({ field, bytes: Buffer.byteLength(field.get(), 'utf8') }))
      .sort((a, b) => b.bytes - a.bytes)[0]
    if (largest && largest.bytes > 0) {
      largest.field.set(truncateUtf8(largest.field.get(), Math.floor(largest.bytes / 2)))
      continue
    }
    if (next.attachments && next.attachments.length > 0) {
      next.attachments = next.attachments.slice(0, -1)
      continue
    }
    break
  }
  return next
}

function limitRealtimeText(data: { text: string; ts: number }): Record<string, unknown> {
  if (jsonBytes(data) <= MAX_MESSAGE_PROJECTION_BYTES) return data
  let text = data.text
  const next: Record<string, unknown> = { ...data, truncated: true }
  while (jsonBytes(next) > MAX_MESSAGE_PROJECTION_BYTES && text.length > 0) {
    text = truncateUtf8(text, Math.floor(Buffer.byteLength(text, 'utf8') / 2))
    next.text = text
  }
  return next
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = value.slice(0, mid)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  let end = low
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1
  return value.slice(0, end)
}

function summarizeResult(content: unknown): string {
  const text = contentText(content).replace(/\s+/g, ' ').trim();
  return truncate(text, 90);
}

// ---------- 历史分页窗口 ----------

/** 参与窗口计算的原始事件：可投影的最小形状。 */
export interface HistoryWindowEvent {
  type: string
  seq: number
  time?: number
  data?: unknown
}

export interface HistoryWindowOptions {
  /** 只取 seq 严格小于该值的事件（翻页边界）。 */
  beforeSeq?: number
  /** 目标消息条数；小于 1 一律按 1 处理。 */
  limit: number
}

export interface HistoryWindow {
  /** 窗口内的原始事件，旧→新，含投影为空者。 */
  events: Array<{ event: HistoryWindowEvent }>
  /** 起点之前是否还有更多事件（客户端可继续翻页）。 */
  hasMore: boolean
}

/** 一页能要多少条消息：wire 校验与 bridge clamp 共用这一条规则。 */
export const MIN_HISTORY_PAGE_MESSAGES = 1
export const MAX_HISTORY_PAGE_MESSAGES = 500
/** 打开会话时的默认尾部条数。 */
export const DEFAULT_HISTORY_PAGE_MESSAGES = 100
/** 打开会话时至少要拉多少条：少于这个数客户端一屏都铺不满。 */
export const MIN_TAIL_MESSAGES = 10

/** 把 wire 声明的页大小收敛到合法区间。 */
export function normalizePageLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(MIN_HISTORY_PAGE_MESSAGES, Math.min(MAX_HISTORY_PAGE_MESSAGES, value))
    : DEFAULT_HISTORY_PAGE_MESSAGES
}

/**
 * 会话历史的分页窗口：从候选事件里取出「投影后末尾 `limit` 条消息」所在的那
 * 一段原始事件。
 *
 * 迁移前这段循环住在 host adapter（dsh-api-proxy.ts 的 sessions.history）里，
 * 按块累积、每轮对累计窗口重跑一次投影（稀疏投影时最坏 O(N²/L)）。它与自己
 * 依赖的投影规则分居两地，而 `projectHistory` 是顺序依赖的（tool/call 与
 * tool/result 靠 toolByCall 配对），所以这里只做一次前向投影，再按消息归属
 * 反推窗口起点。
 *
 * 注意：窗口**不是**最小的那个后缀。现算法按 `limit` 的整数倍从末端取块，
 * 因此窗口可能含若干投影为空的前导事件；本实现按消息归属取起点，同样保留
 * 这些前导事件之前的所有内容——两者的差异由 tests/history-window-parity.test.ts
 * 逐条钉住（75 例确定性语料，含切断 call/result 配对与重复 seq 的形状）。
 */
export function historyWindow(
  source: readonly unknown[],
  options: HistoryWindowOptions,
): HistoryWindow {
  // 页大小走同一条规则：非有限值回落默认，其余收敛到 [1, 500]。
  const limit = normalizePageLimit(options.limit)
  const beforeSeq = options.beforeSeq
  const candidates: HistoryWindowEvent[] = []
  for (const raw of source) {
    if (typeof raw !== 'object' || raw === null) continue
    const event = raw as HistoryWindowEvent
    if (typeof event.type !== 'string' || typeof event.seq !== 'number') continue
    if (beforeSeq !== undefined && !(event.seq < beforeSeq)) continue
    candidates.push(event)
  }
  const entries = candidates.map((event) => ({ event }))
  if (entries.length === 0) return { events: [], hasMore: false }

  const projected = projectHistory(entries)
  if (projected.length <= limit) return { events: entries, hasMore: false }

  // 每条消息对应的原始下标：投影按 seq 去重（后者胜出），因此取该 seq 最后一次
  // 出现的下标。窗口必须包含这些下标，否则消息会被裁掉。
  const lastIndexBySeq = new Map<number, number>()
  for (let index = 0; index < candidates.length; index += 1) {
    lastIndexBySeq.set(candidates[index]!.seq, index)
  }
  const keep = projected.slice(projected.length - limit)
  let front = candidates.length
  for (const message of keep) {
    const index = lastIndexBySeq.get(message.seq)
    if (index !== undefined && index < front) front = index
  }
  // hasMore 只表示「窗口之前还有能产出消息的事件」：旧实现按 limit 整数倍取块，
  // 窗口之前只剩投影为空的前导事件时也报 true，客户端会多发一次翻页才拿到空页。
  // 这里对前缀做一次投影来定性，代价 O(前 `front` 个事件)。
  const older = front > 0 ? projectHistory(entries.slice(0, front)) : []
  return { events: entries.slice(front), hasMore: older.length > 0 }
}
