/**
 * 定时任务特性的 wire 行：会话级（列表、历史、创建、修改、删除）与宿主级
 * （list/view/create/edit/run/limits）两套。
 *
 * scope 取 `schedule.manage` + `sessions.read`：PROTOCOL.md scope 映射表写明
 * 「`schedule.manage` 定时任务/提醒的列表、历史、创建、修改和删除；同时需要
 * `sessions.read` 才能读取任务内容」。迁移前这条组合一半住在 requiredScope、
 * 一半住在 connection.ts 调用点的一行补充规则里（334-336），现在是一行声明。
 *
 * 五个会话级帧共享能力位 `schedules`；该位现在只要求 Schedule 服务存在
 * （见 host-capabilities.ts 的 G4 修正）。六个宿主级帧共享 `schedulesHost`：
 * 该位由 adapter 判别位推导，false/缺失时新帧一律 E_UNSUPPORTED，客户端只能
 * 走会话级帧（PROTOCOL.md「Schedule 宿主级任务扩展」）。
 */

import { validSendId } from './connection-policy.ts'
import {
  accept,
  isInteger,
  isOptionalField,
  isText,
  payloadObject,
  reject,
  type WireFrameRow,
} from './wire-registry.ts'

/** PROTOCOL.md scope 映射表：schedule.manage 需搭配 sessions.read。 */
const SCHEDULE_SCOPES: WireFrameRow['scopes'] = ['schedule.manage', 'sessions.read']

