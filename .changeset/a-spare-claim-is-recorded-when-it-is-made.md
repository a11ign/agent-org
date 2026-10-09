---
"agent-org": patch
---

Fix: a spare engineer's claim is recorded in the spare registry when `row-claim` makes it, so a row it claims and then releases (or sees close) before a tick still counts as its one row and a second claim is refused with `one instance, one row` (a11ign/a11ign#4387, after `worker-4069` held #4069 and #4274). The registry was written only by a tick's teardown, so a release in between left no label and no entry. If the registry cannot be read or written the claim still goes through and says so on stderr.
