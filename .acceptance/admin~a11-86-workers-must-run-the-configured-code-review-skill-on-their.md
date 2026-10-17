## What it is

Ticket workers were meant to run the pre-PR code-review skill on their diff before opening a pull request, and on 2026-10-17 they did not do it consistently: A11-81 ran it before its PR, A11-74 ran it after opening its PR, and A11-84 never ran it. Nothing in the worker brief or the ticket hook made it a step.

## Change

A new machine setting, `tickets.prReview`, names the skill (such as `a11ign:clean-code-review`). When it is set:

- The worker brief has the worker run that skill on the whole diff after its last commit and before any push or pull request, re-run the repository's checks after each fix, and record the review in a `Pre-PR review:` line of the body. A review round's brief has the same review before its push.
- The ticket hook logs each call of that skill (`review`) and each git commit (`commit`) in `pr-review-log` beside the outcome file, and refuses `gh pr create`, `pr:open create` and `git push` unless the log's last line is `review`. No worker may write the log or the setting's copy, `pr-review.json`.
- `pr:open` in ticket mode refuses a create whose body has no `Pre-PR review:` line naming the skill.

With the setting absent, the brief is byte-identical to today's, the hook logs and refuses nothing on a review, and `pr:open` runs the same report list.

Refs A11-86

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-86/agent-org && npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/pr-open-ticket.test.ts'`
