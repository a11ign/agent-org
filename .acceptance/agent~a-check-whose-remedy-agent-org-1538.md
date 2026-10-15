A check whose remedy is a review is no longer routed as a code failure: a failing check that says `Cleared-by: review` in its output summary holds its pull request for a reviewer (`awaiting-review`, a reviewer ordered at the head, no `pr-checks-failing`), and `Cleared-by: human` files the chairman a brief instead of a reviewer order (a11ign/a11ign#5528). A check with no marker, or a red set with one unmarked failing check, is red as before.

The marker is read by `src/work-gate/review-gate.ts` (`clearedByOf`, `checkMarkersOf`: the newest run of each name, whole line only, `review` or `human` only). `withCheckMarkers` (`src/work-gate/causes/pr-reviews.ts`) reads the check runs of each red blocking head and keeps the marker for that head only. `reviewGateOf` (`src/work-gate/pr-orders.ts`) is the one decision: `stallReasonOf`, `failingChecksOrder` and `draftOrder` all ask it. `fileReviewGatedHuman` files the brief, and the `review-gated-unasked` signal (`src/org-health.ts`, read from `reviewGatedFacts` in `src/work-gate/org-health.ts`) reports a review-gated red PR of two hours with no reviewer ordered at its head.

Acceptance:

```bash
git grep -q "(a) a failing check whose remedy is a review" -- src/work-gate/pr-orders.test.ts
git grep -q "(b) a red check with no marker" -- src/work-gate/pr-orders.test.ts
bash -c 'cd ~/repos/wt-agent-org-1538 && node --test src/work-gate/pr-orders.test.ts'
```

Closes a11ign/agent-org#1538

Measured: `node --test src/work-gate/pr-orders.test.ts` prints `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0` at this head. Controls (a)-(e) are the first five tests; (a) is the row's FAILING control. On `main` there is no marker to read, so (a) is red there: the disabled-gate mutation (`reviewGateOf` returns `null`, which is what `main` routes) fails (a), (d) and the detector control, and passes (b), (c), (e). The other mutation (an unmarked failing check counts as cleared) fails (b), (c) and (e), and passes (a) and (d). Each mutation was run and the file restored from a byte-identical copy.

Outside-Region: `src/work-gate.ts` (the call of `fileReviewGatedHuman` and the import), `src/work-gate/tick.ts` (`withCheckMarkers` in the other tick's decide arguments, so an other scope's red PR gets its marker too), `src/work-gate/causes/pr-reviews.ts` (`withCheckMarkers` and `readCheckRunSummaries`), `src/work-gate/org-health.ts` (`reviewGatedFacts` and its facts entry), `src/org-health.ts` (the signal, its reading and REMEDY line). The row's own region is `src/work-gate/pr-orders.ts`, `src/work-gate/pr-orders.test.ts` and `src/org-health.ts`.

Cost: one check-runs REST read per RED blocking pull request per tick (`readCheckRunSummaries`). A green or pending PR costs nothing.

Assumptions, noted in place of questions:
- The paired row a11ign/a11ign#5573 prints `Cleared-by: edit` as its last line; this row names `human`. `edit` names no act the gate knows, so it is no marker and that PR stays red. #5573 must print `human` for a person's act.
- Control (a) marks both `changeset` and `gate`, because the aggregate `gate` check fails when `changeset` does. a11ign#5528 clears only if its `gate` is marked too (or is not blocking).
- Control (d) reads "orders no reviewer" as: no `draft-awaiting-verdict` order. The chairman's brief is a side effect (a label and one comment with a marker), not an order.
- `reviewerOrdered` in the detector matches a reviewer order by subject, not by head.

Not done: the live reading (done-when 2 beyond the test) waits for a real review-gated red PR. The brief is filed only by the main gate's tick (`src/work-gate.ts`); other scopes read the marker but do not file a brief for it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
