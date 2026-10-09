Every writer of `answer:<session>` asks `answerLabelRefusal({ state, lastComment, session })` first: a closed row, a row whose newest comment asks that session nothing, a row already labelled since its newest comment, and a row that could not be read are said on the log and not labelled (a11ign/a11ign#4679). The one writer is `readProseAndOrder` in `src/work-gate/org-health.ts` (#4250).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.* src/answer-label-guard.test.ts
npx rstest run --config scripts/rstest/rstest.config.* src/work-gate/org-health.test.ts
```

The row's commands are these with `cd ~/repos/agent-org &&` in front; the primary checkout carries the new files only after the merge, so they are run in the PR's own tree, with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json` (this worktree is inside no project, and every test that imports `org-health.ts` refuses without it, `board-truth-audit.test.ts` included). Printed:
```
VERDICT pass: 10 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
VERDICT pass: 3 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
```

Mutation (each applied with a script, run against both test files, restored from a copy and `diff`ed identical; never `git checkout --`). Failures are of the 13 tests in the two files:
  - the guard never refuses: 11 fail; the two that pass are the allowed-case controls.
  - the guard always refuses: 12 fail, including every allowed-case control but the one that asserts nothing is labelled.
  - the writer does not ask the guard (`if (false && refusal !== null)`): all 3 `org-health.test.ts` tests fail, and no guard test.
  - the replay clause removed: 2 fail (the guard's "already labelled" test and the writer's replayed-question case), and no other.

Suite: the whole `agent-org` suite with `AGENT_ORG_HOST` set, run from the JSON reports' failing test names. On this branch 46 test names fail; with `origin/main`'s `org-health.ts` in its place 50 fail. The 46 are in both (they fail on `origin/main` in this environment too, `board-truth-audit.test.ts` among them); the 4 only on the base are this row's own `org-health.test.ts` tests, red against the old writer as they should be. `pnpm run typecheck`: 2 errors, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable here), none in a touched file.

Decisions, because the row did not fix them:
- **The route is the comment's AUTHOR, not the handoff's target** (`authorSessionOf`): the label wakes the session that wrote the sentence, and the guard asks whether the newest comment asks THAT session something. With the guard the writer fires only for an open row whose newest comment is a question naming its author, which is the row's rule; whether #4250's order should instead carry its own explanatory comment is `product-manager`'s.
- The row's state and newest comment are read at the writer, by two REST calls per row about to be labelled (the issue, then the comments page holding the last one); an unreadable row is refused, never allowed.
- The replay is stopped by the `labeled` events `readProseFacts` already reads: an `answer:<session>` label given at or after the newest comment's time is not given again.
- `src/packaging/prose-flag-sends-an-order.test.ts` (#4250) changed with the writer: it pinned the labelling of a reading that asks nothing, which is the defect. Its fixtures now end in a question and its fake `gh` answers the row's state and newest comment; two cases are added (closed row, plain report).
