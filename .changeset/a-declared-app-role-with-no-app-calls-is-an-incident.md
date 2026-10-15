---
"@a11ign/agent-org": patch
---

A merged `github.identity` switch takes effect on the next tick, and a declared app role that never calls as its app is an incident (agent-org#790, parent a11ign/a11ign#4900). The tick's `host-units.ts --json` read now re-renders `~/.local/bin/gh` alone when the wrapper's identity block (`APP_ROLES` and `app_declared()`) is not the one `host.json` declares, through the same atomic write `host:install` uses: no unit file, no other owned file and no service is touched, and a wrapper that already matches is not written. The new `app-role-silent.ts` returns the roles declared `github-apps` that made calls in the last 10 minutes and none as `app:<role>`; the tick files each once per episode as an `app-role-silent` line in the failure ledger. A role that made no call, and a ledger that cannot be read, are not incidents.
