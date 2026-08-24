import assert from 'node:assert/strict'
import test from 'node:test'
import { isPrivateIPv4 } from '../src/local-address.ts'

test('LAN address classifier accepts only RFC1918 IPv4 ranges', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.149']) {
    assert.equal(isPrivateIPv4(address), true, address)
  }
  for (const address of ['127.0.0.1', '169.254.1.1', '172.32.0.1', '8.8.8.8', 'not-an-ip']) {
    assert.equal(isPrivateIPv4(address), false, address)
  }
})
