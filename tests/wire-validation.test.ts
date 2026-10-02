/**
 * 行驱动校验的边界用例（原 request-validation.test.ts 的行驱动版本）。
 *
 * 判定现在住在每行的 validate 里，因此这些用例直接对行运行；完整的
 * 「帧 × 载荷」期望表在 tests/wire-rows.test.ts。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { registryRowFor, validatePayload } from '../src/wire-registry.ts'

const row = (type: string) => registryRowFor(type)!

test('row validation checks boundaries and preserves additive fields', () => {
  // 未知字段保持宽容：协议 v2 允许新增可选字段。
  assert.equal(validatePayload(row('c2s.session.open'), { sessionId: '中文', tailCount: 100, future: true }).ok, true)
  assert.equal(validatePayload(row('c2s.session.create'), {}).ok, true)
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), { sessionId: 's', text: 'x'.repeat(256 * 1024) }).ok, true)
  for (const payload of [null, [], true, 1, 's', { sessionId: '' }, { sessionId: 'x'.repeat(4097) }]) {
    assert.equal(validatePayload(row('c2s.session.close'), payload).ok, false, JSON.stringify(payload))
  }
  for (const beforeSeq of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validatePayload(row('c2s.session.history'), { sessionId: 's', beforeSeq }).ok, false, String(beforeSeq))
  }
  // 同一 question id 出现两次：整体拒绝。
  assert.equal(validatePayload(row('c2s.question.respond'), {
    requestId: 'r', answers: [{ id: 'q', selected: [] }, { id: 'q', selected: [] }],
  }).ok, false)
  assert.equal(validatePayload(row('c2s.question.respond'), {
    requestId: 'r', answers: [{ id: 'q', selected: ['Yes'], custom: undefined }],
  }).ok, true)
})

test('prompt attachments enforce media types, counts and budgets', () => {
  const image = { mediaType: 'image/png', data: 'aGk=' }
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), { sessionId: 's', images: [image] }).ok, true)
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), { sessionId: 's', images: [{ ...image, mediaType: 'image/svg+xml' }] }).ok, false)
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), { sessionId: 's', images: [{ ...image, data: '' }] }).ok, false)
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), { sessionId: 's', images: [{ ...image, data: 'a'.repeat(8 * 1024 * 1024 + 1) }] }).ok, false)
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), {
    sessionId: 's', images: Array.from({ length: 5 }, () => image),
  }).ok, false)
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), {
    sessionId: 's', documents: [{ mediaType: 'application/pdf', name: 'a', text: 'body' }],
  }).ok, true)
  // 文档不得伪装成图片（图片走 images）。
  assert.equal(validatePayload(row('c2s.session.sendPrompt'), {
    sessionId: 's', documents: [{ mediaType: 'image/png', name: 'a', text: 'body' }],
  }).ok, false)
})
