import type { PairingTarget } from '../pairing-qr.ts'
import type { PairingGrantSnapshot } from '../report-wire.ts'

/**
 * Pure state machine for the pairing panel on the plugin settings page.
 *
 * It lives outside the React component because the behaviour that used to be
 * wrong is exactly the kind a renderer cannot show in a unit test: switching
 * between the LAN and public address must keep the panel open and re-issue a
 * grant for the newly selected host instead of collapsing it.
 */
export interface PairingPanelState {
  /** Address the visible grant was issued for; null = panel closed. */
  target: PairingTarget | null
  busy: boolean
  grant: PairingGrantSnapshot | null
  link: string | null
  qrDataURL: string | null
  message: string
  /** Transient "copied" feedback; cleared after a moment. */
  notice: string
  /** Monotonic id; only the newest in-flight issue may render a result. */
  requestId: number
}

export const initialPairingPanelState: PairingPanelState = {
  target: null,
  busy: false,
  grant: null,
  link: null,
  qrDataURL: null,
  message: '',
  notice: '',
  requestId: 0,
}

export type PairingPanelAction =
  /** "Show QR code" or switching address while the panel is open. */
  | { type: 'show'; target: PairingTarget; requestId: number }
  | { type: 'issued'; requestId: number; grant: PairingGrantSnapshot; link: string; qrDataURL: string }
  | { type: 'failed'; requestId: number; message: string }
  /** Clipboard result for the pairing string. */
  | { type: 'notice'; message: string }
  | { type: 'dismissNotice' }
  /** "Hide QR code": explicit close, or the single-use code expired. */
  | { type: 'close'; message?: string }

export function pairingPanelReduce(state: PairingPanelState, action: PairingPanelAction): PairingPanelState {
  switch (action.type) {
    case 'show':
      // Keep the panel open for the new target: the grant, the link and the QR
      // all belong to the previous address and are cleared until the new one
      // arrives, so a stale string can never be paired against a new host.
      return {
        target: action.target,
        busy: true,
        grant: null,
        link: null,
        qrDataURL: null,
        message: '',
        notice: '',
        requestId: action.requestId,
      }
    case 'issued':
      if (action.requestId !== state.requestId) return state
      return {
        ...state,
        busy: false,
        grant: action.grant,
        link: action.link,
        qrDataURL: action.qrDataURL,
      }
    case 'failed':
      if (action.requestId !== state.requestId) return state
      // The message stays on the now-empty panel so the user reads it where the
      // QR code was, instead of the panel silently collapsing.
      return { ...state, busy: false, grant: null, link: null, qrDataURL: null, message: action.message }
    case 'notice':
      return { ...state, notice: action.message }
    case 'dismissNotice':
      return state.notice === '' ? state : { ...state, notice: '' }
    case 'close':
      // Invalidate in-flight work so a late grant cannot reopen the panel.
      return { ...initialPairingPanelState, requestId: state.requestId + 1, message: action.message ?? '' }
  }
}

export interface PairingPanelView {
  /** The panel (QR + pairing info, or its error state) is on screen. */
  open: boolean
  /** An issue is in flight; the toggle is disabled while it runs. */
  busy: boolean
  /** The last issue failed; the panel shows the message and a retry hint. */
  failed: boolean
  /** Button label key: show / generating / hide. */
  action: 'pair.qrShow' | 'pair.qrGenerating' | 'pair.qrHide'
  /** Address the visible payload pairs against; null while closed or loading. */
  target: PairingTarget | null
  link: string | null
  qrDataURL: string | null
  message: string
  notice: string
}

export function pairingPanelView(state: PairingPanelState): PairingPanelView {
  // A target stays selected for as long as the panel is open, including the
  // failed state where there is a message to read but no payload yet.
  const open = state.target !== null
  return {
    open,
    busy: state.busy,
    failed: open && !state.busy && state.grant === null,
    action: state.busy ? 'pair.qrGenerating' : state.target === null ? 'pair.qrShow' : 'pair.qrHide',
    target: state.target,
    link: state.link,
    qrDataURL: state.qrDataURL,
    message: state.message,
    notice: state.notice,
  }
}
