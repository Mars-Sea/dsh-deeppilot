# Protocol-v2 security status

[简体中文](./SECURITY_ROADMAP.zh-CN.md)

Status: implemented on the development branch. `PROTOCOL.md` is normative. Protocol v1 is not retained; all devices must pair again.

## Implemented

- five-minute, single-use, high-entropy pairing codes;
- P-256 device identities, Secure Enclave on physical iOS devices with a simulator Keychain fallback;
- per-connection nonce/audience/timestamp challenge signatures;
- host-side public-key fingerprints, per-device scopes and immediate revocation;
- anonymous-endpoint rate limits, source blocking, bounded unauthenticated concurrency, and a bounded registry;
- minimal unauthenticated health response; no Bearer or URL credentials;
- privacy-preserving audit identifiers, a global connection switch, and per-device deletion; scopes remain enforced at the protocol layer.

## Remaining release validation

- share fixed canonical/signature vectors between TypeScript and Swift tests;
- exercise pairing, reconnect/resume, and per-device deletion through both real LAN and Funnel paths;
- add abuse tests for malformed requests, connection churn, replay, and many-source pressure;
- document local recovery when `devices-v2.json` is lost;
- decide whether high-impact approval responses should require fresh local biometric/user-presence confirmation;
- keep dependency scanning and CodeQL green, then sign and notarize every distributed helper before claiming production readiness.
