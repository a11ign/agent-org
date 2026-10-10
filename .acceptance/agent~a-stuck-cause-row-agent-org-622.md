A stuck-cause row the tick filed (`answer:ceo` + `parked` + `out-of-release`, a11ign#4727) is closed with a comment naming the cause key when its `answer:ceo` is removed, instead of being left open `parked` with no wait (a11ign/agent-org#622). A row that still carries `answer:ceo` is not touched.

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-622 && npx rstest run --config scripts/rstest/rstest.config.* src/stuck-row-answered.test.ts
```

Run in this branch's tree with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`. Printed: `VERDICT pass: 6 tests in 1 file`. The named cases: `an open filed stuck-cause row whose answer:ceo is gone is closed with a comment naming the cause key`, `a row still carrying answer:ceo is not touched`.

Against `HEAD`'s unmodified `src/wake.ts` (swapped in from `git show`, restored from a copy and diffed identical afterwards) the same file prints `VERDICT fail: 3 of 6 tests failed`, the first case among them.

Mutation (each restored from a copy):
- the `issue close` call made unreachable: 2 of 6 red (the closing case and its control in the second).
- the "still carries an `answer:` label" return removed: 2 of 6 red (the untouched case and the re-routed case).
- `closeAnsweredRow` called for a label row too: 1 of 6 red (the label row's case).

Decision the row asks for: **close**, not "keep with `Not-before:`". Closing is what a label row's answer already means (the question is answered, nothing waits), a kept row would need a date nobody has, and `Not-before:` on a row nobody will act on is the same finding one step later.

Premise not held, filed rather than built here: the row says "the existing re-ask (`REASK_AFTER_MS`) files a new row". It does not for a filed row: `reaskCleared` is called only for a label row (`target.row !== null`), and a filed row's key stays in the ledger's `escalated` set, so after the close a still-true cause is silent until its causeKey changes. That is the documented `ALREADY ESCALATED` behaviour and the change leaves it. A re-ask that FILES a new row an hour after the close is a separate row.

Done-when 2 (a live row whose `answer:ceo` is removed closing on the next tick) is read on that row after the release, not by this PR.
