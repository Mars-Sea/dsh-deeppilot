import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialPairingPanelState,
  pairingPanelReduce,
  pairingPanelView,
  type PairingPanelState,
} from '../src/client/pairing-panel.ts'
import type { PairingTarget } from '../src/pairing-qr.ts'

const LAN: PairingTarget = {
  host: 'https://192.168.1.149:3098',
  kind: 'lan',
  tlsFingerprint: 'sha256:' + 'A'.repeat(43),
}
const PUBLIC: PairingTarget = { host: 'https://phone.example.ts.net', kind: 'public' }
const grant = (expiresInMs = 300_000) => ({ code: 'c'.repeat(43), expiresAt: Date.now() + expiresInMs, audience: 'deeppilot:abcdefghijklmnopqrstuv' })

function issued(state: PairingPanelState, target: PairingTarget, requestId: number, link: string): PairingPanelState {
  return pairingPanelReduce(
    pairingPanelReduce(state, { type: 'show', target, requestId }),
    { type: 'issued', requestId, grant: grant(), link, qrDataURL: 'data:image/svg+xml;base64,abc' },
  )
}

test('showing the QR code opens the panel for the selected address', () => {
  const state = issued(initialPairingPanelState, LAN, 1, 'deeppilot://pair?h=lan')
  const view = pairingPanelView(state)

  assert.equal(view.open, true)
  assert.equal(view.action, 'pair.qrHide')
  assert.equal(view.target?.host, LAN.host)
  assert.equal(view.link, 'deeppilot://pair?h=lan')
})

test('switching between LAN and public keeps the panel open', () => {
  const open = issued(initialPairingPanelState, LAN, 1, 'deeppilot://pair?h=lan')

  // The reported bug: picking the other address collapsed the panel.
  const switching = pairingPanelReduce(open, { type: 'show', target: PUBLIC, requestId: 2 })
  const switchingView = pairingPanelView(switching)
  assert.equal(switchingView.open, true, 'panel must stay open while the new grant is issued')
  assert.equal(switchingView.busy, true)
  assert.equal(switchingView.target?.host, PUBLIC.host)
  // The previous address' credentials must not be shown for the new host.
  assert.equal(switchingView.link, null)
  assert.equal(switchingView.qrDataURL, null)

  const switched = pairingPanelReduce(switching, {
    type: 'issued',
    requestId: 2,
    grant: grant(),
    link: 'deeppilot://pair?h=public',
    qrDataURL: 'data:image/svg+xml;base64,def',
  })
  const switchedView = pairingPanelView(switched)
  assert.equal(switchedView.open, true)
  assert.equal(switchedView.target?.host, PUBLIC.host)
  assert.equal(switchedView.link, 'deeppilot://pair?h=public')
  assert.equal(switchedView.qrDataURL, 'data:image/svg+xml;base64,def')
})

test('a stale response from the previous address cannot win the race', () => {
  const open = issued(initialPairingPanelState, LAN, 1, 'deeppilot://pair?h=lan')
  const switching = pairingPanelReduce(open, { type: 'show', target: PUBLIC, requestId: 2 })

  // The LAN issue resolves after the switch: it must be ignored.
  const stale = pairingPanelReduce(switching, {
    type: 'issued',
    requestId: 1,
    grant: grant(),
    link: 'deeppilot://pair?h=lan',
    qrDataURL: 'data:image/svg+xml;base64,lan',
  })
  assert.equal(stale.link, null)
  assert.equal(stale.target?.host, PUBLIC.host)
  assert.equal(stale.busy, true)

  const staleFailure = pairingPanelReduce(switching, { type: 'failed', requestId: 1, message: 'stale' })
  assert.equal(staleFailure.message, '')
  assert.equal(staleFailure.busy, true)
})

test('hiding and expiring both close the panel', () => {
  const open = issued(initialPairingPanelState, LAN, 1, 'deeppilot://pair?h=lan')

  const hidden = pairingPanelView(pairingPanelReduce(open, { type: 'close' }))
  assert.equal(hidden.open, false)
  assert.equal(hidden.link, null)
  assert.equal(hidden.action, 'pair.qrShow')

  const expired = pairingPanelView(pairingPanelReduce(open, { type: 'close', message: 'expired' }))
  assert.equal(expired.open, false)
  assert.equal(expired.message, 'expired')

  // Closing invalidates an in-flight issue so a late grant cannot reopen it.
  const closedAgain = pairingPanelReduce(pairingPanelReduce(open, { type: 'close' }), {
    type: 'issued',
    requestId: 1,
    grant: grant(),
    link: 'deeppilot://pair?h=lan',
    qrDataURL: 'data:image/svg+xml;base64,lan',
  })
  assert.equal(pairingPanelView(closedAgain).open, false)
})

test('a failure reopens the panel state with a message instead of hiding it', () => {
  const failed = pairingPanelReduce(
    pairingPanelReduce(initialPairingPanelState, { type: 'show', target: LAN, requestId: 1 }),
    { type: 'failed', requestId: 1, message: 'pairing unavailable' },
  )
  const view = pairingPanelView(failed)

  assert.equal(view.busy, false)
  assert.equal(view.message, 'pairing unavailable')
  assert.equal(view.open, true, 'the user keeps the context they were looking at')
})

test('copy feedback is transient and does not touch the payload', () => {
  const open = issued(initialPairingPanelState, LAN, 1, 'deeppilot://pair?h=lan')
  const withNotice = pairingPanelReduce(open, { type: 'notice', message: 'copied' })

  assert.equal(pairingPanelView(withNotice).notice, 'copied')
  assert.equal(withNotice.link, open.link)
  assert.equal(pairingPanelView(pairingPanelReduce(withNotice, { type: 'dismissNotice' })).notice, '')
})
