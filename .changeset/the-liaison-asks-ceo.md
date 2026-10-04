---
"agent-org": minor
---

The liaison can ask `ceo` for a ruling through `chairman:ask-ceo --row=N --message=<ref>` (the question on stdin), and a question that names nothing that clears it is refused (a11ign/a11ign#3490, split from #3417). It is `prompt:session ceo --needs-decision` with two refusals in front, both before anything is queued: a `--message` ref the ledger does not hold, and a question with no `Waiting-for:` line the gate's own parser (`parseWaits`) reads as a condition on a row (`Waiting-for: unlabelled answer:ceo #3490` passes; `soon`, `manual`, a bare `#3490` and a line inside a code fence do not). The target is the constant `ceo`, with no argument that names another session; `prompt:session`'s exit 2 is reported as queued and not retried; the verb set of `chairman:correct` is unchanged. `docs/messaging.md` says what the predicate is and why.
