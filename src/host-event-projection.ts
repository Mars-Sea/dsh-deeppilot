import type { MessageProjection, SessionEventKind } from './protocol.ts'
import type { SessionEventLike } from './host-api.ts'

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
      return { kind: 'turn.end', data: { ok: data?.reason?.kind === 'completed' } };
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
          },
          ts: tsOf(event)
        }
      };
    }
    case 'tool/result': {
      const data = event.data as { callId?: string; error?: unknown } | undefined;
      return {
        kind: 'tool.end',
        data: {
          seq: event.seq,
          role: 'tool',
          ok: !event.data || data?.error === undefined,
          // The seq above identifies this result event; callId is what ties it
          // back to the originating tool/call row on the client.
          ...(data?.callId ? { callId: String(data.callId) } : {}),
          ts: tsOf(event)
        }
      };
    }
    default:
      return null;
  }
}

function tsOf(event: SessionEventLike): number {
  return typeof event.time === 'number' ? event.time : Date.now();
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
        if (piece.type === 'text' && typeof piece.text === 'string') return piece.text;
      }
      return '';
    }).join('');
  }
  return '';
}

function messageAttachments(data: unknown): Array<{
  kind: 'image'
  name?: string
  mediaType?: string
  attachmentId?: string
  width?: number
  height?: number
}> {
  if (!data || typeof data !== 'object') return [];
  const obj = data as { content?: unknown; message?: unknown };
  if (obj.message && typeof obj.message === 'object') return messageAttachments(obj.message);
  if (!Array.isArray(obj.content)) return [];
  return obj.content.flatMap(part => {
    if (!part || typeof part !== 'object') return [];
    // The host normalizes uploaded bytes into an ImageAttachmentRef
    // (attachmentId/mediaType/bytes/width/height...); the id is what clients
    // need to read the image back through c2s.session.attachment.
    const block = part as {
      type?: string
      attachment?: {
        name?: unknown
        mediaType?: unknown
        attachmentId?: unknown
        width?: unknown
        height?: unknown
      }
    };
    if (block.type !== 'image' || !block.attachment) return [];
    const attachmentId = typeof block.attachment.attachmentId === 'string' && block.attachment.attachmentId.length > 0
      ? block.attachment.attachmentId
      : undefined;
    const width = typeof block.attachment.width === 'number' && Number.isFinite(block.attachment.width)
      ? block.attachment.width
      : undefined;
    const height = typeof block.attachment.height === 'number' && Number.isFinite(block.attachment.height)
      ? block.attachment.height
      : undefined;
    return [{
      kind: 'image' as const,
      ...(typeof block.attachment.name === 'string' ? { name: block.attachment.name } : {}),
      ...(typeof block.attachment.mediaType === 'string' ? { mediaType: block.attachment.mediaType } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }];
  });
}

function attachmentProjection(data: unknown): { attachments?: ReturnType<typeof messageAttachments> } {
  const attachments = messageAttachments(data);
  return attachments.length > 0 ? { attachments } : {};
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function projectHistory(events: Array<{ event: SessionEventLike; view?: unknown }>): MessageProjection[] {
  const messages: MessageProjection[] = [];
  const toolByCall = new Map<string, MessageProjection>();
  for (const entry of events) {
    const event = entry.event;
    const base = { seq: event.seq, ts: tsOf(event) };
    switch (event.type) {
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
          tool: { name: String(data?.name ?? 'tool'), state: 'running', summary: summarizeArgs(data?.arguments) },
        };
        messages.push(row);
        if (data?.callId) toolByCall.set(String(data.callId), row);
        break;
      }
      case 'tool/result': {
        const data = event.data as { callId?: string; message?: { content?: unknown }; error?: unknown } | undefined;
        const callId = data?.callId ? String(data.callId) : undefined;
        const target = callId ? toolByCall.get(callId) : undefined;
        const failed = data?.error !== undefined;
        const summary = failed ? '失败' : summarizeResult(data?.message?.content);
        if (target?.tool) {
          target.tool = { ...target.tool, state: failed ? 'error' : 'ok', summary };
        } else {
          messages.push({ ...base, role: 'tool', tool: { name: 'result', state: failed ? 'error' : 'ok', summary } });
        }
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
