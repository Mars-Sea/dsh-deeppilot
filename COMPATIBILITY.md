# Compatibility

This file separates tested evidence from intended behavior. Passing unit tests does not prove every DSH build, network, Mac, or iPhone combination.

## Public-beta baseline

| Component | Baseline | Evidence |
|---|---|---|
| Node.js | 22 or newer | package engine and CI |
| DSH CLI and Host API | the `0.1.5-rc.*` and `0.1.6-*`/`0.1.6` lines, `0.1.5-rc.1` minimum, for plugin `0.7.x` | plugin source typecheck, unit suite (301 tests) and `tsdown` build run against the `0.1.5-rc.2`, `0.1.6-alpha.1` and `0.1.6-alpha.2` package families; the `deeppilot/report` contribution registered through both the `0.1.6-alpha.1` and the `0.1.6-alpha.2` `TypertRegistry`; bridge and `/phone` protocol tests |
| Host OS | macOS, Linux, Windows on packaged amd64/arm64 helper targets | helper checksums plus user-confirmed Windows/Linux Funnel launch and connection; local LAN validation remains part of alpha testing |
| Remote access | Tailscale Funnel, ports 443/8443/10000 | helper and supervisor tests |
| iOS | native DeepPilot client, protocol v2 | simulator build and v2 pairing/challenge evidence |

## Protocol boundary

- Protocol v2 is the only supported wire version. Existing protocol-v1 devices must pair again after upgrading.
- The pairing QR now encodes a `deeppilot://pair` link, and the settings page shows that same string in one copy field. An app build that predates the link only parses the JSON payload, so it must be updated before pairing against this plugin; a link pasted into an older app is rejected instead of being half-applied. The current app still accepts the JSON payload.
- Plugin `0.7.x` serves the LAN listener over self-signed TLS only; devices paired over LAN with `0.6.x` or older must pair again so the app receives the certificate fingerprint. The DSH web server no longer carries `/phone` compatibility routes. Funnel pairings are unaffected.
- Bearer authentication, URL credentials, and first-frame shared tokens are rejected. A supported client registers a P-256 public key through `/phone/pair` and signs each WebSocket challenge.
- Without a compatible embedded helper, the core bridge and trusted-LAN mode can still run; remote Funnel reports `unavailable`.
- If a DSH Host API is missing, only the dependent capability should be disabled. The plugin must not crash the Host.
- Plugin `0.7.x` requires DSH `0.1.5-rc.1` or newer within the `0.1.x` line.
  Older plugin versions used developer-preview DSH builds and remain historical
  artifacts.
- The declared peer range is a disjunction,
  `^0.1.5-rc.1 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0`,
  because npm's prerelease rule only
  lets a prerelease version satisfy a range whose comparators carry a
  prerelease on the same `major.minor.patch` tuple. Neither `^0.1.5-rc.1` nor
  `>=0.1.5-rc.1` alone admits a `0.1.6` prerelease, and the `0.1.7-alpha.*`
  line is likewise rejected by `>=0.1.6-alpha.1 <0.2.0-0` because no
  comparator there carries a prerelease on the `0.1.7` tuple — every new
  prerelease line needs its own disjunct.
  `tests/compatibility-metadata.test.ts`
  asserts the range admits `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.6-alpha.1`,
  `0.1.6-beta.1`, `0.1.6`, `0.1.7-alpha.1` and `0.1.7`,
  and rejects `0.2.0`.
- DSH `0.1.6-alpha.1` replaced `agent/session-start` with `agent/created`,
  deprecated the synchronous `snapshotEvents`/`eventAt`/`ownEvents` history
  readers, and renamed the PTC packages to the `ptc-runtime` family. The plugin
  uses none of those surfaces: every host dependency is resolved structurally
  from the Cordis context (`sessionController`, `workspaceController`,
  `directoryPickerController`, `sessionProjections`) and the `session/event`
  and `api-session/*` events, all of which kept their `0.1.5-rc` shape.
- DSH `0.1.6-alpha.2` changed the strict codec shape carried by an
  `InvocationDescriptor`. Through `0.1.6-alpha.1` a descriptor published the
  schema value itself and every consumer called `codec.schema.parse(value)`;
  `alpha.2` instead validates a lazy `create()` factory at registration and the
  Gateway parses through `codec.create().parse(value)`. A codec carrying only
  `schema` is rejected by the `alpha.2` registry
  (`typert: … strict codec has no create() factory`), which aborts plugin
  activation. One `strictCodec()` helper in `src/report-wire.ts` emits both
  keys — the same hand-written, dependency-free codec — so a single published
  package registers and parses on either generation, and
  `tests/report-wire.test.ts` pins both access paths.
  The other `alpha.2` Typert change — a contributed schema's materialized
  `schema` becoming a lazy `create()` factory — does not apply here: this
  Remote contributes no schemas, which the same test asserts.
