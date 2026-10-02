/**
 * 行驱动校验的冻结期望：每个入站帧在一组载荷上的判定（错误码 + 可读信息）。
 *
 * 这张表由 tests/wire-parity.test.ts 在迁移期与旧实现逐条对等后固化而来
 * （那次对等覆盖 request-validation 的判定、旧 case 体的形状检查、错误词表与
 * 能力位四处）。此后任何一行的判定变化都必须改这里——wire 行为的改变从此是
 * 显式的 diff，而不是某个 handler 里的顺手修改。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { WIRE_FRAME_ROWS, registryRowFor, validatePayload } from '../src/wire-registry.ts'

/** [帧类型, 载荷, 期望判定]；判定为 "accept" 或 "E_*: message"。 */
const EXPECTATIONS: Array<[string, unknown, string]> = [
["c2s.ping", null, "accept"],
  ["c2s.ping", null, "accept"],
  ["c2s.ping", {}, "accept"],
  ["c2s.auth.prove", {"deviceId":"d"}, "accept"],
  ["c2s.auth.prove", {}, "accept"],
  ["c2s.sessions.list", null, "accept"],
  ["c2s.sessions.list", null, "accept"],
  ["c2s.sessions.list", {}, "accept"],
  ["c2s.sessions.list", {"extra":true}, "accept"],
  ["c2s.sessions.archived", null, "accept"],
  ["c2s.sessions.archived", null, "accept"],
  ["c2s.sessions.archived", {}, "accept"],
  ["c2s.pending.list", null, "accept"],
  ["c2s.pending.list", {}, "accept"],
  ["c2s.pending.list", {"sessionId":"s"}, "accept"],
  ["c2s.workspaces.list", null, "accept"],
  ["c2s.workspaces.list", {}, "accept"],
  ["c2s.workspace.create", {"path":"/tmp/x"}, "accept"],
  ["c2s.workspace.create", {}, "E_PROTOCOL: invalid path"],
  ["c2s.workspace.create", {"path":""}, "E_PROTOCOL: invalid path"],
  ["c2s.workspace.create", {"path":5}, "E_PROTOCOL: invalid path"],
  ["c2s.directory.list", null, "accept"],
  ["c2s.directory.list", {}, "accept"],
  ["c2s.directory.list", {"path":"/tmp"}, "accept"],
  ["c2s.directory.list", {"path":7}, "E_PROTOCOL: invalid path"],
  ["c2s.directory.pick", null, "accept"],
  ["c2s.directory.pick", {}, "accept"],
  ["c2s.session.open", {"sessionId":"s"}, "accept"],
  ["c2s.session.open", {"sessionId":"s","tailCount":50}, "accept"],
  ["c2s.session.open", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.open", {"sessionId":"s","tailCount":0}, "E_PROTOCOL: invalid tailCount"],
  ["c2s.session.close", {"sessionId":"s"}, "accept"],
  ["c2s.session.close", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.create", {}, "accept"],
  ["c2s.session.create", {"workspaceId":"w"}, "accept"],
  ["c2s.session.create", {"cwd":"/tmp"}, "accept"],
  ["c2s.session.create", {"workspaceId":"w","cwd":"/tmp"}, "E_PROTOCOL: invalid workspace selection"],
  ["c2s.session.fork", {"sessionId":"s","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111"}, "accept"],
  ["c2s.session.fork", {"sessionId":"s","clientRequestId":"bad"}, "E_PROTOCOL: invalid session fork fields"],
  ["c2s.session.fork", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.rename", {"sessionId":"s","title":"t"}, "accept"],
  ["c2s.session.rename", {"sessionId":"s","title":""}, "E_PROTOCOL: invalid title"],
  ["c2s.session.rename", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.archive", {"sessionId":"s"}, "accept"],
  ["c2s.session.archive", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.unarchive", {"sessionId":"s"}, "accept"],
  ["c2s.session.unarchive", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.cancel", {"sessionId":"s"}, "accept"],
  ["c2s.session.cancel", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.history", {"sessionId":"s","beforeSeq":0}, "accept"],
  ["c2s.session.history", {"sessionId":"s","beforeSeq":0,"limit":50}, "accept"],
  ["c2s.session.history", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.history", {"sessionId":"s","beforeSeq":-1}, "E_PROTOCOL: invalid history range"],
  ["c2s.session.attachment", {"sessionId":"s","attachmentId":"a"}, "accept"],
  ["c2s.session.attachment", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.models", {"sessionId":"s"}, "accept"],
  ["c2s.session.models", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.selectModel", {"sessionId":"s","provider":"p","model":"m"}, "accept"],
  ["c2s.session.selectModel", {"sessionId":"s","provider":"","model":"m"}, "E_PROTOCOL: invalid model selection"],
  ["c2s.session.selectModel", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.delivery", {"sessionId":"s","clientSendId":"1730000000000-11111111-1111-1111-1111-111111111111"}, "accept"],
  ["c2s.session.delivery", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"hi"}, "accept"],
  ["c2s.session.sendPrompt", {"sessionId":"s","images":[{"mediaType":"image/png","data":"aGk="}]}, "accept"],
  ["c2s.session.sendPrompt", {"sessionId":"s"}, "E_PROTOCOL: sessionId and prompt content required"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":5}, "E_PROTOCOL: invalid prompt fields"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"x","images":[{"mediaType":"image/png","data":""}]}, "E_PROTOCOL: invalid image attachment"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"x","images":"nope"}, "E_PROTOCOL: invalid prompt fields"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"x","documents":[{"mediaType":"application/pdf","name":"a","text":"t"}]}, "accept"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"x","documents":[{"mediaType":"image/png","name":"a","text":"t"}]}, "E_PROTOCOL: invalid document attachment"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"x","images":[{"mediaType":"image/png","data":"aGk="},{"mediaType":"image/png","data":"aGk="},{"mediaType":"image/png","data":"aGk="},{"mediaType":"image/png","data":"aGk="},{"mediaType":"image/png","data":"aGk="}]}, "E_PROTOCOL: too many images"],
  ["c2s.session.sendPrompt", {"sessionId":"s","text":"x","clientSendId":"bad"}, "E_PROTOCOL: invalid clientSendId"],
  ["c2s.schedule.list", {"sessionId":"s"}, "accept"],
  ["c2s.schedule.list", {}, "E_PROTOCOL: invalid sessionId"],
  ["c2s.schedule.history", {"sessionId":"s","id":"i","limit":10}, "accept"],
  ["c2s.schedule.history", {"sessionId":"s","id":"i","limit":0}, "E_PROTOCOL: invalid schedule history"],
  ["c2s.schedule.history", {}, "E_PROTOCOL: invalid schedule history"],
  ["c2s.schedule.create", {"sessionId":"s","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111","title":"t","prompt":"p","after_seconds":60}, "accept"],
  ["c2s.schedule.create", {"sessionId":"s","clientRequestId":"bad","title":"t","prompt":"p","after_seconds":60}, "E_PROTOCOL: invalid schedule create fields"],
  ["c2s.schedule.create", {"sessionId":"s","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111","title":"t","prompt":"p"}, "E_PROTOCOL: schedule requires exactly one selector"],
  ["c2s.schedule.create", {"sessionId":"s","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111","title":"t","prompt":"p","after_seconds":1,"at":"2026-01-01T00:00:00Z"}, "E_PROTOCOL: schedule requires exactly one selector"],
  ["c2s.schedule.update", {"sessionId":"s","id":"i","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111","expected":{}}, "accept"],
  ["c2s.schedule.update", {"sessionId":"s","id":"i","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111"}, "E_PROTOCOL: invalid schedule update fields"],
  ["c2s.schedule.delete", {"sessionId":"s","id":"i","clientRequestId":"1730000000000-11111111-1111-1111-1111-111111111111"}, "accept"],
  ["c2s.schedule.delete", {}, "E_PROTOCOL: invalid schedule delete fields"],
  ["c2s.approval.respond", {"requestId":"r","decision":"allow"}, "accept"],
  ["c2s.approval.respond", {"requestId":"r","decision":"maybe"}, "E_PROTOCOL: invalid approval response"],
  ["c2s.approval.respond", {}, "E_PROTOCOL: invalid requestId"],
  ["c2s.question.respond", {"requestId":"r","answers":[{"id":"q","selected":["Yes"]}]}, "accept"],
  ["c2s.question.respond", {"requestId":"r","answers":"nope"}, "E_PROTOCOL: invalid answers"],
  ["c2s.question.respond", {"requestId":"r","answers":[{"id":"q","selected":[]},{"id":"q","selected":[]}]}, "E_PROTOCOL: invalid answer"],
  ["c2s.question.respond", {}, "E_PROTOCOL: invalid requestId"],
  ["c2s.push.register", {"deviceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"development"}, "accept"],
  ["c2s.push.register", {"deviceToken":"nope"}, "E_PROTOCOL: hex deviceToken (32-512 chars) required"],
  ["c2s.push.register", {"deviceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"nope"}, "E_PROTOCOL: invalid APNs environment"],
  ["c2s.push.register", {"deviceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","categories":{"x":"yes"}}, "E_PROTOCOL: invalid categories"],
  ["c2s.push.register", {}, "E_PROTOCOL: hex deviceToken (32-512 chars) required"],
  ["c2s.widget.push.register", {"deviceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"production"}, "accept"],
  ["c2s.widget.push.register", {"deviceToken":"nope"}, "E_PROTOCOL: hex deviceToken (32-512 chars) required"],
  ["c2s.widget.push.register", {}, "E_PROTOCOL: hex deviceToken (32-512 chars) required"],
  ["c2s.liveActivity.unregister", {"activityId":"a"}, "accept"],
  ["c2s.liveActivity.unregister", {}, "E_PROTOCOL: invalid activityId"],
  ["c2s.liveActivity.register", {"activityId":"a","sessionId":"s","deviceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"development"}, "accept"],
  ["c2s.liveActivity.register", {"activityId":"a","sessionId":"s","deviceToken":"zz","environment":"development"}, "E_PROTOCOL: invalid live activity registration"],
  ["c2s.liveActivity.register", {"activityId":"a","sessionId":"s","deviceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"nope"}, "E_PROTOCOL: invalid live activity registration"],
  ["c2s.liveActivity.register", {}, "E_PROTOCOL: invalid activityId"],
  ["c2s.device.revoke", null, "accept"],
  ["c2s.device.revoke", {}, "accept"],
  ["c2s.device.revoke", {"deviceId":"d"}, "accept"],
  ["c2s.device.revoke", {"deviceId":5}, "E_PROTOCOL: invalid deviceId"],]

test('每行的校验判定与冻结期望一致', () => {
  for (const [type, payload, verdict] of EXPECTATIONS) {
    const row = registryRowFor(type)
    assert.ok(row !== undefined, 'no row for ' + type)
    const actual = validatePayload(row, payload)
    const actualVerdict = actual.ok ? 'accept' : `${actual.code}: ${actual.message}`
    assert.equal(actualVerdict, verdict, `${type} ${JSON.stringify(payload)}`)
  }
})

test('每个入站帧都有冻结期望，没有遗漏', () => {
  const covered = new Set(EXPECTATIONS.map(([type]) => type))
  for (const row of WIRE_FRAME_ROWS) {
    assert.ok(covered.has(row.type), 'no frozen expectation for ' + row.type)
  }
})
