---
"agent-org": minor
---

The hourly `agent-org update` held every new release back for as long as any run was live, so on a busy host the install never moved (the agents host sat on v0.243.0 while v0.248.0 was out). A live run now holds a release back only while a restart would interrupt a worker: when herdr's server is inside the instance's cgroup (checked from `/proc` and systemd, or the launchd job's process group on macOS) and an agent is mid-tool-call. Otherwise the move goes ahead, and the reason is logged on one line. A hold lasts at most `tickets.updateMaxDeferHours` (2 by default, a whole number of 1 or more) from its first deferral for that release, then the update goes ahead. `--force` is unchanged.

Each run writes `<home>/update-status.json`. `doctor` reads it for a new `update lag` check (how many releases behind the install is, since when, and what it is deferred for; it fails past the defer limit plus an hour) and a new `herdr scope` check, which fails when a herdr server still inside the instance's cgroup would take every worker down with a restart, and prints both fixes.
