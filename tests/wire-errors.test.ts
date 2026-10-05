/**
 * 错误词表的冻结期望：每个域的 Host code -> wire code。
 *
 * 取值在迁移期与旧 host-bridge 的 6 个映射函数逐码对等（对等测试已随之
 * 固化），此后改变任何一码都必须改这张表。E_BUSY 与 E_PROTOCOL 决定客户端
 * 是否重试，因此这是 wire 行为而不是实现细节。
 *
 * 表里**必须**同时写 DSH 实际的命名空间码（`session/agent-busy`）与旧 host
 * 的扁平写法（`agent-busy`）：两套码在真实世界里同时存在，只认一套会让另一
 * 套落进 E_INTERNAL，E_BUSY 于是永远出不来（issue #26）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES, canonicalHostCode, pendingResponseErrorCode, pendingResponseMessage, wireCodeFor, wireErrorOf } from '../src/wire-errors.ts'
import type { ErrorDomain } from '../src/wire-errors.ts'

/** DSH 现在实际抛出的码（来自 @deepseek-ai/dsh-api-session-controller 等）。 */
const SESSION_NAMESPACED: Record<string, string> = {
  'session/not-found': 'E_NOT_FOUND',
  'workspace/not-found': 'E_NOT_FOUND',
  'workspace-file/not-found': 'E_NOT_FOUND',
  'session/agent-busy': 'E_BUSY',
  'session/writer-held': 'E_BUSY',
  'session/conflict': 'E_BUSY',
  'workspace/session-active': 'E_BUSY',
  'gateway/bad-request': 'E_PROTOCOL',
  'session/title-invalid': 'E_PROTOCOL',
  'session/attachment-invalid': 'E_PROTOCOL',
  'session/invalid-time-zone': 'E_PROTOCOL',
  'workspace/invalid-path': 'E_PROTOCOL',
  'workspace/name-conflict': 'E_PROTOCOL',
  'workspace/move-invalid': 'E_PROTOCOL',
  'directory-picker/unavailable': 'E_UNSUPPORTED',
}

/** 旧 host 的扁平写法：必须与命名空间码映到同一个 wire 码。 */
const SESSION: Record<string, string> = {
  'session-not-found': 'E_NOT_FOUND',
  'workspace-not-found': 'E_NOT_FOUND',
  'agent-busy': 'E_BUSY',
  'session-conflict': 'E_BUSY',
  'title-invalid': 'E_PROTOCOL',
  'workspace-invalid-path': 'E_PROTOCOL',
  'workspace-name-conflict': 'E_PROTOCOL',
  'directory-unreadable': 'E_PROTOCOL',
  'directory-exists': 'E_PROTOCOL',
  'directory-create-failed': 'E_PROTOCOL',
  'directory-picker-unavailable': 'E_UNSUPPORTED',
}

const MODEL: Record<string, string> = {
  'session/not-found': 'E_NOT_FOUND',
  'session/agent-busy': 'E_BUSY',
  'session/writer-held': 'E_BUSY',
  'session/conflict': 'E_BUSY',
  'session/model-unavailable': 'E_NOT_FOUND',
  // 旧 host 的扁平写法。
  'session-not-found': 'E_NOT_FOUND',
  'agent-busy': 'E_BUSY',
  'session-conflict': 'E_BUSY',
  'model-unavailable': 'E_NOT_FOUND',
}

const SCHEDULE: Record<string, string> = {
  'schedule_not_found': 'E_NOT_FOUND',
  'delivery_cursor_not_found': 'E_NOT_FOUND',
  'schedule_conflict': 'E_BUSY',
  'invalid_prompt': 'E_PROTOCOL',
  'invalid_selector': 'E_PROTOCOL',
  'invalid_rule': 'E_PROTOCOL',
  'invalid_time_zone': 'E_PROTOCOL',
  'not_future': 'E_PROTOCOL',
  'time_out_of_range': 'E_PROTOCOL',
  'frequency_too_high': 'E_PROTOCOL',
  'schedule_ended': 'E_PROTOCOL',
  'subagent_session': 'E_PROTOCOL',
}

test('每个域的 Host code 映射到冻结的 wire 码', () => {
  for (const [domain, table] of [
    ['session', { ...SESSION_NAMESPACED, ...SESSION }],
    ['model', MODEL],
    ['schedule', SCHEDULE],
  ] as const) {
    for (const [code, expected] of Object.entries(table)) {
      assert.equal(wireCodeFor(domain, code), expected, `${domain}/${code}`)
      assert.equal(wireErrorOf(domain, { code }).code, expected, `${domain}/${code} via wireErrorOf`)
    }
  }
})

