---
"agent-org": patch
---

The row the tick files for a stuck cause in a repository whose pull requests are not in the primary's tracker is born in a state the org can count. `fileRepositoryRow` ran `issue create` with `answer:ceo` and nothing else, so each row had no state label, no release declaration and no board item and tripped `row-without-exactly-one-state` and `row-off-board` within 20 minutes (a11ign/a11ign#4350, #4581, #4607, #4716). The create now carries `parked`, `answer:ceo` and `out-of-release`, and the row is added to the primary's Project and set to Backlog as part of filing; a board that refuses is reported in the tick log naming the row filed. The dedupe on the title is unchanged and a duplicate is written nothing. A row whose `answer:ceo` is removed is left open and `parked` with no wait, which is a follow-up. a11ign/a11ign#4727.
