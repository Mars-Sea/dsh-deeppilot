import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { canonicalAuthChallenge, deviceIdForPublicKey } from '../src/device-auth.ts'
import type { DeviceStore } from '../src/token.ts'

export interface TestIdentity {
  privateKey: KeyObject
  publicKey: string
  deviceId: string
}

export function createTestIdentity(): TestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const x = Buffer.from(jwk.x!, 'base64url')
  const y = Buffer.from(jwk.y!, 'base64url')
  const encoded = Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url')
  return { privateKey, publicKey: encoded, deviceId: deviceIdForPublicKey(encoded) }
}

export function registerTestIdentity(store: DeviceStore, identity: TestIdentity): void {
  store.register({ publicKey: identity.publicKey, deviceName: 'iPhone', appVersion: 'test' }, Date.now())
}

export function authenticateTestSocket(
  ws: { sent: any[]; receive(payload: unknown): void },
  identity: TestIdentity,
  overrides: { deviceName?: string; appVersion?: string; resumeCursor?: number; signature?: string } = {},
): void {
  const challenge = ws.sent.find((frame) => frame.type === 's2c.auth.challenge')?.payload
  if (!challenge) throw new Error('server auth challenge missing')
  const fields = {
    deviceId: identity.deviceId,
    deviceName: overrides.deviceName ?? 'iPhone',
    appVersion: overrides.appVersion ?? 'test',
    ...(overrides.resumeCursor !== undefined ? { resumeCursor: overrides.resumeCursor } : {}),
    nonce: challenge.nonce as string,
    audience: challenge.audience as string,
    issuedAt: challenge.issuedAt as number,
    expiresAt: challenge.expiresAt as number,
  }
  const signature = overrides.signature ?? sign('sha256', canonicalAuthChallenge(fields), identity.privateKey).toString('base64url')
  ws.receive({
    v: 2,
    type: 'c2s.auth.prove',
    id: 'auth-1',
    payload: { ...fields, signature },
  })
}
