---
"agent-org": patch
---

The failure ledger records an UNANSWERED claimed-worker nudge, not every nudge. `stalledNudgeEvents` appended one `claimed-worker-stalled` line per FRESH nudge and `repeatsIn` counts two distinct refs under a class as a repeat, so the guard repeated its own class every time it worked: four nudges on four rows on 2026-10-10, each answered within minutes, tripped `class-repeat`. The line is now written by the release that follows a nudge nothing answered (`release` with `why: "stalled"` and a `nudgedAt`), its ref still `<session>/#<row>/<nudge time>`, the nudge's own time and so the wake ledger's key. A fresh nudge stays recorded in the wake ledger (`<session>/claim-stalled/row-<n>/nudge-<ms>`) and is no ledger event. A holder that is never released (a `Claimed-nothing:` claim, one with an open pull request of its own) reads `nudged` for good and so leaves no line. a11ign/a11ign#4826.
