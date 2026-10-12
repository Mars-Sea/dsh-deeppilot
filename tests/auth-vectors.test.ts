import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalAuthChallenge, verifyAuthProof, type AuthProofFields } from '../src/device-auth.ts'

// tests/fixtures/auth-vectors.json is the cross-language contract for the v2
// authentication proof. The iOS app reads the same file (AuthVectorTests), so a
// change to the canonical string or the signature encoding on either side fails
// a test on the other. Regenerate with scripts/gen-auth-vectors.mts.
interface Vectors {
  cases: Array<{ name: string; fields: AuthProofFields; canonical: string }>
  signers: Record<'node' | 'swift', { publicKey: string; signatures: Record<string, string> }>
}

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/auth-vectors.json', import.meta.url), 'utf8'),
) as Vectors

test('the canonical string matches the shared vectors byte for byte', () => {
  assert.ok(vectors.cases.length >= 6, 'fixture lost cases')
  for (const item of vectors.cases) {
    assert.equal(canonicalAuthChallenge(item.fields).toString('utf8'), item.canonical, item.name)
  }
})

for (const signer of ['node', 'swift'] as const) {
  test(`${signer}-signed proofs verify for their own case and no other`, () => {
    const { publicKey, signatures } = vectors.signers[signer]
    for (const item of vectors.cases) {
      const signature = signatures[item.name]
      assert.ok(signature, `${signer} signature missing for ${item.name}`)
      assert.equal(verifyAuthProof(publicKey, item.fields, signature), true, `${signer}/${item.name}`)
      for (const other of vectors.cases) {
        if (other.name === item.name) continue
        assert.equal(
          verifyAuthProof(publicKey, other.fields, signature),
          false,
          `${signer} signature for ${item.name} must not verify ${other.name}`,
        )
      }
    }
  })
}

test('a signature from one signer never verifies under the other signer key', () => {
  for (const item of vectors.cases) {
    assert.equal(
      verifyAuthProof(vectors.signers.node.publicKey, item.fields, vectors.signers.swift.signatures[item.name]!),
      false,
    )
    assert.equal(
      verifyAuthProof(vectors.signers.swift.publicKey, item.fields, vectors.signers.node.signatures[item.name]!),
      false,
    )
  }
})

test('every field of the signed tuple is bound by the signature', () => {
  const { publicKey, signatures } = vectors.signers.swift
  const item = vectors.cases.find((entry) => entry.name === 'cursor-42')!
  const signature = signatures[item.name]!
  const tampered: Array<[string, AuthProofFields]> = [
    ['deviceId', { ...item.fields, deviceId: item.fields.deviceId + 'x' }],
    ['deviceName', { ...item.fields, deviceName: item.fields.deviceName + 'x' }],
    ['appVersion', { ...item.fields, appVersion: item.fields.appVersion + 'x' }],
    ['nonce', { ...item.fields, nonce: 'm'.repeat(32) }],
    ['audience', { ...item.fields, audience: 'deeppilot:other' }],
    ['issuedAt', { ...item.fields, issuedAt: item.fields.issuedAt + 1 }],
    ['expiresAt', { ...item.fields, expiresAt: item.fields.expiresAt + 1 }],
    ['resumeCursor changed', { ...item.fields, resumeCursor: 43 }],
  ]
  const { resumeCursor: _dropped, ...withoutCursor } = item.fields
  tampered.push(['resumeCursor removed', withoutCursor])
  for (const [label, fields] of tampered) {
    assert.equal(verifyAuthProof(publicKey, fields, signature), false, label)
  }
  assert.equal(verifyAuthProof(publicKey, item.fields, signature), true, 'untampered control')
})
