# Privacy and data flow

DeepPilot is designed around a direct connection to the DSH Host controlled by
the user. The plugin does not upload complete conversations to a DeepPilot
application server.

## Data stored on the Mac

By default, runtime state is stored under `$DSH_HOME/deeppilot/`:

- `auth-token`: the pairing bearer token, mode `0600`;
- `devices.json`: paired-device identifiers, names, app versions, last-seen
  timestamps, notification preferences, and APNs registrations;
- `tailscale/`: local state for the optional embedded `tsnet` node.

The pairing token and full APNs tokens are not rendered in routine logs. The
settings report exposes only token readiness and masked/fingerprint values
needed for diagnostics.

## Direct session connection

Projects, session lists, conversation history, prompts, streaming events,
approvals, questions, and model changes travel over the authenticated
connection between the iPhone and the user's DSH Host.

- In LAN mode this is direct HTTP/WebSocket traffic and is not encrypted by the
  plugin. Use a trusted network.
- In Funnel mode the phone uses HTTPS/WSS through Tailscale Funnel. The helper
  forwards only `/phone` and `/phone/health` to the local DSH origin.

## Optional offline push

Offline push is optional.

### Direct APNs mode

When `provider: apns` is configured, the user's Mac sends the APNs device token
and notification payload directly to Apple. The user supplies and controls the
Apple provider credentials.

### DeepPilot relay mode

When `provider: relay` is active, the plugin sends the following over HTTPS to
the configured relay:

- a per-bridge relay authorization token;
- target APNs device token and sandbox/production environment;
- notification identifier, category, session identifier, title, and a short,
  truncated notification body.

The body may contain a short assistant reply, session title, approval summary,
or question text. The relay does not receive complete history, attachments,
live token streams, prompts that are unrelated to the notification, the local
pairing token, or the Tailscale node state.

Apple receives the normal APNs alert payload in both modes. Users who do not
want this disclosure can disable offline push; live WebSocket operation remains
available.

## Logs

Routine logs contain lifecycle state, delivery outcomes, and masked token
prefixes. They are designed not to contain pairing tokens or message bodies.
Frame-level diagnostics are emitted only when `debug` is enabled.
