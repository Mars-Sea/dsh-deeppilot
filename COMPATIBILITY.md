# Compatibility

This file separates tested evidence from intended fallback behavior. Passing
unit tests does not prove every DSH build, network, Mac, or iPhone combination.

## Public-beta baseline

| Component | Baseline | Evidence |
|---|---|---|
| Node.js | 22 or newer | package engine and CI |
| DSH packages | `0.1.2-alpha.1` peer family | source-built official alpha Web host, paired iOS client, new-session message flow, and `/phone` protocol smoke tests |
| Host OS | macOS on Apple silicon | embedded helper artifact and local integration testing |
| Remote access | Tailscale Funnel, ports 443/8443/10000 | helper and supervisor tests; real-tailnet acceptance remains release-specific |
| iOS | native DeepPilot client, protocol v1 | simulator build and bridge pairing evidence |

## Expected degradation

- Without a compatible embedded helper, the core bridge and trusted-LAN mode
  can still run; remote Funnel reports `unavailable`.
- If a DSH host API is missing, only the dependent capability should be
  disabled. The plugin must not crash the host.
- On the `0.1.2-alpha.1` test host, the compatibility facade converts the
  current Session controller's raw event arrays into the stable wrapped
  history entries consumed by the phone bridge. Sessions persisted by earlier
  Hosts can therefore be listed and opened when the 0.1.2 Host's own
  persistence reader accepts their log vocabulary. Unsupported persisted
  formats still fail closed in the Host without modifying the original log.
- Query-string token authentication is legacy compatibility only. Current
  clients use Bearer or first-frame authentication.

## Not yet claimed

- Intel macOS support for the embedded helper;
- signed/notarized helper distribution;
- Windows or Linux host validation;
- repair or migration of persisted history rejected by the `0.1.2-alpha.1`
  Host's own session reader;
- every DSH developer-preview revision;
- physical-device performance and every carrier/network combination;
- production APNs delivery without a real provider credential and device.

When reporting an issue, include `node --version`, the exact DSH package
version, plugin commit/tag, macOS version and architecture, connection mode,
and sanitized status output. Never include bearer tokens or message content.
