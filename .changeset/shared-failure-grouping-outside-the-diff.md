---
"@a11ign/agent-org": patch
---

The gate's shared-failure grouping (a11ign/a11ign#5008) no longer files an incident for two pull requests whose failures are not the same failure, and no longer holds a red PR's wake past the incident (a11ign/a11ign#5098). It
matched on the `gate` roll-up job's own line, which is red whenever any job is, and on the first `WARN` line of a `checks` log, which is the same on every PR; eight false incidents held control#53's worker for two hours.
Now: the roll-up is never read; a `WARN` line, an echoed command and the exit code are not the failure (a test runner's `FAIL <file> > <test>` line is); and a non-setup failure is shared only when both PRs fail in one
file that neither changes nor tests (setup and install steps are still shared on a match). A hold is a reading of its incident row: a CLOSED row releases its holds on the next tick and its signature is not filed
again for 24 hours unless a PR the row never named joins, and an OPEN row holds for 15 minutes and past that only while it is claimed (`in-progress`). A released order carries the failing job's own line. A hold whose
row could not be filed is released rather than kept.
