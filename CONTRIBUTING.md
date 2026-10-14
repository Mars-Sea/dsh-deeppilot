# Contributing

Issues and focused pull requests are welcome. For major behavior or compatibility
changes, discuss the DSH version, user-visible problem, and proposed boundary
in an issue or the existing task first. Small fixes can go directly to a pull
request with the relevant context and validation.

## Local checks

For documentation-only changes, check links, examples, and `git diff --check`.
For TypeScript changes, run tests, typecheck, and build. Run Go tests when the
helper changes. The following is the full release validation checklist; use
`npm ci` when a clean dependency install is needed.

```bash
npm ci
npm test
npm run typecheck
npm run build
cd helper && go test ./...
```

Commit regenerated `lib/` together with source changes; GitHub installs use
the checked-in artifacts without running lifecycle scripts. Do not commit
local tokens, device registries, Tailscale state, Apple credentials, logs, or
captured conversations.

The normative bridge contract is [PROTOCOL.md](./PROTOCOL.md) and its TypeScript
model is `src/protocol.ts`. The private iOS client mirrors that contract.
Protocol changes require an explicit versioning and compatibility review; do
not change wire fields as an incidental refactor.

## npm 可信发布

发布工作流使用 OIDC 身份认证与来源证明（Provenance），仅手动运行。
从已经合入 `main` 的发布提交创建附注版本标签后，在该标签上运行工作流；
不要在默认分支上运行后另行检出标签。完整验证、npm 网站绑定与调度命令见
[npm 可信发布说明](./docs/NPM_PUBLISHING.md)。发布前仍需用户授权具体版本。

## Source layout

The project is one npm package with internal modules grouped by responsibility:

- `src/index.ts` composes plugin lifecycle, settings, WebSocket routing, remote
  access, and push providers.
- `src/config.ts`, `src/phone-http.ts`, and `src/push-policy.ts` own configuration,
  HTTP-upgrade helpers, and push lifecycle decisions.
- `src/connection.ts` owns one authenticated phone connection;
  `src/connection-policy.ts` contains its validation and error policies.
- `src/host-bridge.ts` orchestrates Host streams and protocol fan-out;
  `src/host-api.ts` defines the structural Host API and
  `src/host-event-projection.ts` contains pure wire projections.
- `src/client/index.ts` wires the settings controller; UI, styles, localization,
  and report mounting stay in their focused `src/client/*` modules.

Keep public exports stable when moving code between these modules. A source
split does not create additional npm packages or change the wire contract.

Logs and fixtures must not contain pairing tokens, APNs tokens, private host
names, filesystem paths from real users, or message bodies from real sessions.
