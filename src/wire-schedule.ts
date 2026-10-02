/**
 * 定时任务特性的 wire 行：列表、历史、创建、修改、删除。
 *
 * scope 取 `schedule.manage` + `sessions.read`：PROTOCOL.md scope 映射表写明
 * 「`schedule.manage` 定时任务/提醒的列表、历史、创建、修改和删除；同时需要
 * `sessions.read` 才能读取任务内容」。迁移前这条组合一半住在 requiredScope、
 * 一半住在 connection.ts 调用点的一行补充规则里（334-336），现在是一行声明。
 *
 * 五个帧共享一个能力位 `schedules`；该位现在只要求 Schedule 服务存在
 * （见 host-capabilities.ts 的 G4 修正）。
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
      if (
        !isText(checked.value.sessionId) ||
        !isText(checked.value.id) ||
        !isInteger(checked.value.limit, 1, 100) ||
        !isOptionalField(checked.value, 'before', (v) => isText(v))
      ) {
        return reject('E_PROTOCOL', 'invalid schedule history')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const result = await ctx.bridge.scheduleHistory(
        payload.sessionId as string,
        payload.id as string,
        payload.limit as number,
        payload.before as string | undefined,
      )
      if (!result.ok) return ctx.fail(result.code, result.message)
      ctx.send('s2c.schedule.history', { sessionId: payload.sessionId, history: result.value })
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
]