test('命名空间码与旧扁平写法必须同码，这正是 issue #26 丢掉 E_BUSY 的地方', () => {
  // DSH 把 prompt 准入的任意内部失败包成 session/agent-busy，真实原因在 details.reason。
  // 修复前 session/agent-busy 整表失配 → E_INTERNAL，客户端因此永远不重试。
  assert.equal(wireCodeFor('session', 'session/agent-busy'), 'E_BUSY')
  assert.equal(wireCodeFor('model', 'session/agent-busy'), 'E_BUSY')
  // 没列进表的码仍然安全地落到 E_INTERNAL，而不是被尾部相同的键误伤。
  for (const code of ['session/steer-unavailable', 'session/unknown-thing', 'gateway/uplink-overflow']) {
    assert.equal(wireCodeFor('session', code), 'E_INTERNAL', code)
  }
})

test('剥掉命名空间后仍能命中：命名空间换了、尾部没换时兜底', () => {
  assert.equal(canonicalHostCode('session/agent-busy'), 'agent-busy')
  assert.equal(canonicalHostCode('directory-picker/unavailable'), 'unavailable')
  assert.equal(canonicalHostCode('agent-busy'), 'agent-busy')
  assert.equal(canonicalHostCode(''), '')
  // agent/agent-busy 是假设中的未来改名：尾部与旧写法一致，仍能兜住。
  assert.equal(wireCodeFor('session', 'agent/agent-busy'), 'E_BUSY')
  // 但原样命中优先：directory-picker/unavailable 不能被剥成 unavailable 再乱撞。
  assert.equal(wireCodeFor('session', 'directory-picker/unavailable'), 'E_UNSUPPORTED')
  // 剥出来的尾部若没有对应的旧写法，就老老实实落 E_INTERNAL。
  assert.equal(wireCodeFor('session', 'session/workspace-attach-failed'), 'E_INTERNAL')
})

test('查不到的 Host code 归 E_INTERNAL，并原样带出 message', () => {
  for (const domain of ['session', 'model', 'schedule'] as ErrorDomain[]) {
    assert.equal(wireCodeFor(domain, 'no-such-code'), 'E_INTERNAL')
    assert.equal(wireCodeFor(domain, undefined), 'E_INTERNAL')
  }
  const failure = wireErrorOf('schedule', { code: 'no-such-code', message: 'boom' })
  assert.equal(failure.ok, false)
  assert.equal(failure.code, 'E_INTERNAL')
  assert.equal(failure.message, 'boom')
  // 没有 message 时退回 code 本身，手机端仍能看到可读信息。
  assert.equal(wireErrorOf('session', { code: 'agent-busy' }).message, 'agent-busy')
})

/**
 * details.reason 是被 DSH 包装掉的真实原因。只在落到 E_INTERNAL 时追加：已映射
 * 的码本身可执行，改它的文案就是在动客户端重试语义所依赖的东西。
 */
test('落到 E_INTERNAL 时把 details.reason 并进 message，让真实原因能到手机', () => {
  const wrapped = wireErrorOf('session', {
    code: 'session/steer-unavailable',
    message: 'prompt rejected',
    details: { reason: 'Cannot read properties of undefined (reading "id")' },
  })
  assert.equal(wrapped.code, 'E_INTERNAL')
  assert.equal(wrapped.message, 'prompt rejected (session/steer-unavailable): Cannot read properties of undefined (reading "id")')

  // 已映射的码：不追加，原样带出。
  const mapped = wireErrorOf('session', {
    code: 'session/agent-busy',
    message: 'session is owned by subagent routing',
    details: { reason: 'use subagent delivery for this child session' },
  })
  assert.equal(mapped.code, 'E_BUSY')
  assert.equal(mapped.message, 'session is owned by subagent routing')

  // reason 缺失或不是非空字符串时不追加，保持既有形状。
  for (const details of [undefined, {}, { reason: '' }, { reason: 42 }, { reason: null }]) {
    assert.equal(wireErrorOf('session', { code: 'no-such-code', message: 'boom', details }).message, 'boom')
  }
  // 无 message 时 base 退回 code 本身，格式照样成立。
  assert.equal(
    wireErrorOf('session', { code: 'session/steer-unavailable', details: { reason: 'why' } }).message,
    'session/steer-unavailable (session/steer-unavailable): why',
  )
})

test('待决应答的三种结局各有其码与信息', () => {
  assert.equal(pendingResponseErrorCode('not-pending'), 'E_NOT_FOUND')
  assert.equal(pendingResponseMessage('approval', 'not-pending'), 'approval not pending')
  assert.equal(pendingResponseErrorCode('bad-response'), 'E_PROTOCOL')
  assert.match(pendingResponseMessage('question', 'bad-response'), /answer does not match/)
  assert.equal(pendingResponseErrorCode('transport'), 'E_INTERNAL')
  assert.match(pendingResponseMessage('question', 'transport'), /host connection failed/)
})

test('wire 错误码表与 PROTOCOL.md 的七个码一致', () => {
  assert.deepEqual(Object.keys(ERROR_CODES).sort(),
    ['E_AUTH', 'E_BUSY', 'E_FORBIDDEN', 'E_INTERNAL', 'E_NOT_FOUND', 'E_PROTOCOL', 'E_UNSUPPORTED'])
})