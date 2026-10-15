---
"@a11ign/agent-org": patch
---

A Ready row whose body declares an open `Waiting-for: merged <ref>` (or `closed <ref>`) is shelved in `blocked`, not offered to the pool (a11ign/agent-org#1075). The gate offered it on every tick and a worker claimed it with nothing to build, until the wait cleared; the shelving reason names the line (`Waiting-for: merged a11ign/agent-org#41 is not true yet`). The condition is read by `wait-condition.ts`'s `conditionHolds` against the facts the gate already reads, and the wait is read once before the decision, so `orgHealthNow` takes the same read. A wait that is unknown (an unreadable line, `manual`, or a reference the facts do not hold) and a tick with no facts are offered as before: a failed read never shelves a row.
