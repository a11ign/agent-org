# A11-275, step 1 of 2: the planner moves an impossible Before-merge line, and the reviewer never blocks on one

A Before-merge Done-when line that needs a published release, a person's own machine or anything else a worker cannot reach is moved to After merge before any code is written. The planner brief (single and batch) carries `MOVE_RULE` (`src/ticket-mode/after-merge-move.ts`): the planner lists each such line in a `## Moved to After merge` plan section, with a reason id (`release`, `machine`, `unreachable`) and who runs it. The plan check (`planFiles` in `pool-settle.ts`) refuses a move whose line the ticket does not hold under `### Before merge`, an unknown reason, or a missing or over-long who. At plan attach the board rewrites the ticket from fixed words (`withMoves`): the line goes under `### After merge` with who runs it, and a `## Decisions (the planner, <date>)` entry records the move. The write happens before the plan is stamped, so the stamp holds the rewritten text and the plan is not read as stale; a retried attach writes nothing twice. The atomic reviewer's three prompts carry `IMPOSSIBLE_BEFORE_MERGE_RULE`: treat such a line as After merge, say so, and do not block on it. Step 2 (the `session` wait for an ask only the person's session can do) is a later pull request.

Acceptance:

```bash
# after-merge-move.test.ts: the plan section is read and checked against the ticket; the rewrite moves the line with who runs it, adds the Decisions entry, is idempotent, and reads CRLF and nested bullets
# worker-files.test.ts: both planner briefs carry the rule; prompt.test.ts, port.test.ts: every reviewer prompt carries the reviewer rule
# (the filing check cannot run pool-after-merge-move.test.ts, pool-attach-retry.test.ts, pool.test.ts or pool-answer.test.ts, which CI's suite runs: the ticket rewritten at attach and stamped with the rewritten text, a retried single and batch attach, a line not under Before merge refused)
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/after-merge-move.test.ts src/ticket-mode/worker-files.test.ts plugins/atomic-reviewer/prompt.test.ts plugins/atomic-reviewer/port.test.ts
npm run typecheck
```
