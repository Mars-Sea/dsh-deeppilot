/**
 * 离线推送特性的 wire 行：APNs token 注册（手机与小组件两份）与 Live Activity
 * 注册。
 *
 * 三处需要特别注意的次序，迁移前一模一样保留：
 * 1. 零配置注册（enrollKey）必须早于 push 能力门——首次注册恰恰发生在推送尚未
 *    就绪时，而钥匙本身会把中继模式打开；
 * 2. token 写入必须早于就绪门——推送还在引导中或中继临时不可用时，token 已落盘，
 *    恢复后无需重新注册；
 * 3. 任何 await 之后都要重新读取设备记录：权限可能在等待期间被改窄。
 */

import type { ApnsEnvironment } from './token.ts'
import { isValidApnsToken } from './token.ts'
import {
  isOptionalField,
  isText,
  payloadObject,
  reject,
  type WireFrameRow,
} from './wire-registry.ts'

/** Live Activity 需要的三个 scope：通知注册 + 会话读取 + 交互应答。 */
const LIVE_ACTIVITY_SCOPES: WireFrameRow['scopes'] = [
  'notifications.register',
  'sessions.read',
  'interactions.respond',
]

/** 小组件总览需要的三个 scope：与 Live Activity 同组（PROTOCOL.md 下行权限一节）。 */
const WIDGET_PUSH_SCOPES: WireFrameRow['scopes'] = [
  'notifications.register',
  'sessions.read',
  'interactions.respond',
]

/** enrollKey 的清洗：只保留可打印 ASCII，截到 128（与迁移前逐字一致）。 */
function cleanEnrollKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[^\x20-\x7e]/g, '').slice(0, 128) : ''
}

