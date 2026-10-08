---
"agent-org": minor
---

`node src/trace/triage-sample.mjs --score <predictions.json>` scores a small model's `wake | digest | drop` triage of manager wakes against the 100 hand labels of a11ign/a11ign#4074, frozen in `src/trace/triage-labels-4074.json` (the sampler is never re-run). It prints the confusion by label, the missed wakes (a `wake` the model called `digest` or `drop`) per cause class, every figure with and without the six unreadable rows, and the declared bar per class (at least 5 readable rows and no missed wake: a `candidate`, never proved). `--prompt` prints exactly what the labeller had: the three definitions and the five printed columns. Nothing is routed and no alias or effort changes.
