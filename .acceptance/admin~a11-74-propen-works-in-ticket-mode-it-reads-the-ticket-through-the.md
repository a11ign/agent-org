## What it is

`pr:open` refused every pull request a ticket-mode worker opened. It reads the row a pull request's `Closes #N` names, its Region, its claim and its owner from GitHub and the gate, and a ticket has none of those, so A11-31's worker could not open its PR on 2026-10-17. The worker brief then told workers to use `gh pr create` and not `pr:open`, which skipped every check.

## Change

In a ticket-mode run (`AGENT_ORG_TICKET` set), `pr:open` reads the ticket through ticket mode's tracker (`TicketSource`) before it checks anything, and makes the checks a row's pull request gets, for the ticket: the Region read from the ticket's description and its plan files, the body's `Refs <KEY>` or `Closes <KEY>` in place of `Closes #N`, the owner (the run's own worktree on the run's own branch), the draft policy from the machine's `tickets.drafts` ready mark, and a changeset where the repository has `.changeset/config.json`. Nothing is armed or labelled. An unreadable ticket refuses the create. The worker brief names `pr:open` for both values of `tickets.drafts`, and both planner briefs ask for a `## Region` section. With `AGENT_ORG_TICKET` unset, `pr:open` runs the row's checks exactly as before.

Tests pin a ticket-mode create being sent once with its checks printed and nothing armed or labelled; a path outside the Region being refused, cleared by an em-dash `Outside-Region:` line and not by a hyphen; a Region entry keyed to another repository covering nothing here; `Closes: none`, another ticket's `Closes`, a body with no ticket, and a branch that is not the run's each being refused; both values of the drafts setting; the changeset check; an unreadable ticket refusing; the host file named by `AGENT_ORG_TICKET_HOST` being the one read; and a GitHub-row create still reading its row, arming and labelling.

Refs A11-74

Flag: none -- the new checks run only when `AGENT_ORG_TICKET` is set, which only the pool's ticket-mode workers are; a row's create takes the path it took before, and a control test pins it.
Health-signals: ownerless-pr-unreached
Revert: revert this PR; a ticket-mode create goes back to being refused by `pr:open`, and its worker brief back to `gh pr create`.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-74/agent-org && npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pr-open-ticket.test.ts src/pr-open*.test.ts src/engineer-brief-pr-open.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/hook.test.ts'`

Mutation: each claim was broken on purpose, and the ticket tests were run after each break, then the file was restored byte for byte. Arming a ticket create (`arm: true`) turns 1 of 16 tests red (the one-create test). Making the drafts policy ignore the ready mark turns 8 red. Dropping the Region check turns 4 red. Leaving the row's `closes` report in place for a ticket turns 7 red. A changeset check that never refuses turns 2 red. Accepting an unreadable ticket in the CLI, so it returns 0, turns 1 red (the CLI refusal test, added after the first run passed this break).
