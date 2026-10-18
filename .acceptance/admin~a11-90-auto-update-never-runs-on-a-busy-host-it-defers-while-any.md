## What it is

The hourly `agent-org update` held every new release back while any run was live, so on a busy host the install never moved: the agents host sat on v0.243.0 while v0.248.0 (with `tickets.serve`) was out, and A11-88's worker stopped for an install that was too old. Since #1731 herdr runs in its own scope, so a restart of the instance no longer interrupts a worker there, and the hold is stricter than it needs to be. A live run now holds a release back only while a restart would interrupt a worker, and only for `tickets.updateMaxDeferHours` (2 by default) from the first deferral.

## Change

- `update-safety.ts` (new, pure, every host read injected): `herdrIsolation` says whether herdr's server of the tickets session is outside the instance's cgroup (Linux, from `/proc` and `systemctl --user show -p ControlGroup`) or outside the instance job's process group (macOS, from `ps` and `launchctl`), and `unknown` when it cannot be read. `midToolCall` says whether an agent is `working`, a start is in flight, or a listing cannot be read. `restartDecision` goes when herdr is outside, or when no agent is mid-tool-call, and otherwise defers up to the limit. It also reads and writes `update-status.json`.
- `update.ts`: with a live run, it first asks whether anything is newer (the same fetch `updateTool` makes); when nothing is, it records the install as current and says nothing about deferring. A deferral is logged with its reason and the time it gives up; a go is logged with its reason. `--force` is unchanged.
- `doctor.ts`: `update lag` (releases behind, since when, the deferral; fails past the limit plus an hour) and `herdr scope` (a server still inside the instance's cgroup fails with both fixes; checked only when the instance is registered).
- `settings.ts`: `tickets.updateMaxDeferHours`, a whole number of 1 or more, refused by name otherwise.
- `pool.ts`: a header comment only, saying the new rule.

## Verified

- `update-safety.test.ts` (new): herdr in the instance's cgroup, a child of it, a sibling `agent-org-instance.service.d`, its own scope, no server, a process table or cgroup that cannot be read, and macOS process groups; the server match; the mid-tool-call rule (working, starting, publish starting, unreadable listing, idle, running); the restart decision (outside, idle, first deferral, the limit, one second short, unknown isolation); the status file round trip.
- `update.test.ts`: the restart-safe path with herdr outside (applied, instance restarted, reason logged), with every agent idle (applied); the deferral (not moved, nothing restarted, deferral recorded with its start and give-up time); a deferral kept across runs; the max-defer path (applied at the limit, one second short still waits); an unreadable listing and an unknown isolation defer, an unknown isolation with every agent idle does not; at the newest release, no deferral line and the deferral cleared; `--force` asks nothing.
- `doctor.test.ts`: the update lag line (behind by N releases and since when, deferred since, up to date, not a release, no status, the failure past the grace, a timer that never deferred); the herdr scope check (inside with both fixes, the launchd fix without KillMode, outside, unknown, and not asked when the instance is not registered).
- `settings.test.ts`: the default 2, 1 and 24 accepted, 0, 1.5, "2" and null refused by name.
- Not verified here: a real herdr server inside a real cgroup. The isolation reads are injected in the tests.

Refs A11-90

Flag: none. The new rule applies on every host that runs the hourly update; `tickets.updateMaxDeferHours` is the one knob.
Revert: revert this PR. The hourly update then holds every release while any run is live again, as before.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/update-safety.test.ts src/install/update.test.ts src/install/doctor.test.ts src/ticket-mode/settings.test.ts
```

Consumer-declaration: none -- the hourly update's hold and the doctor checks; no command, flag or file a host declares changes, and `tickets.updateMaxDeferHours` is optional.
