/**
 * 错误词表的冻结期望：每个域的 Host code -> wire code。
 *
 * 取值在迁移期与旧 host-bridge 的 6 个映射函数逐码对等（对等测试已随之
 * 固化），此后改变任何一码都必须改这张表。E_BUSY 与 E_PROTOCOL 决定客户端
 * 是否重试，因此这是 wire 行为而不是实现细节。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES, pendingResponseErrorCode, pendingResponseMessage, wireCodeFor, wireErrorOf } from '../src/wire-errors.ts'
import type { ErrorDomain } from '../src/wire-errors.ts'

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
  for (const [domain, table] of [['session', SESSION], ['model', MODEL], ['schedule', SCHEDULE]] as const) {
    for (const [code, expected] of Object.entries(table)) {
      assert.equal(wireCodeFor(domain, code), expected, `${domain}/${code}`)
      assert.equal(wireErrorOf(domain, { code }).code, expected, `${domain}/${code} via wireErrorOf`)
    }
  }
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
