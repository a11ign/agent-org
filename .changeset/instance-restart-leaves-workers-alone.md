---
"agent-org": patch
---

Restarting the ticket instance no longer interrupts its workers (A11-78). Under systemd the instance started ticket mode's herdr server inside its own service, so `systemctl --user restart` (which `agent-org update` and the hourly auto-update run) sent SIGTERM to the server and every worker in it; herdr then resumed each worker with "Interrupted · What should Claude do instead?". The server now starts in a scope of its own (`systemd-run --user --scope`), a starting instance answers start dialogs only on runs it started itself, a reviewer is recorded before it starts and adopted when herdr still lists it, and `agent-org update` defers with `deferred: N runs live` (exit 0) while the instance has a live run, unless `--force`.
