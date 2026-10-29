import type { HostBridge } from './host-bridge.ts'
import { PluginUpdateError, type PluginUpdater, validUpdateRequestId } from './plugin-update.ts'
import type { CheckedPayload, FrameContext, WireFrameRow } from './wire-registry.ts'

// Keep registry imports type-only: registry statically assembles these rows.
function payloadObject(value: unknown): CheckedPayload {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'E_PROTOCOL', message: '更新请求必须是对象' }
  return { ok: true, value: value as Record<string, unknown> }
}

const updaters = new WeakMap<HostBridge, PluginUpdater>()

/** Bridge replacement and optional host service discovery can arrive in either order. */
export function setPluginUpdater(bridge: HostBridge, updater: PluginUpdater | undefined): void {
  if (updater) updaters.set(bridge, updater)
  else updaters.delete(bridge)
}
export function pluginUpdaterFor(bridge: HostBridge): PluginUpdater | undefined { return updaters.get(bridge) }

// 观察者属于有管理权限的连接；某次请求失败或历史终态重放不能注销其他请求仍需的观察。
const observers = new WeakMap<AbortSignal, Set<PluginUpdater>>()
function observe(ctx: FrameContext, updater: PluginUpdater, deviceId: string): void {
  if (!ctx.canReceive('sessions.manage')) return
  const signal = ctx.signal
  if (signal?.aborted || (signal && observers.get(signal)?.has(updater))) return
  let stop = () => {}
  const unsubscribe = updater.subscribe(deviceId, event => {
    if (!ctx.canReceive('sessions.manage')) { stop(); return }
    ctx.send('s2c.plugin.update.progress', event)
    // 实际 socket 均提供取消信号；无连接生命周期的调用只观察到本次终态。
    if (!signal && finished(event.phase)) stop()
  })
  stop = () => {
    unsubscribe()
    signal?.removeEventListener('abort', stop)
    if (signal) observers.get(signal)?.delete(updater)
  }
  if (signal) {
    let connections = observers.get(signal)
    if (!connections) { connections = new Set(); observers.set(signal, connections) }
    connections.add(updater)
    signal.addEventListener('abort', stop, { once: true })
  }
}
const finished = (phase: string | undefined) => phase === undefined || ['done', 'failed', 'rolled-back', 'restart-required'].includes(phase)

export const pluginUpdateRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.plugin.update.check', stage: 'authenticated', scopes: ['sessions.read'],
    widgetPolicy: 'deny', capability: 'pluginUpdate', doc: 'PROTOCOL.md c2s.plugin.update.check',
    validate: payloadObject,
    handle: async (ctx) => {
      const updater = updaters.get(ctx.bridge)
      if (!updater) return ctx.fail('E_UNSUPPORTED', '当前宿主不支持插件自更新')
      if (!ctx.deviceId) return ctx.fail('E_FORBIDDEN', '请先完成设备认证')
      observe(ctx, updater, ctx.deviceId)
      const status = await updater.check(ctx.deviceId)
      ctx.send('s2c.plugin.update.status', status)
    },
  },
  {
    type: 'c2s.plugin.update.apply', stage: 'authenticated', scopes: ['sessions.manage'],
    widgetPolicy: 'deny', capability: 'pluginUpdate', doc: 'PROTOCOL.md c2s.plugin.update.apply',
    validate: value => {
      const result = payloadObject(value)
      if (!result.ok) return result
      const version = result.value.version
      if (typeof version !== 'string' || version.length > 128 || version.trim().length === 0 || !validUpdateRequestId(result.value.clientRequestId)) return { ok: false, code: 'E_PROTOCOL', message: '更新版本或请求标识无效' }
      return result
    },
    handle: async (ctx, payload) => {
      const updater = updaters.get(ctx.bridge)
      if (!updater) return ctx.fail('E_UNSUPPORTED', '当前宿主不支持插件自更新')
      if (!ctx.deviceId) return ctx.fail('E_FORBIDDEN', '请先完成设备认证')
      // 只有受理成功的活动请求才建立观察；监听生命周期归连接，拒绝和历史重放均不注销它。
      try {
        const record = await updater.apply(ctx.deviceId, payload.version as string, payload.clientRequestId as string)
        ctx.send('s2c.ack', { clientRequestId: record.clientRequestId, accepted: true })
        if (ctx.canReceive('sessions.manage')) {
          ctx.send('s2c.plugin.update.progress', { clientRequestId: record.clientRequestId, phase: record.phase, message: record.message })
          if (!finished(record.phase)) observe(ctx, updater, ctx.deviceId)
        }
      } catch (error) {
        if (error instanceof PluginUpdateError) return ctx.fail(error.code, error.message)
        ctx.fail('E_INTERNAL', '暂时无法启动插件更新，请检查当前版本')
      }
    },
  },
]
