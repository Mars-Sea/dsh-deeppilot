# Recovering from a lost device registry

[简体中文](./DEVICE_REGISTRY_RECOVERY.zh-CN.md)

The computer keeps the list of paired phones in
`$DSH_HOME/deeppilot/devices-v2.json` (`~/.dsh/deeppilot/devices-v2.json` when
`DSH_HOME` is unset). It holds each phone's **public** key, scopes, display
name, notification preferences and push registrations. The matching private key
never leaves the phone (Secure Enclave on a physical iPhone), so this file is the
only thing that makes a paired phone recognisable. If it is gone, no phone can
prove who it is, and the only way back is to pair again.

## What you will see

| Situation | Host | Phone |
| --- | --- | --- |
| File deleted, or the data directory is new | Starts with no devices and logs no error: a missing file is indistinguishable from a first run. The start-up line `device registry loaded from ...: 0 device(s), 0 push registration(s)` is the tell. | Every phone is refused with close code `4401` and shows "pairing is no longer valid". |
| File unreadable (truncated, disk error) | Logs `[deeppilot] device registry unreadable, starting empty: ...` at start-up, then reports `0 device(s)` and behaves as above. | Same. |
| A single device deleted in the settings page | That one device is refused; others are unaffected. | Same message on that phone only. |

The phone cannot tell these cases apart: `4401` is also what a revoked device
gets. If every phone fails at once, suspect the registry; if one fails, suspect
revocation.

## Before you touch anything

1. **Stop DeepSeek Harness first.** The plugin reads the registry once at start-up
   and rewrites it from memory afterwards, so an edit made while it runs is
   overwritten.
2. **Copy the damaged file aside** (`cp devices-v2.json devices-v2.json.bad`) if
   it exists. The first successful pairing writes a fresh registry over it, and
   a truncated file may still contain recoverable entries.
3. **Never delete `host-id`.** It is the stable Host identity (`audience`) that
   every phone has stored. A new `host-id` invalidates every pairing even if the
   registry is restored. If `host-id` itself is malformed the plugin refuses to
   start; restore it from a backup rather than deleting it.

## Recovery

### A. You have a backup of `devices-v2.json`

The file is replaced atomically (written to a temporary file, then renamed), so
a copy taken at any moment is a consistent snapshot.

1. Stop DeepSeek Harness.
2. Put the backup at `$DSH_HOME/deeppilot/devices-v2.json` with mode `0600`.
3. Start DeepSeek Harness. The start-up log reports how many devices and push
   registrations were loaded.
4. Bring the app to the foreground on each phone (or use its retry action). A phone that was refused with `4401` stops retrying by itself, so it reconnects when you reopen the app, not the moment the Host comes back. No re-pairing is needed.

Anything changed after the backup was taken (devices paired, renamed or deleted)
is rolled back with it. A device you deleted after the backup works again, so
delete it once more.

### B. No usable backup

Every phone has to pair again.

1. Start DeepSeek Harness and open the DeepPilot plugin settings page.
2. Show the pairing QR code (or the copyable pairing text). A code is valid for five minutes and works once.
3. On each phone, open the host in the app's settings, choose edit, and scan the
   new QR code (or paste the pairing text). If that does not take, remove the host
   in the app and add it again.
4. Remove stale entries from the settings page if the old registry was partly
   recovered.

What is reset: custom device names, per-device notification preferences and
scopes (back to the defaults). Push registrations and Live Activity tokens come
back by themselves, because the app registers them on every connection.

Conversations, projects and models are untouched; they belong to DeepSeek
Harness, not to this plugin.

## Related files that also force re-pairing

| File or directory | If lost |
| --- | --- |
| `host-id` | New audience: every phone must pair again. |
| `lan-tls/` | New certificate key: phones paired over the LAN reject the host until re-paired (Funnel pairings are unaffected). |
| `tailscale/` | Funnel's Tailscale node state. Expect a new node and a fresh Funnel authorisation; LAN pairings are unaffected. |

## Keeping a backup

Copy `devices-v2.json` and `host-id` together to somewhere outside `DSH_HOME`
whenever you pair or delete a device. Treat the copy like any file that grants
access to your sessions: it lists the keys allowed to connect, though it cannot
be used to impersonate a phone.
