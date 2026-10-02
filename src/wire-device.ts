/**
 * 设备生命周期特性的 wire 行：自撤销（解绑）。
 *
 * 该帧不要求任何 scope：设备生命周期操作不能因为 scope 被收窄而无法解绑，
 * 否则它只会永远留在离线推送目标集合里（PROTOCOL.md c2s.device.revoke）。
 * widget 策略取 `handler`：小组件的拒必须是「小组件不得解绑设备」这个具体
 * 理由，通用只读门禁只会说 read-only。
 */

import {
  isOptionalField,
  isText,
  payloadObject,
  reject,
  type WireFrameRow,
} from './wire-registry.ts'

export const deviceRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.device.revoke',
    stage: 'authenticated',
    scopes: [],
    widgetPolicy: 'handler',
    doc: 'PROTOCOL.md c2s.device.revoke',
    validate: (payload) => {
      // 载荷可整体省略：省略与 `{}` 等价，deviceId 可选。
      const checked = payloadObject(payload)
      if (!checked.ok) return checked
      // 校验可选的 deviceId：类型/非空（旧 request-validation 的判定），通过后
      // 才进入 handler 的等值判断。
      if (!isOptionalField(checked.value, 'deviceId', (v) => isText(v))) {
        return reject('E_PROTOCOL', 'invalid deviceId')
      }
      if (checked.value.deviceId !== undefined && typeof checked.value.deviceId !== 'string') {
        return reject('E_PROTOCOL', 'deviceId must be a string')
      }
      return checked
    },
    handle: async (ctx, payload) => {
      const deviceId = ctx.deviceId
      if (deviceId === undefined) return ctx.fail('E_INTERNAL', 'device identity unavailable')
      if (typeof payload.deviceId === 'string' && payload.deviceId !== deviceId) {
        return ctx.fail('E_FORBIDDEN', 'deviceId does not match the authenticated device')
      }
      if (ctx.widgetClient) {
        return ctx.fail('E_FORBIDDEN', 'widget connection cannot revoke its device')
      }
      // 幂等：已撤销的记录仍然 ack {revoked:true}——设备无法区分首次撤销与
      // 重复撤销，两种情况都不能表现为错误。
      ctx.devices.revoke(deviceId, Date.now())
      ctx.markRevoked()
      // 摘除同设备的其它活跃连接是尽力而为：注册表墓碑已落盘，hook 失败
      // 不能吞掉这次 ack。
      try {
        await ctx.revokeSiblings(deviceId)
      } catch (error) {
        if (ctx.debug) ctx.log('device revoke hook failed: ' + String(error))
      }
      // ack 严格先于关闭，慢客户端才能在 4401 前看到解绑成功。
      ctx.send('s2c.ack', { revoked: true })
      ctx.close(4401, 'device revoked')
    },
  },
]
