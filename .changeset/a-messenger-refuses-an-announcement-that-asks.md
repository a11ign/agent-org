---
"@a11ign/agent-org": patch
---

An announcement that asks the chairman something can now be refused before any send, behind the machinery flag `messaging.refuseAskingAnnouncements` (OFF; agent-org#1222, a11ign/a11ign#5112). With the flag ON, `deliver()` refuses an `announcement` whose text ends a line in `?`, or carries a request marker (`needs:chairman`, `answer:`) or the word "reply", outside a `release:` key. The refusal names the remedy (put the ask on a row with `needs:chairman` and a BRIEF, #3409), is written to the ledger as `invalid` with `misuse: announcement-question`, and is recorded once in the failure ledger under `messaging-audience-misuse`. Nothing reaches the provider. The predicate is the audit's own `asksSomething`, so the guard and the audit cannot disagree. With the flag OFF, which is the default, nothing changes.
