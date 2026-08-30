# Security policy

## Supported releases

Until the first stable release, only the latest tagged public-beta release is
supported. DSH itself is a developer preview, so reports must include the exact
DSH version, plugin commit or tag, operating system, architecture, and whether
LAN or Funnel mode was used.

## Reporting a vulnerability

Do not open a public issue containing pairing tokens, APNs device tokens,
provider keys, relay credentials, private hostnames, conversation content, or
an unpatched exploit. Use GitHub's private vulnerability reporting for
`Mars-Sea/dsh-deeppilot` when available. If that channel is unavailable, open a
minimal public issue requesting a private contact channel without including
the sensitive details.

## Trust boundaries

- `/phone` and `/phone/health` require the pairing bearer token.
- Clients authenticate with the `Authorization: Bearer` header or the first
  WebSocket frame. Query-string credentials are rejected because URLs are
  commonly retained by proxies, browser history, and access logs.
- The token is stored with mode `0600` on the Mac and in iOS Keychain.
- The canonical `~/.dsh/deeppilot` data directory is repaired to mode `0700`
  at startup. Custom token paths remain the operator's responsibility.
- Pairing QR codes contain the bearer secret. Treat screenshots as leaked
  credentials and rotate the token from the DeepPilot settings page.
- LAN `ws://` is unencrypted. Use it only on a trusted network.
- The optional Funnel helper publishes only `/phone` and `/phone/health`, not
  the complete DSH Web UI.
- Debug logs may include status and masked identifiers, but must never include
  pairing tokens or message bodies.

## Online attack controls

- The public Funnel helper allows at most 60 requests per source per minute and
  600 requests globally per minute. Concurrent WebSockets per public source are
  configurable from 1 to 16 in the plugin settings and default to 8. Its
  source-state table is bounded.
- The Node bridge independently allows at most 12 anonymous authentication
  attempts per source per minute, 120 globally per minute, and two concurrent
  unauthenticated WebSockets per source.
- Five authentication failures within ten minutes block that source for 15
  minutes. Successful authentication clears its failure history. A blocked
  request receives HTTP `429` with `Retry-After`.
- Funnel supplies the public source address over the private loopback hop. The
  bridge ignores a caller-supplied forwarding header on non-loopback sockets.
- Authentication audit logs use process-local salted hashes for source and
  device identifiers. They are useful for correlating one runtime, not for
  reconstructing stable user or network identities.

These controls reduce opportunistic brute force and resource exhaustion; they
do not make a leaked bearer token safe. Rotate the token immediately after a
QR screenshot leak, suspected machine compromise, or unexplained successful
device registration. Rotation invalidates all existing clients.

The shared bearer grants the connected client the complete protocol-v1 bridge
authority, including prompts and approval responses. Per-device revocation and
least-privilege scopes require protocol v2 and are tracked in
[`docs/SECURITY_ROADMAP.md`](docs/SECURITY_ROADMAP.md).

## Release integrity

The public beta includes a prebuilt macOS Apple-silicon helper. Verify it from
the repository root with:

```bash
cd bin && shasum -a 256 -c SHA256SUMS
```

Developer ID signing and notarization are release gates for broad end-user
distribution. Until those gates are complete, the helper is a public-beta
artifact and not a production-readiness claim.
