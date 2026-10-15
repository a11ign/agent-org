---
"@a11ign/agent-org": patch
---

The tick reads each tracker's `in-progress` rows once, not once per live spare (a11ign#4148 residual, a11ign/agent-org#942). `tearDownSpares` asked the held-rows read for every spare, so a tick with twelve spares on one tracker read the same list twelve times. The read is memoised per tick and tracker: each spare takes its own rows from its `session:` label in that one list. A failed read is remembered for the tick and is each spare's answer on that tracker, with its cause, and is not asked again.
