/**
 * 本机预览准入规则（preview-policy）：哪些 URL 能解析成预览目标、哪些端口永远拒绝。
 * 这是安全判定，逐条钉住，防止将来放宽解析时意外放进非回环主机。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_WEB_DEFAULT_PORT, isReservedPreviewPort, parseLoopbackUrl } from '../src/preview-policy.ts'

test('三种回环写法带显式端口时解析成功，连接地址按写法区分', () => {
  assert.deepEqual(parseLoopbackUrl('http://127.0.0.1:4720/design/a?b=1#c'), {
    hostname: '127.0.0.1', port: 4720, origin: 'http://127.0.0.1:4720', mention: '127.0.0.1:4720', connectHosts: ['127.0.0.1'],
  })
  const local = parseLoopbackUrl('http://LOCALHOST:5173/')
  assert.equal(local?.origin, 'http://localhost:5173', '主机名统一小写')
  assert.deepEqual(local?.connectHosts, ['127.0.0.1', '::1'], 'localhost 先 IPv4 后 IPv6')
  const v6 = parseLoopbackUrl('http://[::1]:8080')
  assert.equal(v6?.mention, '[::1]:8080', 'IPv6 保留方括号，与消息里的写法一致')
  assert.deepEqual(v6?.connectHosts, ['::1'])
})

test('非 http、非回环、缺端口、带用户名、非法端口一律拒绝', () => {
  for (const raw of [
    'https://127.0.0.1:4720/',
    'ws://127.0.0.1:4720/',
    'http://127.0.0.1/',
    'http://127.0.0.1:80/',
    'http://192.168.1.2:4720/',
    'http://127.0.0.2:4720/',
    'http://0.0.0.0:4720/',
    'http://localhost.example.com:4720/',
    'http://user:pw@127.0.0.1:4720/',
    'http://user@localhost:4720/',
    'http://127.0.0.1:0/',
    'http://127.0.0.1:99999/',
    'not a url',
    '',
  ]) {
    assert.equal(parseLoopbackUrl(raw), undefined, raw)
  }
})

test('DSH Web 默认端口与插件自身端口永远保留', () => {
  assert.equal(isReservedPreviewPort(DSH_WEB_DEFAULT_PORT, []), true)
  assert.equal(isReservedPreviewPort(3098, [3098, 41234]), true)
  assert.equal(isReservedPreviewPort(41234, new Set([3098, 41234])), true)
  assert.equal(isReservedPreviewPort(4720, [3098]), false)
})
