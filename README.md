# dsh-deeppilot

**English** | [简体中文](./README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/dsh-deeppilot?style=flat-square)](https://www.npmjs.com/package/dsh-deeppilot)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![CI](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

The open-source DSH companion plugin for **DeepPilot**, a native iPhone client
for using DeepSeek Harness remotely. It connects the app directly to the DSH
Host on your own Mac and does not replace or modify the DSH Web UI.

> DeepPilot is currently in TestFlight review. The invitation link will accept
> testers after Apple approves the build.

[Join the DeepPilot TestFlight](https://testflight.apple.com/join/JHb4j5DV)

## What you get

- Browse projects, sessions, history, and live agent output from iPhone.
- Send prompts, switch models, create sessions, and answer approvals/questions.
- Pair with a five-minute single-use code and a per-device P-256 key; physical
  iPhones keep the private key in Secure Enclave.
- Connect over a trusted LAN or the optional embedded Tailscale Funnel.
- Receive live notifications and optional APNs notifications while offline.
- Self-update hint: the settings page footer shows the installed plugin
  version, with an inline "new version" link to the matching GitHub
  release when one exists (background check, stable releases only, no
  third-party dependency).

## Install from npm

Requirements: Node.js 22+, DSH with a `web` profile, and macOS. The bundled
Funnel helper currently supports Apple silicon; trusted-LAN mode does not
require it.

| Plugin version | Required DSH | How to install |
|---|---|---|
| `0.6.0-alpha.x` (new, `alpha` tag) | DSH `0.1.2-alpha.2` or newer | `dsh plugin --profile web add dsh-deeppilot@alpha` |
| `0.5.x` (previous stable, `latest`) | DSH `0.1.1-rc.2`–`0.1.2-alpha.1` | `dsh plugin --profile web add dsh-deeppilot` |

The `0.6.0` alpha line is built against the DSH
[0.1.2-alpha.2](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.2-alpha.2)
controller and client package family, so it requires DSH `0.1.2-alpha.2` or
newer (its `alpha` npm dist-tag). Earlier DSH builds do not provide the Host
APIs required by this plugin. Users who need a DSH release before that must
stay on the `0.5.x` plugin.

```sh
# DSH 0.1.2-alpha.2 or newer (recommended):
dsh plugin --profile web add dsh-deeppilot@alpha
# DSH 0.1.1-rc.2 through 0.1.2-alpha.1 (previous stable):
dsh plugin --profile web add dsh-deeppilot
dsh web
```

After DSH restarts, open **Settings → DeepPilot**, enable the connection, show
the pairing QR code, and scan it in the DeepPilot app. The same panel also
shows a copyable pairing code for Simulator or manual entry.

Package: [npmjs.com/package/dsh-deeppilot](https://www.npmjs.com/package/dsh-deeppilot)

## Update or uninstall

```sh
dsh plugin --profile web update dsh-deeppilot
dsh plugin --profile web remove dsh-deeppilot
```

Restart DSH after updating. Uninstalling the package does not delete the local
DeepPilot state under `$DSH_HOME/deeppilot/`.

## Publishing (maintainers)

`0.6.0-alpha.x` targets DSH `0.1.2-alpha.2`+; `0.5.x` stays compatible with
DSH `0.1.1-rc.2`–`0.1.2-alpha.1`. Keep both published:

1. Bump `version` in `package.json` and in the root `""` entry of
   `package-lock.json`, then run `npm test && npm run typecheck && npm run build`
   and inspect `npm pack --dry-run --json` (the check
   `tests/compatibility-metadata.test.ts` enforces the `^0.1.2-alpha.2` peer
   ranges).
2. Commit the release and push it. `npm publish` runs `prepack` (build) and
   `prepublishOnly` (test + typecheck) automatically.
3. Publish the alpha line without touching `latest`:

   ```sh
   npm publish --tag alpha
   ```

   After a successful publish, `npm view dsh-deeppilot dist-tags --json` shows
   `"latest": "0.5.x"` and `"alpha": "0.6.0-alpha.x"`. Verify the published
   package by installing it into a DSH `0.1.2-alpha.2` profile before pointing
   users at it.
4. Tag the release commit `v0.6.0-alpha.x` and prepare a GitHub Release
   (English + 简体中文 notes) that links this README section.
5. When the alpha graduates to stable, bump to `0.6.0` and publish with
   `npm publish --tag latest`, which moves `latest` to the new line. Stable
   releases must never be published with `--tag alpha`.

Never run `npm publish` from a copy that still has the old `0.5.x` version.


## Connection and privacy

Conversation traffic travels directly between the iPhone and your DSH Host.
Trusted-LAN `ws://` traffic is unencrypted, so use it only on a network you
trust. Optional Funnel mode exposes only the DeepPilot connection, one-time
pairing, and health endpoints, not the complete DSH Web UI.

The DeepPilot settings page exposes **Connections per public source** under
the collapsed **Advanced settings** section. It defaults to `8`, accepts
`1`–`16`, and briefly restarts the Funnel helper when changed, so connected
remote clients reconnect once.

Offline push is optional. Relay mode sends only the target APNs device token
and a limited notification payload; full conversation history and live output
do not pass through the relay. Read [PRIVACY.md](./PRIVACY.md) and
[SECURITY.md](./SECURITY.md) before enabling remote access or push. Protocol-v2
implementation status and remaining release validation are tracked in
[docs/SECURITY_ROADMAP.md](./docs/SECURITY_ROADMAP.md).

## Screenshots

| Home | Sidebar | Chat | Settings |
| --- | --- | --- | --- |
| <img src="./assets/screenshots/home.png" alt="DeepPilot home screen" width="220"> | <img src="./assets/screenshots/sidebar.png" alt="DeepPilot sidebar" width="220"> | <img src="./assets/screenshots/chat.png" alt="DeepPilot chat screen" width="220"> | <img src="./assets/screenshots/settings.png" alt="DeepPilot settings screen" width="220"> |

## Compatibility

See [COMPATIBILITY.md](./COMPATIBILITY.md) for the tested baseline and current
limitations. DSH is still evolving; include exact DSH and plugin versions when
reporting an issue.

## Protocol

[PROTOCOL.md](./PROTOCOL.md) is the normative DeepPilot bridge protocol. Any
wire change must update that document and `src/protocol.ts` together and be
coordinated with the private iOS client. Protocol v2 is the only supported wire
version; upgrades from v1 require re-pairing.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
cd helper && go test ./...
```

## Community and feedback

- [GitHub Issues](https://github.com/Mars-Sea/dsh-deeppilot/issues)
- [GitHub Releases](https://github.com/Mars-Sea/dsh-deeppilot/releases)
- [npm package](https://www.npmjs.com/package/dsh-deeppilot)
- [Linux.do 社区](https://linux.do/)

DeepPilot is an independent community project and is not affiliated with or
endorsed by DeepSeek.

## License

MIT — see [LICENSE](./LICENSE).
