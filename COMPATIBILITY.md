# Compatibility

This file separates tested evidence from intended behavior. Passing unit tests does not prove every DSH build, network, Mac, or iPhone combination.

## Public-beta baseline

| Component | Baseline | Evidence |
|---|---|---|
| Node.js | 22 or newer | package engine and CI |
| DSH CLI and Host API | the `0.1.5-rc.*` and `0.1.6-*`/`0.1.6` lines, `0.1.5-rc.1` minimum, for plugin `0.7.x` | plugin source typecheck, unit suite (240 tests) and `tsdown` build run against both the `0.1.5-rc.2` and the `0.1.6-alpha.1` package families; bridge and `/phone` protocol tests |
| Host OS | macOS, Linux, Windows on packaged amd64/arm64 helper targets | helper checksums plus user-confirmed Windows/Linux Funnel launch and connection; local LAN validation remains part of alpha testing |
| Remote access | Tailscale Funnel, ports 443/8443/10000 | helper and supervisor tests |
| iOS | native DeepPilot client, protocol v2 | simulator build and v2 pairing/challenge evidence |

## Protocol boundary

- Protocol v2 is the only supported wire version. Existing protocol-v1 devices must pair again after upgrading.
- Plugin `0.7.x` serves the LAN listener over self-signed TLS only; devices paired over LAN with `0.6.x` or older must pair again so the app receives the certificate fingerprint. The DSH web server no longer carries `/phone` compatibility routes. Funnel pairings are unaffected.
- Bearer authentication, URL credentials, and first-frame shared tokens are rejected. A supported client registers a P-256 public key through `/phone/pair` and signs each WebSocket challenge.
- Without a compatible embedded helper, the core bridge and trusted-LAN mode can still run; remote Funnel reports `unavailable`.
- If a DSH Host API is missing, only the dependent capability should be disabled. The plugin must not crash the Host.
- Plugin `0.7.x` requires DSH `0.1.5-rc.1` or newer within the `0.1.x` line.
  Older plugin versions used developer-preview DSH builds and remain historical
  artifacts.
- The declared peer range is a disjunction,
  `^0.1.5-rc.1 || >=0.1.6-alpha.1 <0.2.0-0`, because npm's prerelease rule only
  lets a prerelease version satisfy a range whose comparators carry a
  prerelease on the same `major.minor.patch` tuple. Neither `^0.1.5-rc.1` nor
  `>=0.1.5-rc.1` alone admits a `0.1.6` prerelease. `tests/compatibility-metadata.test.ts`
  asserts the range admits `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.6-alpha.1`,
  `0.1.6-beta.1` and `0.1.6`, and rejects `0.2.0`.
- DSH `0.1.6-alpha.1` replaced `agent/session-start` with `agent/created`,
  deprecated the synchronous `snapshotEvents`/`eventAt`/`ownEvents` history
  readers, and renamed the PTC packages to the `ptc-runtime` family. The plugin
  uses none of those surfaces: every host dependency is resolved structurally
  from the Cordis context (`sessionController`, `workspaceController`,
  `directoryPickerController`, `sessionProjections`) and the `session/event`
  and `api-session/*` events, all of which kept their `0.1.5-rc` shape.
- The compatibility facade converts the
  current Session controller's raw event arrays into the stable wrapped
  history entries consumed by the phone bridge. Sessions persisted by earlier
  Hosts can therefore be listed and opened when the rc.1 Host's own
  persistence reader accepts their log vocabulary. Unsupported persisted
  formats still fail closed in the Host without modifying the original log.

## Not yet claimed

- Intel macOS support for the embedded helper;
- signed/notarized helper distribution;
- repair or migration of persisted history rejected by the Host's own session
  reader;
- every DSH developer-preview revision;
- physical-device performance and every carrier/network combination;
- production APNs delivery without a real provider credential and device.

When reporting an issue, include `node --version`, the exact DSH package version, plugin commit/tag, macOS version and architecture, connection mode, and sanitized status output. Never include pairing codes, key material, APNs tokens, or message content.
