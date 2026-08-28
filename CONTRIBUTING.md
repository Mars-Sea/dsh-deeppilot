# Contributing

Issues and focused pull requests are welcome. Before changing behavior, open an
issue describing the DSH version, user-visible problem, and proposed
compatibility boundary.

## Local checks

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
