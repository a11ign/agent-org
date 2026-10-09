---
"agent-org": minor
---

The host declaration (`host.json`) gains an optional `triage` key: `{ "provider": "jev" | "none", "keyPath": "<absolute path>", "minConfidence": 0..1 }`. Absent, `"none"`, or a `jev` provider whose key file cannot be read all behave exactly as before (every order wakes; the unreadable key is recorded as one `triage-unavailable` line per process). `src/triage-provider.mjs` adds `triageOrder`, which returns a route (`wake`, `digest` or `drop`) as data and routes nothing itself. `provider: "haiku"`, any other provider, a `minConfidence` outside 0..1 and a `keyPath` that is not an absolute path are refused by name.
