---
"agent-org": patch
---

The tick's `N order(s) had nowhere to go` summary no longer counts a Ready row that is only waiting for a free engineer seat (a11ign/a11ign#3266). A `ready-row-unclaimed` offer refused because every seat in the roster is `working` or holds its one row (#2407), with or without the `MAX_SPAWNS_PER_TICK` tail, is written `DEFERRED ... (waiting <m> min; retried next tick)` and does not make the tick exit 1, as a seat mid-turn already was (#3029). Past `CAPACITY_WAIT_LIMIT_MS` (30 minutes, sized from the 67 capacity waits of 2026-10-01 to 2026-10-03 that ended in a claim: longest 13) it is `UNDELIVERED` with its age. A roster with an idle, drained, B2-skipped, `unknown`, `absent` or `blocked` seat, or a `; no spawn:` fault, is still `UNDELIVERED`, and `org-retro`'s idle-minutes figure counts both forms.
