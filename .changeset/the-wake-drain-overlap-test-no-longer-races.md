---
"agent-org": patch
---

The wake-drain overlap test (#3566 9b) no longer races the scheduler. Its stub `gh` paused 100 ms or 400 ms and the test asserted every read had started before any ended, which failed at host load 24 to 33 when a Node start-up outlasted 100 ms (4 of 6 `verify` runs red on correct code). The stub now answers only after every declared repository's read has stamped its start, and the first repository's read also waits for every other's end, so overlap is a condition the reads must meet rather than a margin; a one-by-one reader runs out a 15 s give-up and fails. Test only: no shipped code changes. a11ign/a11ign#3861.
