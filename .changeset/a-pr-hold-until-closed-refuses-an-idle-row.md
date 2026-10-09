---
"agent-org": patch
---

`pr:hold --until="closed #N"` is refused when #N is open, carries neither `in-progress` nor a `session:` label and has no open pull request closing it: the condition cannot come true while nobody is working the row, so the held pull request would sit green until somebody happens to claim it. The refusal names `--until=manual` as the counted, 4-hour alternative and is made before any label or comment is written. An unreadable target is taken as before (absence is not proof), `manual`, `merged` and the other waits read no row, and a release reads none. `idleHoldIncident` (class `hold-on-idle-row`) reads a hold already in force on such a target as an incident once more than 15 minutes have passed since the later of the hold and the target's last change, with a key stable for the life of the hold; the gate does not call it yet. a11ign/a11ign#4661.
