import { validSendId } from './prompt-delivery.ts'
/** Shape and resource limits for authenticated client requests. Unknown fields
 * remain accepted for additive protocol-v2 compatibility. Business validation
 * (supported models, pending choices, permissions) stays with its owner. */
export function validateRequest(type: string, value: unknown): string | undefined {
  const empty = new Set(['c2s.ping', 'c2s.sessions.list', 'c2s.pending.list', 'c2s.workspaces.list', 'c2s.directory.pick'])
  // Device self-revocation takes no required fields: both an omitted payload
  // and `{}` are valid, and `deviceId` is optional (it must equal the
  // authenticated device when present).
  if (value === undefined && (type === 'c2s.session.create' || type === 'c2s.directory.list' || type === 'c2s.device.revoke')) value = {}
  if (value == null && empty.has(type)) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'payload must be an object'
  const p = value as Record<string, unknown>
  const text = (v: unknown, max = 4096, nonempty = true) => typeof v === 'string' && v.length <= max && (!nonempty || v.trim().length > 0)
  const optional = (key: string, check: (v: unknown) => boolean) => p[key] === undefined || check(p[key])
  const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
  if (type.startsWith('c2s.session.') && type !== 'c2s.session.create' && !text(p.sessionId)) return 'invalid sessionId'
  if (type === 'c2s.session.create' && (!optional('workspaceId', v => text(v)) || !optional('cwd', v => text(v, 32768)) || (p.workspaceId !== undefined && p.cwd !== undefined))) return 'invalid workspace selection'
  if (type === 'c2s.directory.list' && !optional('path', v => text(v, 32768, false))) return 'invalid path'
  if (type === 'c2s.schedule.list' && !text(p.sessionId)) return 'invalid sessionId'
  if (type === 'c2s.schedule.history' && (!text(p.sessionId) || !text(p.id) || !integer(p.limit, 1, 100) || !optional('before', v => text(v)))) return 'invalid schedule history'
  if (type === 'c2s.schedule.create') {
    if (!validSendId(p.clientRequestId) || !text(p.sessionId) || !text(p.title, 120) || !text(p.prompt, 256 * 1024)) return 'invalid schedule create fields'
    const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'].filter(key => p[key] !== undefined)
    if (selectors.length !== 1) return 'schedule requires exactly one selector'
    if (p.after_seconds !== undefined && !integer(p.after_seconds, 1, Number.MAX_SAFE_INTEGER)) return 'invalid after_seconds'
    if (p.every_seconds !== undefined && !integer(p.every_seconds, 60, Number.MAX_SAFE_INTEGER)) return 'invalid every_seconds'
    if (p.at !== undefined && typeof p.at !== 'string' && (typeof p.at !== 'object' || p.at === null || Array.isArray(p.at))) return 'invalid at selector'
  }
  if (type === 'c2s.schedule.update') {
    if (!validSendId(p.clientRequestId) || !text(p.sessionId) || !text(p.id) || !p.expected || typeof p.expected !== 'object' || Array.isArray(p.expected)) return 'invalid schedule update fields'
    if (!optional('title', v => text(v, 120)) || !optional('prompt', v => text(v, 256 * 1024))) return 'invalid schedule update content'
    if (p.change !== undefined && (!p.change || typeof p.change !== 'object' || Array.isArray(p.change))) return 'invalid schedule timing change'
  }
  if (type === 'c2s.schedule.delete' && (!validSendId(p.clientRequestId) || !text(p.sessionId) || !text(p.id))) return 'invalid schedule delete fields'
  if (type === 'c2s.session.fork' && (!validSendId(p.clientRequestId) || !optional('atSeq', v => integer(v, 0, Number.MAX_SAFE_INTEGER)))) return 'invalid session fork fields'
  if (type === 'c2s.device.revoke' && !optional('deviceId', v => text(v))) return 'invalid deviceId'
  if (type === 'c2s.workspace.create' && !text(p.path, 32768)) return 'invalid path'
  if (type === 'c2s.session.open' && !optional('tailCount', v => integer(v, 1, 10000))) return 'invalid tailCount'
  if (type === 'c2s.session.history' && (!integer(p.beforeSeq, 0, Number.MAX_SAFE_INTEGER) || !optional('limit', v => integer(v, 1, 500)))) return 'invalid history range'
  if (type === 'c2s.session.rename' && !text(p.title, 4096)) return 'invalid title'
  if (type === 'c2s.session.attachment' && !text(p.attachmentId)) return 'invalid attachmentId'
  if (type === 'c2s.session.selectModel' && (!text(p.provider, 256) || !text(p.model, 1024) || !optional('reasoningEffort', v => text(v, 128, false)))) return 'invalid model selection'
  if (type === 'c2s.session.delivery' && !validSendId(p.clientSendId)) return 'invalid clientSendId'
  if (type === 'c2s.session.sendPrompt') {
    if (p.clientSendId !== undefined && !validSendId(p.clientSendId)) return 'invalid clientSendId'
    if (!optional('text', v => text(v, 256 * 1024, false)) || !optional('images', Array.isArray) || !optional('documents', Array.isArray)) return 'invalid prompt fields'
    for (const key of ['images', 'documents']) {
      const items = p[key] as unknown[] | undefined
      if (items && items.some(v => v === null || typeof v !== 'object' || Array.isArray(v))) return 'invalid attachment'
      for (const item of (items ?? []) as Record<string, unknown>[]) {
        if (item.name !== undefined && !text(item.name, 4096, false)) return 'invalid attachment name'
        if (item.truncated !== undefined && typeof item.truncated !== 'boolean') return 'invalid truncated flag'
      }
    }
  }
  if (type === 'c2s.approval.respond' || type === 'c2s.question.respond') {
    if (!text(p.requestId)) return 'invalid requestId'
  }
  if (type === 'c2s.approval.respond' && (!['allow', 'deny'].includes(p.decision as string) || !optional('reason', v => text(v, 65536, false)))) return 'invalid approval response'
  if (type === 'c2s.question.respond') {
    if (!Array.isArray(p.answers) || p.answers.length > 100) return 'invalid answers'
    const ids = new Set<string>()
    for (const answer of p.answers) {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || !text(answer.id) || ids.has(answer.id) || !Array.isArray(answer.selected) || answer.selected.length > 100 || !answer.selected.every((v: unknown) => text(v, 4096)) || (answer.custom !== undefined && !text(answer.custom, 65536))) return 'invalid answer'
      ids.add(answer.id)
    }
  }
  if (type === 'c2s.liveActivity.register' || type === 'c2s.liveActivity.unregister') {
    if (!text(p.activityId, 128)) return 'invalid activityId'
    if (type === 'c2s.liveActivity.register' &&
        (!text(p.sessionId) || typeof p.deviceToken !== 'string' || !/^[0-9a-fA-F]{32,512}$/.test(p.deviceToken) ||
         !['development', 'production'].includes(p.environment as string) || !optional('enrollKey', v => text(v, 128)))) return 'invalid live activity registration'
  }
  if (type === 'c2s.push.register' || type === 'c2s.widget.push.register') {
    if (p.environment !== undefined && p.environment !== 'production' && p.environment !== 'development') return 'invalid APNs environment'
    if (!optional('enrollKey', v => text(v, 128))) return 'invalid enrollKey'
    if (p.categories !== undefined && (!p.categories || typeof p.categories !== 'object' || Array.isArray(p.categories) || Object.values(p.categories).some(v => typeof v !== 'boolean'))) return 'invalid categories'
  }
}
