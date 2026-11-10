/**
 * 电脑端网页登录地址的推算（host-web.ts）。
 *
 * 钉住「哪些宿主形态视为可用」：只有回环明文 HTTP 监听、且 connection 服务能生成登录地址时才可用；
 * 服务缺失、方法抛错、TLS 或非回环监听一律返回 undefined（对应 reason `hostweb-unavailable`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostWebTarget, resolveHostWeb } from '../src/host-web.ts'

const server = (origin: string) => ({ port: Number(new URL(origin).port), getOrigin: () => origin })
const connection = { authenticatedUrl: (base: string) => `${base}?token=t` }

test('回环明文 HTTP 监听时生成带令牌的根地址', () => {
  const entry = resolveHostWeb(server('http://127.0.0.1:3080'), connection)
  assert.deepEqual(entry, {
    target: { hostname: '127.0.0.1', port: 3080, origin: 'http://127.0.0.1:3080', mention: '127.0.0.1:3080', connectHosts: ['127.0.0.1'] },
    url: 'http://127.0.0.1:3080/?token=t',
  })
  assert.equal(resolveHostWeb(server('http://localhost:3080'), connection)?.target.origin, 'http://localhost:3080')
})

test('TLS、非回环监听或拿不到地址时不可用', () => {
  assert.equal(hostWebTarget(server('https://127.0.0.1:3080')), undefined)
  assert.equal(hostWebTarget(server('http://192.168.1.5:3080')), undefined)
  assert.equal(hostWebTarget(server('http://0.0.0.0:3080')), undefined)
  assert.equal(hostWebTarget(undefined), undefined)
  assert.equal(hostWebTarget({ port: 3080 }), undefined, '旧宿主没有 getOrigin')
  assert.equal(hostWebTarget({ getOrigin: () => { throw new Error('not listening') } }), undefined)
})

test('connection 服务缺失或生成失败时不可用', () => {
  const web = server('http://127.0.0.1:3080')
  assert.equal(resolveHostWeb(web, undefined), undefined)
  assert.equal(resolveHostWeb(web, {}), undefined)
  assert.equal(resolveHostWeb(web, { authenticatedUrl: () => { throw new Error('no token') } }), undefined)
})
