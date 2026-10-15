---
"@a11ign/agent-org": patch
---

The gate's un-park pass (#4050) now also runs over every other declared tracker's open rows, not only the home one, so a row of another tracker that stays parked after its native blockers close (a11ign/agent-org#904, parked ~18h) can be un-parked. Each such row is read with its own repository: its label writes, closed-date reads and comments name that repository, and its `Waiting-for:` lines are checked against that repository's facts rather than the home ones. A non-home row is never promoted by the tick (`row-file --promote` acts only on the home tracker); it is refused with a reason and routed to `backlog` with `answer:product-manager`. The whole other-tracker pass is behind the machinery flag `rows.autoUnpark`, which ships OFF, so nothing changes until it is turned on (a11ign/agent-org#5177).
