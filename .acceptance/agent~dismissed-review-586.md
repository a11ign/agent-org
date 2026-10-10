`verdictBearers` (`src/review-verdict.ts`) leaves out a review whose `state` is `DISMISSED`, so `verdictAmong` over a PR whose only review is a dismissed `not-convinced` yields `verdict: null` and `examined: 0`, and the gate's no-verdict path applies. A review with no `state` field still counts, and the same review as `CHANGES_REQUESTED` still yields `not-convinced`.

Acceptance: `node --test src/packaging/review-verdict.test.ts`

Mutation: the `.filter(standing)` removed from `verdictBearers` failed 1 of 22 tests (the dismissed-refusal test, on its `null` assertion); `review-verdict.ts` restored from a copy and the file re-run, 22 pass. The second new test (a newer `convinced` after a dismissed refusal; a stateless review) passes under that mutation by design: it pins that newest-wins and the no-`state` shape are unchanged, not the dismissal.

Measured: `src/packaging/review-verdict.test.ts` 22 pass, 0 fail; `src/packaging/door-refuses-second-review.test.ts` 34 pass; `src/packaging/row-claim-own-pr-health-rule.test.ts` 91 pass (with `AGENT_ORG_HOST` set). `tsc --noEmit` prints nothing naming `review-verdict`; its two errors are in `mjs-ratchet.test.ts` (the toolchain import is unresolved in this worktree).

Not here: the live reading (agent-org#579's gate line stops repeating once the pin carries this) is the row's Done-when 2, read after the release.

Closes a11ign/agent-org#586
