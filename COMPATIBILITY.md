# Compatibility

This branch targets **DSH 0.1.7-rc.2**. The DSH peer dependencies and the development packages are pinned to that exact release. Earlier DSH builds and later release candidates are outside this branch's support scope.

| Component | Current contract | Evidence |
|---|---|---|
| Node.js | 22 or newer | Package engine and CI |
| DSH CLI and Host API | `0.1.7-rc.2` | Peer metadata, source typecheck, unit tests, bundle build, and config schema projection against rc.2 |
| iOS bridge | DeepPilot protocol v2 | Bridge protocol tests; device behavior must be checked with the running Host and app |
| Remote access | Tailscale Funnel on ports 443, 8443, or 10000 | Helper and supervisor tests |

## DSH interfaces used here

- The Host adapter uses Session and Workspace controllers, Gateway Remote Events, and `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)`. Its in-process carrier passes `undefined` for `uplink` and `peer` and the cancellation signal in argument five.
- The resident Client sends relative RPC paths such as `api/$events/result`. The in-process transport resolves those paths to a local URL before constructing a Node `Request`; the shared Fetch handler dispatches it without a network request. This is required for iOS approval and question answers to settle at the Gateway.
- The client settings page binds `configForms.get('deeppilot')` when the service becomes available. The Host reads volatile config references from its profile entry and reconciles transports on `loader/volatile-update`.
- Typert strict codecs publish `create()` factories. Session opening reads `session.projections` for a complete baseline.
- The Host adapter retains a stable bridge-facing API so the phone protocol does not depend directly on DSH controller shapes. This adapter is an internal design boundary, not support for an older DSH Host.

## Separate protocol and data boundaries

- Protocol v2 is the only supported phone wire version. Protocol-v1 devices must pair again. The LAN listener uses its own TLS identity and certificate pinning; old LAN pairings without a fingerprint must also pair again.
- The current app accepts the `deeppilot://pair` link and the JSON pairing payload. Bearer authentication, URL credentials, and first-frame shared tokens are rejected; devices register a P-256 public key and sign each WebSocket challenge.
- The plugin's persisted device and Funnel state migration remains separate from DSH API version support. Session logs written by earlier DSH builds are readable only when the current Host's own history reader accepts them; this plugin does not rewrite those logs.
- An unavailable optional OS facility, transport, or controller disables its dependent capability without crashing the Host.

## rc.2 feature planning

The source-level audit of `dsh-v0.1.7-rc.2` found no breaking change in the DSH service surfaces currently used by the plugin. The exact rc.2 package pins, corrected registry lockfile, compatibility assertions, generated output, unit tests, typecheck, build, and config-schema check now pass locally. A real rc.2 `web` profile smoke test and the clean-install release gate remain before publishing. The planned phone additions for durable schedules and session forking are specified in [`docs/DEEPPILOT_FEATURE_PLAN.md`](./docs/DEEPPILOT_FEATURE_PLAN.md); they are not advertised until the protocol, iOS mirror, and integration tests land.

The complete audit evidence and re-audit procedure remain in [`docs/DSH_RELEASE_MEMORY.md`](./docs/DSH_RELEASE_MEMORY.md).

## Evidence limits

Unit tests and config schema projection do not prove every network, Mac, Linux, Windows, or iPhone combination. In particular, physical-device performance, signed helper distribution, and production APNs delivery need their own checks. Include the exact DSH version, plugin commit, Node version, OS, connection mode, and sanitized status output when reporting a compatibility issue; never include credentials or message content.
