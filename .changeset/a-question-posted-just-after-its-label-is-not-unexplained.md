---
"agent-org": patch
---

An `answer:<session>` label is called unexplained (`answer-label-unexplained`) only once it has stood `ANSWER_LABEL_GRACE_MS` (5 minutes) with no comment after it (a11ign/a11ign#3618). A session that labels first and comments second was ordered to "post the question" while it was typing it: on #3566 the label was set 06:32:28Z, the order to the labeller went out 06:34:23Z and the question was posted 06:34:30Z, and the same race hit `worker-3543` and `worker-3573`. `bareAnswerLabel` takes the caller's clock (`nowMs`, default `Date.now()`) and returns `null` for a younger label; `bareAnswerLabelOrders` passes the gate's own. A label past the window with no comment is called exactly as before, and a comment at or after the label still answers it.
