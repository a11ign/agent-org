---
"agent-org": patch
---

Neither arming path re-queues a pull request the merge queue ejected for `failed_checks` while its head is unchanged (a11ign/a11ign#3487; #3460 was ejected four times on 2026-10-04, about seven minutes of CI each, every pass failing the same way). `arm-pr` logs `NOT arming` with the ejection time and exits `DONE`; `auto-arm-sweep` reports `SKIPPED` with the same reason; both ask the one `ejectionVerdict` in `pr-armed-state.mjs`, which reads `queueEjectionOf`. A push to the head, a dequeue for any other reason and a PR with no queue history arm as before. A queue read that is refused arms nothing and is reported as a lookup that failed (`arm-pr` exits `CANNOT_ASK`, the sweep exits `1`), never read as "not ejected".
