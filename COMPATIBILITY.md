# Compatibility

This file separates tested evidence from intended behavior. Passing unit tests does not prove every DSH build, network, Mac, or iPhone combination.

## Public-beta baseline

| Component | Baseline | Evidence |
|---|---|---|
| Node.js | 22 or newer | package engine and CI |
| DSH CLI and Host API | `0.1.2-rc.1` minimum for plugin `0.6.0-alpha.4` | rc.1 package-family typecheck/build; bridge and `/phone` protocol tests |
| Host OS | macOS, Linux, Windows on packaged amd64/arm64 helper targets | helper checksums plus user-confirmed Windows/Linux Funnel launch and connection; local LAN validation remains part of alpha testing |
| Remote access | Tailscale Funnel, ports 443/8443/10000 | helper and supervisor tests |
| iOS | native DeepPilot client, protocol v2 | simulator build and v2 pairing/challenge evidence |

## Protocol boundary

- Protocol v2 is the only supported wire version. Existing protocol-v1 devices must pair again after upgrading.
- Bearer authentication, URL credentials, and first-frame shared tokens are rejected. A supported client registers a P-256 public key through `/phone/pair` and signs each WebSocket challenge.
- Without a compatible embedded helper, the core bridge and trusted-LAN mode can still run; remote Funnel reports `unavailable`.
- If a DSH Host API is missing, only the dependent capability should be disabled. The plugin must not crash the Host.
- Plugin `0.6.0-alpha.4` requires DSH `0.1.2-rc.1` or newer. Older plugin
  alphas used developer-preview DSH builds and remain historical artifacts.
- The compatibility facade converts the
  current Session controller's raw event arrays into the stable wrapped
  history entries consumed by the phone bridge. Sessions persisted by earlier
  Hosts can therefore be listed and opened when the rc.1 Host's own
  persistence reader accepts their log vocabulary. Unsupported persisted
  formats still fail closed in the Host without modifying the original log.

## Not yet claimed

- Intel macOS support for the embedded helper;
- signed/notarized helper distribution;
- repair or migration of persisted history rejected by the `0.1.2-rc.1`
  Host's own session reader;
- every DSH developer-preview revision;
- physical-device performance and every carrier/network combination;
- production APNs delivery without a real provider credential and device.

When reporting an issue, include `node --version`, the exact DSH package version, plugin commit/tag, macOS version and architecture, connection mode, and sanitized status output. Never include pairing codes, key material, APNs tokens, or message content.
