import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRequest } from '../src/request-validation.ts'

test('request validation checks boundaries and preserves additive fields', () => {
  assert.equal(validateRequest('c2s.session.open', { sessionId: '中文', tailCount: 100, future: true }), undefined)
  assert.equal(validateRequest('c2s.session.create', {}), undefined)
  assert.equal(validateRequest('c2s.session.sendPrompt', { sessionId: 's', text: 'x'.repeat(256 * 1024) }), undefined)
  for (const payload of [null, [], true, 1, 's', { sessionId: '' }, { sessionId: 'x'.repeat(4097) }]) {
    assert.ok(validateRequest('c2s.session.close', payload))
  }
  for (const beforeSeq of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(validateRequest('c2s.session.history', { sessionId: 's', beforeSeq }))
  }
  assert.ok(validateRequest('c2s.question.respond', { requestId: 'r', answers: [{ id: 'q', selected: [] }, { id: 'q', selected: [] }] }))
  assert.equal(validateRequest('c2s.question.respond', { requestId: 'r', answers: [{ id: 'q', selected: ['Yes'], custom: undefined }] }), undefined)
})
