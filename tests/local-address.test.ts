import assert from 'node:assert/strict'
import test from 'node:test'
import { isPrivateIPv4, isSharedAddressSpaceIPv4 } from '../src/local-address.ts'

test('LAN address classifier accepts only RFC1918 IPv4 ranges', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.149']) {
    assert.equal(isPrivateIPv4(address), true, address)
  }
  for (const address of ['127.0.0.1', '169.254.1.1', '172.32.0.1', '8.8.8.8', 'not-an-ip']) {
    assert.equal(isPrivateIPv4(address), false, address)
  }
})

/**
 * RFC 6598 共享地址空间单列成一个谓词，而不是塞进 isPrivateIPv4——后者的名字
 * 承诺的是 RFC1918，报告人（issue #24）也建议保持名字诚实。
 */
test('CGNAT 段单列成谓词，且不与 RFC1918 混淆', () => {
  for (const address of ['100.64.0.1', '100.100.100.100', '100.127.255.254']) {
    assert.equal(isSharedAddressSpaceIPv4(address), true, address)
    assert.equal(isPrivateIPv4(address), false, `${address} 不该算 RFC1918`)
  }
  // 100.64.0.0/10 的两条边界之外都必须被拒。
  for (const address of ['100.63.255.255', '100.128.0.0', '100.0.0.1', '101.64.0.1', '10.64.0.1']) {
    assert.equal(isSharedAddressSpaceIPv4(address), false, address)
  }
  for (const address of ['not-an-ip', '100.64.0', '100.64.0.1.1', '100.64.0.256', '100.64.-1.1', '100.64.0.a']) {
    assert.equal(isSharedAddressSpaceIPv4(address), false, address)
  }
})