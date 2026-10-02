/**
 * wire 注册表的不变量，以及与 PROTOCOL.md 的对等。
 *
 * 这些断言抓住的是「一帧一行」能否长期成立：任何新帧忘了 scope、忘了一个
 * welcome 位、或与规范文档脱节，都在这里红。原来的四张表（dispatch switch、
 * requiredScope、validateRequest、capabilities getter）各有各的枚举风格，
 * 没有任何一处能回答「所有帧都有人管吗」。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { DEVICE_SCOPES, type DeviceScope } from '../src/device-auth.ts'
import {
  BRIDGE_INVARIANT_CAPABILITIES,
  HANDLER_GATED_CAPABILITIES,
  HOST_CAPABILITY_PROBES,
} from '../src/host-capabilities.ts'
import { ERROR_CODES, pendingResponseErrorCode } from '../src/wire-errors.ts'
import { WIRE_FRAME_ROWS, registryRowFor } from '../src/wire-registry.ts'
import type { C2SType } from '../src/wire-registry.ts'

const PROTOCOL = readFileSync(new URL('../PROTOCOL.md', import.meta.url), 'utf8')

test('每个帧类型恰好一行，没有重复', () => {
  const seen = new Set<string>()
  for (const row of WIRE_FRAME_ROWS) {
    assert.ok(!seen.has(row.type), 'duplicate row for ' + row.type)
    seen.add(row.type)
    assert.equal(registryRowFor(row.type), row, 'registry lookup must return the same row')
  }
  assert.equal(seen.size, WIRE_FRAME_ROWS.length)
})

test('每行都声明阶段、scope 合法性、widget 策略与文档锚点', () => {
  for (const row of WIRE_FRAME_ROWS) {
    assert.ok(row.stage === 'pre-auth' || row.stage === 'authenticated', row.type + ' stage')
    for (const scope of row.scopes) {
      assert.ok((DEVICE_SCOPES as readonly string[]).includes(scope),
        `${row.type} declares unknown scope ${scope}`)
    }
    assert.ok(row.doc.length > 0, row.type + ' must carry a PROTOCOL.md anchor')
    assert.ok(PROTOCOL.includes(row.doc.replace('PROTOCOL.md ', '')),
      row.type + ' doc anchor not found in PROTOCOL.md: ' + row.doc)
  }
})

test('每行引用的能力位都真实存在', () => {
  const probed = new Set(Object.keys(HOST_CAPABILITY_PROBES))
  for (const row of WIRE_FRAME_ROWS) {
    if (row.capability === undefined) continue
    const known = probed.has(row.capability) ||
      row.capability === 'push' ||
      (BRIDGE_INVARIANT_CAPABILITIES as readonly string[]).includes(row.capability)
    assert.ok(known, `${row.type} gates unknown capability ${row.capability}`)
  }
})

test('每个宿主探测位至少被一行引用，否则探测是死重量', () => {
  // Bridge 恒真位（BRIDGE_INVARIANT_CAPABILITIES）是对客户端的声明，不绑定具体帧；
  // 从 Host 探测出来的位若没有帧引用，说明探测白做了。
  const gated = new Set(WIRE_FRAME_ROWS.map((row) => row.capability).filter((c) => c !== undefined))
  for (const bit of Object.keys(HOST_CAPABILITY_PROBES)) {
    assert.ok(gated.has(bit as never), `host-probed capability ${bit} gates no frame`)
  }
  for (const bit of HANDLER_GATED_CAPABILITIES) {
    assert.ok(!gated.has(bit as never), 'push 的门在 handler 内（注册先于就绪），不应出现在行上')
  }
})

test('PROTOCOL.md 的 scope 映射表与注册表逐行对等', () => {
  const table = parseScopeTable(PROTOCOL)
  assert.ok(table.size >= 6, 'scope table must be parsed from PROTOCOL.md')
  for (const [scope, frames] of table) {
    for (const frame of frames) {
      const row = registryRowFor(frame)
      if (row === undefined) continue
      const scopes = new Set<DeviceScope>(row.scopes)
      assert.ok(scopes.has(scope as DeviceScope),
        `PROTOCOL.md 说 ${frame} 需要 ${scope}，注册表只声明了 ${[...scopes].join(',')}`)
    }
  }
  // 反向：文档显式点名的帧，注册表必须给出文档说的 scope（控制帧不要求业务 scope）。
  const documented = new Map<string, Set<string>>()
  for (const [scope, frames] of table) {
    for (const frame of frames) documented.set(frame, (documented.get(frame) ?? new Set()).add(scope))
  }
  const controls: C2SType[] = ['c2s.ping', 'c2s.auth.prove', 'c2s.device.revoke']
  for (const [frame, scopes] of documented) {
    const row = registryRowFor(frame)
    if (row === undefined || controls.includes(frame as C2SType)) continue
    const declared = new Set<DeviceScope>(row.scopes)
    for (const scope of scopes) {
      assert.ok(declared.has(scope as DeviceScope),
        `${frame} 在 PROTOCOL.md 中归 ${scope}，注册表只声明了 ${[...declared].join(',')}`)
    }
  }
})

test('PROTOCOL.md 声明的控制帧在注册表里有对应阶段', () => {
  assert.equal(registryRowFor('c2s.ping')?.stage, 'pre-auth')
  assert.equal(registryRowFor('c2s.auth.prove')?.stage, 'pre-auth')
  // c2s.resume 由 PROTOCOL.md 列为控制帧，但续传走 auth.prove 的 resumeCursor，
  // 因此没有独立行：未知类型回 E_PROTOCOL（见 C2SType 注释）。
  assert.equal(registryRowFor('c2s.resume'), undefined)
})

test('wire 错误码集合与 PROTOCOL.md 错误码表一致', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    // 文档表格里有的带反引号、有的不带，两种都认。
    assert.ok(PROTOCOL.split('\n').some((line) => line.replace(/`/g, '').includes(code)),
      'PROTOCOL.md 缺少错误码 ' + code)
  }
  assert.equal(pendingResponseErrorCode('not-pending'), 'E_NOT_FOUND')
  assert.equal(pendingResponseErrorCode('bad-response'), 'E_PROTOCOL')
  assert.equal(pendingResponseErrorCode('transport'), 'E_INTERNAL')
})

/** 解析 PROTOCOL.md 的「scope 与操作映射」表：scope -> 提到的帧类型。 */
function parseScopeTable(doc: string): Map<string, string[]> {
  const table = new Map<string, string>()
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 3) continue
    const scope = cells[1]!.replace(/`/g, '')
    if (!(DEVICE_SCOPES as readonly string[]).includes(scope)) continue
    table.set(scope, cells[2]!)
  }
  const result = new Map<string, string[]>()
  for (const [scope, description] of table) {
    const frames = description.match(/c2s\.[a-zA-Z.]+/g) ?? []
    result.set(scope, frames)
  }
  return result
}