- DSH `0.1.7-alpha.1` reordered the Host `typertGateway.wireStream.open`
  parameters from `(endpoint, payload, signal)` to
  `(endpoint, payload, uplink, peer, signal)`. The reorder is not additive: a
  3-argument call lands the `AbortSignal` in the `uplink` slot, leaves `signal`
  undefined, and the Host fails every stream inside
  `AbortSignal.any([signal, …])` with
  `TypeError [ERR_INVALID_ARG_TYPE]: The "signals[0]" argument must be an
  instance of AbortSignal`. The resident Client's Connection treats that dead
  generation as a lost connection and prints an endless
  `[connection] connection lost, retry #N` loop with exponential backoff while
  the phone's approval and question round-trips stay broken.
  `openHostStream()` in `src/dsh012-remote-interactions.ts` selects the
  contract from the published arity (`open.length`) and passes `undefined` for
  both `uplink` and `peer` on 0.1.7 — the documented "operator's in-process
  carrier" case, since DeepPilot's carrier owns the Host in process and has no
  Client-to-Host uplink. `tests/dsh012-wire-stream-contract.test.ts` pins the
  argument binding for a 3-arity and a 5-arity Host, and asserts the signal
  lands in each contract's declared slot.
- DSH `0.1.7-alpha.1` rewrote the settings subsystem: `installSection`,
  `SettingsSectionHooks`, and the client `settingsScope` service are gone,
  section values persist in this plugin own profile config entry, and the
  settings UI refuses writes to fields the schema does not declare
  `.volatile()`. The plugin adapts across both generations: `live()` in
  `src/config.ts` feature-detects the volatile method and, on schemastery
  3.18.2, writes the same metadata through `extra('volatile', true)` (an
  unconditional `.volatile()` throws at import on ≤ 0.1.6 and kills
  activation); volatile fields are exactly the ones the settings surface
  writes (`enabled`, `local`, `remote`, plus read-time `debug`) while
  `devicesPath`, `historyBufferMax`, and `push` keep remount-on-edit
  semantics; `normalizeOptions` unwraps the `{ get() }`
  references 0.1.7 carries in `apply()` options (a surviving reference fails
  every plain-value comparison the bridge makes), the host re-runs its
  transport reconciles on `loader/volatile-update`, and the client binds
  `ctx.configForms.get('deeppilot')` through `src/client/settings-scope.ts`
  when `settingsScope` is absent. Neither seam is declared in the client
  entry's `inject`: a service name no running host provides keeps the whole
  entry pending (`dsh-deeppilot: pending (waiting for service: settingsScope)`
  on the first 0.1.7 boot), so both are awaited as optional injections, and
  both are read through `ctx.get()` because a Cordis context proxy throws
  `cannot get property "settingsScope" without inject` on an undeclared
  service read; `tests/client-entry.test.ts` activates the real entry against
  a Cordis context shaped like each generation and pins that audit. The same
  release added
  `session.projections`; the bridge feature-detects it via
  `supportsProjections` and refreshes a session projection baseline on open,
  while older hosts keep list-row projection hints. Plugin-manager display
  metadata (`locale/*.json`, `package.json.icon`) and `--dump-config-schema`
  are additive and inert on older hosts; `npm run check:config-schema`
  projects this package Config through the pinned 0.1.7 CLI in CI and pins
  the volatile annotations on the four live fields (devDependency floor:
  `@deepseek-ai/schemastery` 3.18.3, which is also what a profile install
  resolves through the `^3.18.2` peer range).
- DSH `0.1.6-alpha.2` made runtime plugin removal real, through both the
  Plugin Manager and the client entry reconciler. Every long-lived resource is
  registered through `ctx.effect`, and the settings-page stylesheet stamps
  `data-plugin="dsh-deeppilot"` so the module system's `removeOwnedStyles()`
  can delete it; the module system only auto-claims styles present during
  factory materialization, while this sheet is injected from `apply()`.
  Without that stamp, disabling the plugin would leave its sheet styling the
  page.
- The compatibility facade converts the
  current Session controller's raw event arrays into the stable wrapped
  history entries consumed by the phone bridge. Sessions persisted by earlier
  Hosts can therefore be listed and opened when the rc.1 Host's own
  persistence reader accepts their log vocabulary. Unsupported persisted
  formats still fail closed in the Host without modifying the original log.

## Not yet claimed

- Intel macOS support for the embedded helper;
- signed/notarized helper distribution;
- validation against the `0.1.7-*` package line: the peer range admits
  `0.1.7-alpha.1` and later `0.1.7` releases, and the `wireStream.open`
  reorder that release introduced is adapted and pinned by
  `tests/dsh012-wire-stream-contract.test.ts`, but the unit suite still runs
  against the `0.1.5-rc.1`/`0.1.6-*` package families and no `0.1.7`
  typecheck or full-suite evidence has been produced yet;
- repair or migration of persisted history rejected by the Host's own session
  reader;
- every DSH developer-preview revision;
- physical-device performance and every carrier/network combination;
- production APNs delivery without a real provider credential and device.

When reporting an issue, include `node --version`, the exact DSH package version, plugin commit/tag, macOS version and architecture, connection mode, and sanitized status output. Never include pairing codes, key material, APNs tokens, or message content.
