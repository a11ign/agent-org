---
"@a11ign/agent-org": patch
---

`host:check` no longer reports a program that is there as PROGRAM MISSING when its `ExecStart` names the program under `%h`. systemd expands `%h` (and `$HOME`) to the home before anything runs, and `programCandidates` now does the same before resolving the path, so `%h/repos/control/src/fleet-watch.ts` is read as `<home>/repos/control/src/fleet-watch.ts` and not as a directory under the unit's `WorkingDirectory` (agent-org#1112). A missing program is still reported, against the home.
