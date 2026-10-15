---
"@a11ign/agent-org": patch
---

The host declaration carries `events` (#977, a11ign/a11ign#5043): `source` is `poll` (the default, and today's behaviour) or `webhook`, which names the receiver's `port` (1024-65535), the absolute `secretPath` and the `tunnel` (`cloudflare` or `tailscale`); `reconcileMinutes` is a positive whole number, 20 when a `webhook` host leaves it out. `parseHostConfig` reads and refuses it by field name, and an absent block reads as `{ source: "poll" }`. Nothing consumes the declaration yet.