export const pushRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.push.register',
    stage: 'authenticated',
    scopes: ['notifications.register'],
    // 注意：不在此声明 capability 门。零配置注册（enrollKey）必须先于 push
    // 能力门执行——首次注册恰恰发生在推送尚未就绪时。门由 handler 在注册之后
    // 就地检查，与迁移前的次序一致。
    doc: 'PROTOCOL.md c2s.push.register',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      // token 的形状检查原在 handler 内（G3）；此处并入校验，接受集不变。
      const token = typeof p.deviceToken === 'string' ? (p.deviceToken as string).trim() : ''
      if (!isValidApnsToken(token)) return reject('E_PROTOCOL', 'hex deviceToken (32-512 chars) required')
      if (p.environment !== undefined && p.environment !== 'production' && p.environment !== 'development') {
        return reject('E_PROTOCOL', 'invalid APNs environment')
      }
      if (!isOptionalField(p, 'enrollKey', (v) => isText(v, 128))) return reject('E_PROTOCOL', 'invalid enrollKey')
      if (
        p.categories !== undefined &&
        (typeof p.categories !== 'object' || p.categories === null || Array.isArray(p.categories) ||
          Object.values(p.categories as Record<string, unknown>).some((v) => typeof v !== 'boolean'))
      ) {
        return reject('E_PROTOCOL', 'invalid categories')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const deviceId = ctx.deviceId
      if (deviceId === undefined) return ctx.fail('E_INTERNAL', 'device identity unavailable')
      const token = String(payload.deviceToken).trim()
      const environment: ApnsEnvironment = payload.environment === 'production' ? 'production' : 'development'
      const categories = typeof payload.categories === 'object' && payload.categories !== null
        ? (payload.categories as Record<string, boolean>)
        : undefined
      // 零配置注册先于能力门（见文件头说明 1）。
      if (typeof payload.enrollKey === 'string') {
        const enrollKey = cleanEnrollKey(payload.enrollKey)
        if (enrollKey.length >= 8 && enrollKey.length <= 128) await ctx.enrollPushKey(enrollKey)
      }
      // token 先落盘，再评估就绪（见文件头说明 2）；await 之后重新读取权限。
      const record = ctx.devices.authorized(deviceId)
      if (!record?.scopes?.includes('notifications.register')) {
        return ctx.fail('E_FORBIDDEN', 'device authorization changed')
      }
      ctx.devices.setPushToken(deviceId, token, environment, categories, Date.now())
      if (ctx.bridge.capabilities.push !== true) {
        if (ctx.debug) ctx.log('push register held: bridge not ready')
        return ctx.fail('E_UNSUPPORTED', 'push is not configured on this bridge')
      }
      if (ctx.debug) ctx.log('push token registered env=' + environment)
      // enabled 让 App 立即翻转本地能力位，不必等下一次握手。
      ctx.send('s2c.ack', { enabled: true })
    },
  },
  {
    type: 'c2s.widget.push.register',
    stage: 'authenticated',
    scopes: WIDGET_PUSH_SCOPES,
    widgetPolicy: 'allowed',
    // 同 c2s.push.register：能力门在 handler 内、注册之后检查。
    doc: 'PROTOCOL.md c2s.widget.push.register',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      const token = typeof p.deviceToken === 'string' ? (p.deviceToken as string).trim() : ''
      if (!isValidApnsToken(token)) return reject('E_PROTOCOL', 'hex deviceToken (32-512 chars) required')
      if (p.environment !== undefined && p.environment !== 'production' && p.environment !== 'development') {
        return reject('E_PROTOCOL', 'invalid APNs environment')
      }
      if (!isOptionalField(p, 'enrollKey', (v) => isText(v, 128))) return reject('E_PROTOCOL', 'invalid enrollKey')
      return checked
    },
    handle: async (ctx, payload) => {
      const deviceId = ctx.deviceId
      if (deviceId === undefined) return ctx.fail('E_INTERNAL', 'device identity unavailable')
      const token = String(payload.deviceToken).trim()
      const environment: ApnsEnvironment = payload.environment === 'production' ? 'production' : 'development'
      if (typeof payload.enrollKey === 'string') {
        const enrollKey = cleanEnrollKey(payload.enrollKey)
        if (enrollKey.length >= 8 && enrollKey.length <= 128) await ctx.enrollPushKey(enrollKey)
      }
      const record = ctx.devices.authorized(deviceId)
      if (
        !record?.scopes?.includes('notifications.register') ||
        !record.scopes.includes('sessions.read') ||
        !record.scopes.includes('interactions.respond')
      ) {
        return ctx.fail('E_FORBIDDEN', 'device authorization changed')
      }
      ctx.devices.setWidgetPushToken(deviceId, token, environment, Date.now())
      if (ctx.bridge.capabilities.push !== true) {
        if (ctx.debug) ctx.log('push register held: bridge not ready')
        return ctx.fail('E_UNSUPPORTED', 'push is not configured on this bridge')
      }
      ctx.send('s2c.ack', { enabled: true })
    },
  },
  {
    type: 'c2s.liveActivity.unregister',
    stage: 'authenticated',
    scopes: ['notifications.register'],
    doc: 'PROTOCOL.md c2s.liveActivity.unregister',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      if (!isText(checked.value.activityId, 128)) return reject('E_PROTOCOL', 'invalid activityId')
      return checked
    },
    handle: (ctx, payload) => {
      const activityId = payload.activityId as string
      // 注销正在注册中的活动：抬高端次使在途的注册失效。
      if (ctx.pendingLiveActivityId === activityId) {
        ctx.nextLiveActivityGeneration()
        ctx.setPendingLiveActivityId(undefined)
      }
      ctx.devices.clearLiveActivity(ctx.deviceId!, activityId)
      ctx.send('s2c.ack', {})
    },
  },
  {
    type: 'c2s.liveActivity.register',
    stage: 'authenticated',
    scopes: LIVE_ACTIVITY_SCOPES,
    doc: 'PROTOCOL.md c2s.liveActivity.register',
    validate: (payload) => {
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      const p = checked.value
      if (!isText(p.activityId, 128)) return reject('E_PROTOCOL', 'invalid activityId')
      if (
        !isText(p.sessionId) ||
        typeof p.deviceToken !== 'string' ||
        !/^[0-9a-fA-F]{32,512}$/.test(p.deviceToken) ||
        !['development', 'production'].includes(p.environment as string) ||
        !isOptionalField(p, 'enrollKey', (v) => isText(v, 128))
      ) {
        return reject('E_PROTOCOL', 'invalid live activity registration')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const deviceId = ctx.deviceId
      if (deviceId === undefined) return ctx.fail('E_INTERNAL', 'device identity unavailable')
      const activityId = payload.activityId as string
      const generation = ctx.nextLiveActivityGeneration()
      ctx.setPendingLiveActivityId(activityId)
      // 注意：此处 enrollKey 原样透传，未做 push.register 那样的可打印 ASCII
      // 清洗。两条路径的清洗规则不一致属于已知不对称，本次按原行为保留，
      // 是否统一留待专门决策（不在本轮 wire 对等清单内）。
      if (typeof payload.enrollKey === 'string' && payload.enrollKey) {
        await ctx.enrollPushKey(payload.enrollKey as string)
      }
      if (generation !== ctx.liveActivityGeneration) {
        return ctx.fail('E_BUSY', 'live activity registration superseded')
      }
      // await 之后重新校验：权限可能已被改窄，连接可能已关闭。
      const record = ctx.devices.authorized(deviceId)
      if (
        !record ||
        !LIVE_ACTIVITY_SCOPES.every((scope) => record.scopes?.includes(scope))
      ) {
        return ctx.fail('E_FORBIDDEN', 'live activity permissions required')
      }
      if (!ctx.bridge.listSessions().some((row) => row.id === payload.sessionId)) {
        return ctx.fail('E_NOT_FOUND', 'session not found')
      }
      const previous = record.liveActivity
      if (previous?.activityId === activityId && previous.sessionId !== payload.sessionId) {
        return ctx.fail('E_PROTOCOL', 'activity is bound to another session')
      }
      ctx.devices.setLiveActivity(record.deviceId, {
        activityId,
        sessionId: payload.sessionId as string,
        token: String(payload.deviceToken).toLowerCase(),
        environment: payload.environment as ApnsEnvironment,
        updatedAt: Date.now(),
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      })
      ctx.bridge.refreshLiveActivities()
      ctx.send('s2c.ack', { enabled: ctx.bridge.capabilities.push })
    },
  },
]
