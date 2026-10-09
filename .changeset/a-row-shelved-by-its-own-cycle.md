---
"agent-org": patch
---

The tick names a row shelved by a pull request that closes a row waiting on it (`src/b4-cycle.ts`, a11ign/a11ign#4625). `blocking-impact: DEADLOCK #4516 is shelved by control#32, which closes #4575, which waits on #4514, which waits on #4516: no tick will clear it` is printed once per such shelving, and that row is counted out of the `nobody is known to hold` line instead of being printed there as well. The detector reads only what the gate already read (the open pull requests' `Closes` and the open rows' `blockedBy` edges, closed blockers ignored), through `resolverOf`'s new `waits`; no new call.
