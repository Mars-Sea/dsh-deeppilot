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

The bridge protocol is shared with the private iOS implementation. Protocol
changes require an explicit versioning and compatibility review; do not change
wire fields as an incidental refactor.

Logs and fixtures must not contain pairing tokens, APNs tokens, private host
names, filesystem paths from real users, or message bodies from real sessions.
