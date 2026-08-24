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
- New clients authenticate with the `Authorization: Bearer` header or the
  first WebSocket frame. Query-string tokens exist only for legacy clients.
- The token is stored with mode `0600` on the Mac and in iOS Keychain.
- Pairing QR codes contain the bearer secret. Treat screenshots as leaked
  credentials and rotate the token from the DeepPilot settings page.
- LAN `ws://` is unencrypted. Use it only on a trusted network.
- The optional Funnel helper publishes only `/phone` and `/phone/health`, not
  the complete DSH Web UI.
- Debug logs may include status and masked identifiers, but must never include
  pairing tokens or message bodies.

## Release integrity

The public beta includes a prebuilt macOS Apple-silicon helper. Verify it from
the repository root with:

```bash
cd bin && shasum -a 256 -c SHA256SUMS
```

Developer ID signing and notarization are release gates for broad end-user
distribution. Until those gates are complete, the helper is a public-beta
artifact and not a production-readiness claim.
