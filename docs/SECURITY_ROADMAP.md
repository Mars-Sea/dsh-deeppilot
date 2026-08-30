# Security roadmap: protocol v2

[简体中文](./SECURITY_ROADMAP.zh-CN.md)

Status: proposed, non-normative. `PROTOCOL.md` remains the protocol-v1 wire
contract. This document records the next security upgrade; it is not a claim
that these controls already exist.

## Why v2 is needed

Protocol v1 uses one high-entropy, long-lived bearer token shared by every
client. It is resistant to online guessing, but every copy has the same full
authority. The host cannot revoke one lost phone, distinguish cryptographic
device identities, or grant read-only access without rotating and repairing
all clients.

## Target design

1. Pair with a short-lived, single-use bootstrap code. The code expires after
   five minutes or the first successful enrollment and never becomes a normal
   session credential.
2. Generate a non-exportable signing key on the device when the platform
   supports it (Secure Enclave on iOS, with Keychain fallback). Register only
   the public key and an operator-approved display name on the host.
3. Authenticate each connection with a host nonce, device signature, protocol
   version, audience, and bounded timestamp. Consume every nonce once to stop
   replay; bind the accepted identity to that WebSocket.
4. Issue short-lived session authorization after the signed challenge. Do not
   put bootstrap codes, signatures, or session credentials in URLs.
5. Store an explicit host-side device record with public-key fingerprint,
   creation time, last use, revocation status, and scopes. Support immediate
   per-device revoke without affecting other phones.
6. Define least-privilege scopes at minimum for conversation read, prompt send,
   session management, and approval/question response. Deny unspecified scopes
   by default. Require a fresh local biometric/user-presence check in the app
   before high-impact approval responses where iOS can enforce it.
7. Sign all security-relevant audit events with privacy-preserving device-key
   fingerprints. Never persist source IPs, message bodies, credentials, or raw
   APNs tokens in ordinary logs.

## Migration and downgrade rules

- Add v2 as an explicit negotiation, not as a silent reinterpretation of v1.
- Existing v1 clients may enter a time-bounded migration window. The settings
  page must show that shared-token access is active and allow the operator to
  disable it after all devices enroll.
- Once an installation disables v1, a remote client cannot re-enable it or
  negotiate down from v2. Re-enabling legacy access is a local host action.
- Device records created from today's display-only `devices.json` must not be
  treated as cryptographic identities. They require fresh enrollment.
- Keep the current shared token only as a migration/bootstrap input, then erase
  it after the final v1 client is removed.

## Required validation before release

- Unit tests for expiry, nonce reuse, signature/audience mismatch, scope denial,
  revoke races, clock skew, and v1 downgrade attempts.
- Cross-language test vectors shared by TypeScript and Swift for signatures and
  canonical challenge encoding.
- Integration tests through both LAN and Funnel, including reconnect/resume,
  token rotation during migration, and concurrent device revocation.
- Abuse tests for connection churn, malformed keys/signatures, registry-cap
  exhaustion, replay, and requests from many source addresses.
- A documented recovery path for a lost host registry and a local-only escape
  hatch that cannot be invoked through `/phone`.

## Release gates outside protocol v2

Before describing the bundled helper as production-ready, automate dependency
vulnerability scans, keep CodeQL and dependency update checks green, and sign
and notarize every distributed macOS helper. Signing requires the maintainer's
Developer ID and notarization credentials; CI can enforce it only after those
secrets and the release workflow are configured.
