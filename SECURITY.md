# Security policy

## Supported releases

Until the first stable release, only the latest tagged public-beta release is supported. Reports must include the exact DSH version, plugin commit or tag, operating system, architecture, and whether LAN or Funnel mode was used.

## Reporting a vulnerability

Do not open a public issue containing pairing codes, APNs device tokens, provider keys, relay credentials, private hostnames, conversation content, or an unpatched exploit. Use GitHub private vulnerability reporting for `Mars-Sea/dsh-deeppilot` when available. Otherwise open a minimal issue asking for a private contact channel without sensitive details.

## Protocol-v2 trust boundaries

- `/phone/pair` accepts only a short-lived, single-use pairing code and a P-256 public key. The code expires after five minutes and is invalidated after one successful registration.
- `/phone` upgrades anonymously, then sends a fresh 30-second challenge bound to the stable Host audience. The client proves possession of its registered P-256 private key with ECDSA/SHA-256.
- The iOS app uses a non-exportable Secure Enclave key on physical devices. The Mac stores only public keys and metadata.
- `GET /phone/health` is intentionally unauthenticated and returns only minimal readiness/version facts.
- Protocol v1, shared Bearer tokens, query credentials, and `c2s.hello.auth` are not accepted. There is no remote downgrade switch.
- The server enforces explicit protocol scopes, while the normal settings UI grants the default scope set and exposes only the global connection switch plus per-device deletion. Deleting a device disconnects it immediately.
- The canonical `$DSH_HOME/deeppilot` directory is repaired to mode `0700`. `host-id` and `devices-v2.json` are owner-only.
- LAN `ws://` is unencrypted. Use it only on a trusted network. Public access should use Funnel HTTPS/WSS.
- The Funnel helper publishes only `/phone`, `/phone/pair`, and `/phone/health`, never the complete DSH Web UI.
- Logs must never include pairing codes, key material, APNs tokens, or message bodies.

## Online attack controls

- The Funnel helper allows at most 60 requests per source per minute and 600 globally. Concurrent WebSockets per public source are configurable from 1 to 16 and default to 8.
- The Node bridge independently allows at most 12 anonymous authentication or pairing attempts per source per minute, 120 globally, and two concurrent unauthenticated WebSockets per source.
- Five failures within ten minutes block that source for 15 minutes. A blocked request receives HTTP 429 with `Retry-After`.
- The bridge ignores caller-supplied forwarding headers on non-loopback sockets.
- Audit logs use process-local salted hashes, preventing stable source/device correlation across restarts.

If a QR code is exposed before expiry, invalidate it or issue a new one. If a paired device is lost or suspected compromised, delete that device from the settings list; other devices remain valid.

## Release integrity

Verify the public-beta helper from the repository root with:

```bash
cd bin && shasum -a 256 -c SHA256SUMS
```

Developer ID signing and notarization remain release gates for broad end-user distribution.
