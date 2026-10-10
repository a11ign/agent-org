---
"agent-org": minor
---

`node src/trace/triage-jev.ts --out <predictions.json> [--threshold <0..1>]` scores Jev on the frozen #4074 sheet (`src/trace/triage-labels-4074.json`) and writes the predictions file `triage-sample.ts --score` reads, with each row's confidence and the label Jev gave kept beside the label written. a11ign/a11ign#4187 Change 4: the reading `ceo` took by hand is now repeatable in minutes. Every request goes through the triage seam (`askProvider`, the one Jev client in the tool); `state` is the row's printed columns and the one `choice` question's `criteria` are the fixture's three label definitions. A row under the confidence (default the host's `triage.minConfidence`, 0.9), a row Jev did not answer, and a row with no `cause` (which is not asked) are written `wake`. At most 10 requests are in flight, the key is never printed, and the run prints requests and the API's own token usage beside the score. Nothing is routed and no host declaration changes.
