---
"agent-org": patch
---

A code-only scope no longer runs the tracker readings against the primary's tracker (a11ign/a11ign#3493). `scopeTick` gave such a scope `[]` for every tracker lane but still ran `readings.tracker` inside `inRepo(undefined)`, which is the ambient repository, so one closed row owing an answer became one `answer-owed` order per code scope, three of them telling the session to put `--repo <scope>` on a row that does not exist there. A scope whose `tracker` is `null` now reads nothing from a tracker (the shapes an empty tracker returns), and the primary and a keyed scope with its own tracker are unchanged.
