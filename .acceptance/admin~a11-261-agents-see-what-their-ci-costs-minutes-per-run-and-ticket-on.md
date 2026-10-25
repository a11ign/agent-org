# A11-261, step 1 of 3: the push-once rule and the reviewer's finding

Every worker brief (`briefText`) and the shipped worker house notes (`WORKER_NOTES`) carry `PUSH_ONCE_RULE` (`src/ticket-mode/ci-spend/rules.ts`), and the atomic reviewer's prompt (first review, reprompt and re-review) carries `CI_COST_RULE` (`plugins/atomic-reviewer/ci-rule.ts`). Steps 2 and 3 (the board reads CI spend, the budget; the amber card line) are later pull requests.

Acceptance:

```bash
# rules.test.ts: the rule's content; the brief carries it in step 3 ("Work, commit and push only inside those worktrees"); the shipped WORKER_NOTES carry it
# ci-rule.test.ts: the finding's content; a first review, a reprompt (with or without a brief) and a re-review all carry it
# prompt.test.ts, port.test.ts: the prompts that were pinned word for word now include the rule
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ci-spend/rules.test.ts plugins/atomic-reviewer/ci-rule.test.ts plugins/atomic-reviewer/prompt.test.ts plugins/atomic-reviewer/port.test.ts src/install/house-notes.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/worker-files-decisions.test.ts
npm run typecheck
```
