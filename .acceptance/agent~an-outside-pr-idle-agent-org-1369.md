Refs #1369: prs.ownerRouting -- an OUTSIDE pull request idle for 7 days files exactly one triage row and wakes no session (the flag is OFF by default).

Flag: prs.ownerRouting
Health-signals: wakes-held, blind-ticks
Revert: turn the flag off (`machinery:flag off prs.ownerRouting --session=<you>`), or revert this PR. With the flag off nothing is filed and `gh` is not called.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/outside-pr-idle-triage.test.ts` (11 tests pass; typecheck clean; `src/packaging/gh-call-ratchet.test.ts` and `src/ticket-port/ticket-port.test.ts` pass). Run from the worktree.

Open-check: `git grep -n 'OUTSIDE_IDLE_MS = ' origin/main -- src/work-gate/pr-orders.ts` gives 0 lines before this PR and 1 after.

What changed: `fileOutsideIdleTriage` in `src/work-gate/pr-orders.ts` files one row per OUTSIDE pull request whose `updatedAt` is 7 days or more old, labelled `outside-pr-idle`, boarded in the Backlog, and says in its body that it woke no session. The marker in the body (`<!-- outside-pr-idle:<ref>@<updatedAt> -->`) keys the idle EPISODE, so a second tick finds the row (open or closed) and files nothing. A read that refuses files nothing and retries next tick. `work-gate.ts` `main` calls it once, after the refusal exit, with `prOwnerRoutingFlagOn()`.

The tracker writes go through the ticket port, not `pr-orders.ts`: the row is filed by `createRow` (`src/ticket-port/approved-unqueued-reads.ts`), and its label and Backlog board move are `ensureTriageLabel` and `boardTriageRow` in `src/ticket-port/outside-idle-writes.ts`. So `pr-orders.ts` names no `gh` call, and `gh-call-ratchet.test.ts` and `ticket-port.test.ts` pass with this change.

Mutations, each restored afterwards (checked with `cp` and `diff`):
- Filing at most one row per tick (`count++; break;`): 2 of 11 red (the two-pull-request test; and the wakes-no-session test, because the `break` skips the board call).
- Ignoring the flag (`if (!enabled)` made false): 1 red (flag OFF files nothing).
- Ignoring the marker (`if (filed.some(...)) continue` made false): 2 red (second tick files none; a closed row still counts as filed).
- Before the change: the test file does not load, because the names it imports are not exported.

Open, not in this PR:
- The wiring is one line in `work-gate.ts` `main`, outside the row's Region (`pr-orders.ts` and its test). It is named here so the reviewer can see it.
- A board refusal is logged and the row stays unboarded; unlike `ci-failure-class`, the next tick does not heal it.
- An idle pull request whose author is a declared identity (chairman or worker) is not filed: the row says OUTSIDE only.
- Any touch starts a new episode, so a pull request that goes idle again after a touch gets a second row.
- The default reader (`readRowsByLabel`) is not exercised by the tests, which inject the rows; they need `gh`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
