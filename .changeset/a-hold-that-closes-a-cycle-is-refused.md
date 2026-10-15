"agent-org": patch
---

`pr:hold --until="closed #N"` is refused before any write when the held pull request and the target wait on each other: the target, or the open pull request that closes it, waits `merged <held>`, or waits `closed <row>` on a row the held pull request closes. agent-org#1365 held `closed #1325` while #1378, which closes #1325, waited `merged #1365`, and neither could move until a person noticed; no tick names a cycle. `holdCycleOf` (`hold-cycle.ts`) reads the one-hop shape over the parties the take already reads, and the refusal names the cycle and points at `--until=manual` and orchestrator. An edge that cannot be read is absent, with a NOTE, so the hold is taken as asked, as the idle-target rule does. a11ign/agent-org#1396.
