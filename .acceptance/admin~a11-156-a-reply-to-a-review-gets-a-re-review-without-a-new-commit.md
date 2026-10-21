A pull request whose newest review from `a11ign-reviewer` at its head asks for changes, and whose worker (or a person the org declares) has answered it in a comment with no new commit, now gets one re-review of the same head. The pool reads the replies posted after the block (`readReplies`, code host contract 1.2), starts the reviewer again for that head through the same start path (`reviewer.start` with a brief, reviewer contract 1.1; the head's finished claim is no end of a re-review, `claimHead` with `rereview`), records the head in `rereviewed` of `reviewers.json` before the start so it happens once, and the board says `re-review asked by reply at <head>`. The reviewer's prompt carries the replies, the ticket's `## Done-when` section (read from the run that holds the pull request), and the rule that a Done-when line under "After merge" is not a merge condition. The rule and the Done-when are in every ticket-mode reviewer prompt, the first review's and the reprompt's included. No empty commit is needed to get a review.

## Change

- `src/ticket-mode/pool-reviewers.ts`: `rereviewFor` and `repliesAfter`, the shared `startWith` (the first review's `startFor` is now a case of it), the close rule that keeps a re-reviewer until it posts or ends, `PullRead.rereview`, and the `forgetPull` and `releaseReviewers` reach of the new record.
- `src/ticket-mode/reviewer-port.ts`: the `rereviewed` memory (absent in an older file reads as empty), `standingBlock`, `replyAuthorsOf` (the board's own account and `declaredIdentities().exact`, never the reviewer's own).
- `src/ticket-mode/done-when.ts`: the `## Done-when` section of a ticket's description.
- `src/ticket-mode/board-view/pull-review-state.ts`: the board line.
- `plugins/github/replies.ts`, `src/plugins/contracts/code-host.ts` (1.2), the fake and the conformance suite: the reply read.
- `plugins/atomic-reviewer/prompt.ts` and `port.ts`, `src/plugins/contracts/reviewer.ts` (1.1): the prompt words and the claim for a re-review.
- `src/ticket-port/review-claim.ts`: `claimHead` with `rereview` reads only the entries after the newest verdict; an approval is the end of a head.
- `src/work-gate/pr-orders.ts`: `reviewerRoleFile` is exported, so the re-review brief names the file the gate's prompt names.

## Acceptance

Each line of the ticket's Done-when is a named test; the scenario "reply to a not-convinced review, without pushing: the reviewer re-reviews, reads the reply and the ticket's After-merge part, and the approval clears the block" is `pool.test.ts`, "a reply to the reviewer's block with no new commit starts one re-review".

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/done-when.test.ts src/ticket-port/review-claim.test.ts plugins/github/replies.test.ts plugins/github/conformance.test.ts plugins/atomic-reviewer/port.test.ts plugins/atomic-reviewer/prompt.test.ts src/plugins/fakes/code-host.test.ts src/plugins/built-in.test.ts src/plugins/cli.test.ts
npm run typecheck
```

Consumer-declaration: none -- the contract changes are additive minors (code host 1.2 adds `readReplies`, reviewer 1.1 adds an optional `brief`) and the only plugins of those concerns are the bundled ones, changed here. The `plugin` repository's pull request for A11-156 writes the Done-when in two parts, which this pull request's prompt quotes; neither needs the other to merge first.
