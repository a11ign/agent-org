---
"@a11ign/agent-org": patch
---

The work-tick unit carries `CPUWeight=400`, so on a busy host a tick no longer takes an even share of the CPU with the engineers' builds (agent-org#920). The tick-cost line also records `prestartSteps`: each `ExecStartPre` command and its own wall in ms, read from `systemctl --user --timestamp=us+utc show`, `null` for a step whose start or exit time cannot be read and `null` as a whole off systemd. `prestartMs` is unchanged. The rendered unit's text moved, so `host:check` reports an installed work-tick unit stale until `host:install` runs.