/** 普通 JSON 对象（宿主级 timing/target/patch 都是嵌套对象）。 */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{time, time_zone}` 本地时间输入：取值合法性由 Host 完整校验。 */
function isLocalTimeInput(value: unknown): boolean {
  const row = value as Record<string, unknown>
  return isObjectValue(value) && isText(value.time) && isText(value.time_zone)
}

function isWeekdayList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((day) => isInteger(day, 1, 7))
}

/**
 * 宿主级 timing 判别联合的形状检查。
 *
 * 只判结构与数量级（PROTOCOL.md 章节限额）；日期格式、时区与频率是否可达由
 * Host 的 Schedule 服务负责——重复一遍只会制造两套口径。
 */
function isHostTiming(value: unknown): boolean {
  if (!isObjectValue(value)) return false
  switch (value.kind) {
    case 'after':
      return isInteger(value.after_seconds, 1, Number.MAX_SAFE_INTEGER)
    case 'at':
      return isText(value.at) || (
        isObjectValue(value.at) &&
        isText(value.at.date) &&
        isText(value.at.time) &&
        isText(value.at.time_zone)
      )
    case 'every':
      return isInteger(value.every_seconds, 60, Number.MAX_SAFE_INTEGER)
    case 'daily':
      return isLocalTimeInput(value.daily)
    case 'weekly':
      return isObjectValue(value.weekly) &&
        isLocalTimeInput(value.weekly) &&
        isWeekdayList(value.weekly.weekdays)
    case 'cron':
      return isObjectValue(value.cron) &&
        isText(value.cron.expression) &&
        isText(value.cron.time_zone)
    case 'rrule':
      return isText(value.rrule)
    default:
      return false
  }
}

/** `{cwd?, agentPreset?}`：省略即 Host 默认。 */
function isHostCreateSpec(value: unknown): boolean {
  return isObjectValue(value) &&
    isOptionalField(value, 'cwd', (v) => isText(v)) &&
    isOptionalField(value, 'agentPreset', (v) => isText(v))
}

/**
 * 创建/编辑请求里的 target。`session` 必须给 sessionId；`new_once`/`new` 的
 * 会话由 Host 预留或新建，`create` 省略即默认。客户端若把查看结果里的
 * `new_once.sessionId` 原样回传，也接受（未知/冗余字段不该让编辑失败）。
 */
function isHostTarget(value: unknown): boolean {
  if (!isObjectValue(value)) return false
  switch (value.kind) {
    case 'session':
      return isText(value.sessionId)
    case 'new_once':
      return isOptionalField(value, 'sessionId', (v) => isText(v)) &&
        isOptionalField(value, 'create', isHostCreateSpec)
    case 'new':
      return isOptionalField(value, 'create', isHostCreateSpec)
    default:
      return false
  }
}

/** 编辑补丁：至少一个字段，且各字段形状合法。 */
function isHostPatch(value: unknown): boolean {
  if (!isObjectValue(value)) return false
  const present = ['title', 'prompt', 'timing', 'target', 'active']
    .filter((key) => value[key] !== undefined)
  if (present.length === 0) return false
  return isOptionalField(value, 'title', (v) => isText(v, 120)) &&
    isOptionalField(value, 'prompt', (v) => isText(v, 256 * 1024)) &&
    isOptionalField(value, 'timing', isHostTiming) &&
    isOptionalField(value, 'target', isHostTarget) &&
    isOptionalField(value, 'active', (v) => typeof v === 'boolean')
}


export const scheduleRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.schedule.list',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedules',
    doc: 'PROTOCOL.md c2s.schedule.list',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!isText(checked.value.sessionId)) return reject('E_PROTOCOL', 'invalid sessionId')
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.listSchedules(payload.sessionId as string)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.snapshot', { sessionId: payload.sessionId, tasks: result.value })
    },
  },
  {
    type: 'c2s.schedule.history',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedules',
    doc: 'PROTOCOL.md c2s.schedule.history',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      // 宿主级模型下 sessionId 可选并被忽略（PROTOCOL.md「投递历史」）；会话级
      // 宿主仍要求它，但那条边界放在 handler，校验只描述形状。
      if (
        !isOptionalField(checked.value, 'sessionId', (v) => isText(v)) ||
        !isText(checked.value.id) ||
        !isInteger(checked.value.limit, 1, 100) ||
        !isOptionalField(checked.value, 'before', (v) => isText(v))
      ) {
        return reject('E_PROTOCOL', 'invalid schedule history')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const sessionId = payload.sessionId as string | undefined
      // 会话级宿主上缺少 sessionId 仍是非法载荷：判定与扩展前的校验逐字一致
      // （E_PROTOCOL + 同一句话），只是改在 handler 判，因为校验拿不到宿主形态。
      if (sessionId === undefined && ctx.bridge.capabilities.schedulesHost !== true) {
        return ctx.fail('E_PROTOCOL', 'invalid schedule history')
      }
      const result = await ctx.bridge.scheduleHistory(
        sessionId ?? '',
        payload.id as string,
        payload.limit as number,
        payload.before as string | undefined,
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.history', {
        ...(sessionId !== undefined ? { sessionId } : {}),
        history: result.value,
      })
    },
  },
  {
    type: 'c2s.schedule.create',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedules',
    doc: 'PROTOCOL.md c2s.schedule.create',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (
        !validSendId(p.clientRequestId) ||
        !isText(p.sessionId) ||
        !isText(p.title, 120) ||
        !isText(p.prompt, 256 * 1024)
      ) {
        return reject('E_PROTOCOL', 'invalid schedule create fields')
      }
      // 恰好一个时机选择器：after_seconds / at / every_seconds / daily / weekly / cron。
      const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']
        .filter((key) => p[key] !== undefined)
      if (selectors.length !== 1) return reject('E_PROTOCOL', 'schedule requires exactly one selector')
      if (p.after_seconds !== undefined && !isInteger(p.after_seconds, 1, Number.MAX_SAFE_INTEGER)) {
        return reject('E_PROTOCOL', 'invalid after_seconds')
      }
      if (p.every_seconds !== undefined && !isInteger(p.every_seconds, 60, Number.MAX_SAFE_INTEGER)) {
        return reject('E_PROTOCOL', 'invalid every_seconds')
      }
      if (
        p.at !== undefined &&
        typeof p.at !== 'string' &&
        (typeof p.at !== 'object' || p.at === null || Array.isArray(p.at))
      ) {
        return reject('E_PROTOCOL', 'invalid at selector')
      }
      return accept(p)
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.createSchedule(
        ctx.deviceId!,
        payload as Record<string, unknown> & { sessionId: string; clientRequestId: string; title: string; prompt: string },
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.updated', {
        clientRequestId: payload.clientRequestId,
        sessionId: payload.sessionId,
        task: result.value,
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  {
    type: 'c2s.schedule.update',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedules',
    doc: 'PROTOCOL.md c2s.schedule.update',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (
        !validSendId(p.clientRequestId) ||
        !isText(p.sessionId) ||
        !isText(p.id) ||
        p.expected === undefined ||
        typeof p.expected !== 'object' ||
        Array.isArray(p.expected)
      ) {
        return reject('E_PROTOCOL', 'invalid schedule update fields')
      }
      if (
        !isOptionalField(p, 'title', (v) => isText(v, 120)) ||
        !isOptionalField(p, 'prompt', (v) => isText(v, 256 * 1024))
      ) {
        return reject('E_PROTOCOL', 'invalid schedule update content')
      }
      if (
        p.change !== undefined &&
        (typeof p.change !== 'object' || p.change === null || Array.isArray(p.change))
      ) {
        return reject('E_PROTOCOL', 'invalid schedule timing change')
      }
      return accept(p)
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.updateSchedule(
        ctx.deviceId!,
        payload as Record<string, unknown> & { sessionId: string; id: string; clientRequestId: string; expected: unknown },
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.updated', {
        clientRequestId: payload.clientRequestId,
        sessionId: payload.sessionId,
        task: result.value,
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  {
    type: 'c2s.schedule.delete',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedules',
    doc: 'PROTOCOL.md c2s.schedule.delete',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (
        !validSendId(checked.value.clientRequestId) ||
        !isText(checked.value.sessionId) ||
        !isText(checked.value.id)
      ) {
        return reject('E_PROTOCOL', 'invalid schedule delete fields')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.deleteSchedule(ctx.deviceId!, {
        sessionId: payload.sessionId as string,
        id: payload.id as string,
        clientRequestId: payload.clientRequestId as string,
      })
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.updated', {
        clientRequestId: payload.clientRequestId,
        sessionId: payload.sessionId,
        deleted: true,
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  // ---------- 宿主级模型（可选 v2，`schedulesHost`） ----------
  // 旧帧在宿主级 Host 上仍由 Bridge 映射（见 host-bridge），因此这六行只服务
  // 认识新能力位的客户端。
  {
    type: 'c2s.schedule.host.list',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedulesHost',
    doc: 'PROTOCOL.md c2s.schedule.host.list',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (
        !isOptionalField(p, 'active', (v) => typeof v === 'boolean') ||
        !isOptionalField(p, 'limit', (v) => isInteger(v, 1, 500)) ||
        !isOptionalField(p, 'offset', (v) => isInteger(v, 0, Number.MAX_SAFE_INTEGER))
      ) {
        return reject('E_PROTOCOL', 'invalid schedule host list')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.listHostSchedules({
        ...(payload.active !== undefined ? { active: payload.active as boolean } : {}),
        ...(payload.limit !== undefined ? { limit: payload.limit as number } : {}),
        ...(payload.offset !== undefined ? { offset: payload.offset as number } : {}),
      })
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.host.snapshot', result.value)
    },
  },
  {
    type: 'c2s.schedule.host.view',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedulesHost',
    doc: 'PROTOCOL.md c2s.schedule.host.view',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!isText(checked.value.id)) return reject('E_PROTOCOL', 'invalid schedule id')
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.viewHostSchedule(payload.id as string)
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.host.task', { task: result.value })
    },
  },
  {
    type: 'c2s.schedule.host.create',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedulesHost',
    doc: 'PROTOCOL.md c2s.schedule.host.create',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (
        !validSendId(p.clientRequestId) ||
        !isText(p.title, 120) ||
        !isText(p.prompt, 256 * 1024) ||
        !isHostTiming(p.timing) ||
        !isOptionalField(p, 'target', isHostTarget)
      ) {
        return reject('E_PROTOCOL', 'invalid schedule host create fields')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.createHostSchedule(
        ctx.deviceId!,
        payload as Record<string, unknown> & {
          clientRequestId: string
          title: string
          prompt: string
          timing: unknown
          target?: unknown
        },
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.updated', {
        clientRequestId: payload.clientRequestId,
        task: result.value,
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  {
    type: 'c2s.schedule.host.edit',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedulesHost',
    doc: 'PROTOCOL.md c2s.schedule.host.edit',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (
        !validSendId(p.clientRequestId) ||
        !isText(p.id) ||
        !isOptionalField(p, 'expectedUpdatedAt', (v) => v === null || isText(v))
      ) {
        return reject('E_PROTOCOL', 'invalid schedule host edit fields')
      }
      if (p.action !== 'update' && p.action !== 'delete') {
        return reject('E_PROTOCOL', 'invalid schedule host edit action')
      }
      // delete 不需要 patch；update 必须有至少一个可写字段。
      if (p.action === 'update' && !isHostPatch(p.patch)) {
        return reject('E_PROTOCOL', 'invalid schedule host edit patch')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.editHostSchedule(
        ctx.deviceId!,
        payload as Record<string, unknown> & {
          clientRequestId: string
          id: string
          action: 'update' | 'delete'
          expectedUpdatedAt?: string | null
          patch?: unknown
        },
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      const value = result.value
      ctx.send('s2c.schedule.updated', {
        clientRequestId: payload.clientRequestId,
        ...('deleted' in value ? { deleted: true } : { task: value.task }),
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  {
    type: 'c2s.schedule.host.run',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedulesHost',
    doc: 'PROTOCOL.md c2s.schedule.host.run',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!validSendId(checked.value.clientRequestId) || !isText(checked.value.id)) {
        return reject('E_PROTOCOL', 'invalid schedule host run fields')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.runHostSchedule(
        ctx.deviceId!,
        { clientRequestId: payload.clientRequestId as string, id: payload.id as string },
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.updated', {
        clientRequestId: payload.clientRequestId,
        task: result.value,
        ...(result.replayed ? { replayed: true } : {}),
      })
    },
  },
  {
    type: 'c2s.schedule.host.limits',
    stage: 'authenticated',
    scopes: SCHEDULE_SCOPES,
    capability: 'schedulesHost',
    doc: 'PROTOCOL.md c2s.schedule.host.limits',
    validate: (payload) => payloadObject(payload),
    handle: async (ctx) => {
      const result = await ctx.bridge.scheduleLimits()
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.host.limits', result.value)
    },
  },
]
