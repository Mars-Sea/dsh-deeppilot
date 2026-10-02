/**
 * 连接行为的常驻对等测试。
 *
 * 场景集与输出签名由 tests/connection-gate-scenarios.ts 提供；这里的期望值是
 * 迁移到 ConnectionGate 之前固化的快照（22 个真实 socket 场景，覆盖全部关闭码、
 * 四种认证结局、scope/widget/未知类型三类拒绝、撤销语义与打开失败回滚）。
 *
 * 迁移期曾用一次性对等测试逐场景比对；通过后期望值固化为本文件，此后任何连接
 * 行为的改变都必须是显式的 diff。比对口径：帧类型 + 错误码 + 关键 payload 字段
 * + 关闭码，忽略 ts 与 bridge 的 seq（时间/游标派生量，与连接行为无关）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAllScenarios, type ScenarioResult } from './connection-gate-scenarios.ts'

/** 固化快照：场景名 -> { frames, closes, terminated }。 */
const EXPECTED: Record<string, ScenarioResult> = {
  "匿名非控制帧": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_PROTOCOL"
    ],
    "closes": [],
    "terminated": false
  },
  "匿名超限预认证帧": {
    "frames": [
      "s2c.auth.challenge"
    ],
    "closes": [
      1009
    ],
    "terminated": false
  },
  "非法 JSON": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_PROTOCOL"
    ],
    "closes": [],
    "terminated": false
  },
  "非信封 JSON": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_PROTOCOL"
    ],
    "closes": [],
    "terminated": false
  },
  "版本不符": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_UNSUPPORTED"
    ],
    "closes": [
      4500
    ],
    "terminated": false
  },
  "匿名 ping": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.pong"
    ],
    "closes": [],
    "terminated": false
  },
  "证明缺 deviceId": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_PROTOCOL"
    ],
    "closes": [
      4403
    ],
    "terminated": false
  },
  "证明 deviceId 全为控制字符": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_PROTOCOL"
    ],
    "closes": [
      4403
    ],
    "terminated": false
  },
  "证明签名无效": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_AUTH"
    ],
    "closes": [
      4401
    ],
    "terminated": false
  },
  "证明成功": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true"
    ],
    "closes": [],
    "terminated": false
  },
  "证明成功并续传（可续）": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=true widgetPush=true",
      "s2c.sessions.delta",
      "s2c.resume.done"
    ],
    "closes": [],
    "terminated": false
  },
  "续传游标超出本进程（重同步）": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.resync reason=gap"
    ],
    "closes": [],
    "terminated": false
  },
  "scope 不足": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=sessions.manage resumed=false widgetPush=true",
      "s2c.error E_FORBIDDEN"
    ],
    "closes": [],
    "terminated": false
  },
  "未知帧类型": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.error E_PROTOCOL"
    ],
    "closes": [],
    "terminated": false
  },
  "widget 只读门与专用拒绝": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.sessions.snapshot",
      "s2c.error E_FORBIDDEN",
      "s2c.error E_FORBIDDEN",
      "s2c.error E_FORBIDDEN"
    ],
    "closes": [],
    "terminated": false
  },
  "自撤销：ack 先于 4401": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.ack revoked=true"
    ],
    "closes": [
      4401
    ],
    "terminated": false
  },
  "撤销时 deviceId 不匹配": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.error E_FORBIDDEN"
    ],
    "closes": [],
    "terminated": false
  },
  "空闲关闭": {
    "frames": [
      "s2c.auth.challenge"
    ],
    "closes": [
      1001
    ],
    "terminated": false
  },
  "服务器停止": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.error E_INTERNAL"
    ],
    "closes": [
      1001
    ],
    "terminated": false
  },
  "会话打开失败回滚 viewer": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.error E_NOT_FOUND"
    ],
    "closes": [],
    "terminated": false
  },
  "推送注册被能力门拒": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=interactions.respond,notifications.register,prompt.send,schedule.manage,sessions.manage,sessions.read resumed=false widgetPush=true",
      "s2c.error E_UNSUPPORTED"
    ],
    "closes": [],
    "terminated": false
  },
  "live activity 注册缺 scope": {
    "frames": [
      "s2c.auth.challenge",
      "s2c.welcome deviceId=set scopes=notifications.register resumed=false widgetPush=true",
      "s2c.error E_FORBIDDEN"
    ],
    "closes": [],
    "terminated": false
  }
}

test('连接行为与固化快照一致', async (t) => {
  const results = await runAllScenarios()
  assert.deepEqual(Object.keys(results).sort(), Object.keys(EXPECTED).sort(), '场景集合必须与快照一致')
  for (const [name, want] of Object.entries(EXPECTED)) {
    await t.test(name, async () => {
      assert.deepEqual(results[name], want, name)
    })
  }
})
