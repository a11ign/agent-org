---
"agent-org": patch
---

The work gate's closed `answer:` read (the biggest `repository.issues` caller, about 61% of a tick's issue points, measured on a stubbed gate run) costs far fewer GraphQL points. It no longer asks for the label of a session that has ended (absent from herdr and recorded ended, `engineers` never): that label is taken off every row afterwards, so its alias, one point per label per kind, bought nothing. And while the labels asked for are the same, the result is kept for 5 minutes (`KEPT_ANSWERS_MAX_AGE_MS`, in the gate's `kept-reads.json`) instead of being read every 2-minute tick; a refused read is never kept and a read with no REST-conditional state (a test, the first-wave rehearsal) keeps nothing. A closed row that owes an answer is therefore noticed up to 5 minutes later. `TICK_POINTS_CAP` is unchanged.
