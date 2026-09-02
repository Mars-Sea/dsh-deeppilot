# Compatibility

This file separates tested evidence from intended behavior. Passing unit tests does not prove every DSH build, network, Mac, or iPhone combination.

## Public-beta baseline

| Component | Baseline | Evidence |
|---|---|---|
| Node.js | 22 or newer | package engine and CI |
| DSH CLI and Host API | `0.1.2-alpha.3` minimum; `0.1.2-alpha.4` verified | clean alpha.3 install and Host-start smoke; isolated alpha.4 type/build plus 167 unit tests; alpha.4 Host-start smoke; `/phone` protocol tests |
| Host OS | macOS on Apple silicon | embedded helper artifact and local integration testing |
| Remote access | Tailscale Funnel, ports 443/8443/10000 | helper and supervisor tests |
| iOS | native DeepPilot client, protocol v2 | simulator build and v2 pairing/challenge evidence |

## Protocol boundary

- Protocol v2 is the only supported wire version. Existing protocol-v1 devices must pair again after upgrading.
- Bearer authentication, URL credentials, and first-frame shared tokens are rejected. A supported client registers a P-256 public key through `/phone/pair` and signs each WebSocket challenge.
- Without a compatible embedded helper, the core bridge and trusted-LAN mode can still run; remote Funnel reports `unavailable`.
- If a DSH Host API is missing, only the dependent capability should be disabled. The plugin must not crash the Host.
- DSH versions older than `0.1.2-alpha.3` are unsupported: they do not expose
  the Gateway multi-client Remote Events routing required by this plugin.
- DSH `0.1.2-alpha.4` keeps the Gateway Remote Events contract used for
  approvals and questions. Its event-sequence/log-offset refactor changes
  session internals, but the plugin's stable history facade passes the alpha.4
  type/build and unit-test baseline.
- On the alpha.3 package baseline, the compatibility facade converts the
  current Session controller's raw event arrays into the stable wrapped
  history entries consumed by the phone bridge. Sessions persisted by earlier
  Hosts can therefore be listed and opened when the alpha.3 Host's own
  persistence reader accepts their log vocabulary. Unsupported persisted
  formats still fail closed in the Host without modifying the original log.

## Not yet claimed

- Intel macOS support for the embedded helper;
- signed/notarized helper distribution;
- Windows or Linux host validation;
- repair or migration of persisted history rejected by the `0.1.2-alpha.3`
  Host's own session reader;
- every DSH developer-preview revision;
- physical-device performance and every carrier/network combination;
- production APNs delivery without a real provider credential and device.

When reporting an issue, include `node --version`, the exact DSH package version, plugin commit/tag, macOS version and architecture, connection mode, and sanitized status output. Never include pairing codes, key material, APNs tokens, or message content.
