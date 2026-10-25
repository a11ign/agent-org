Closes A11-258

Step 2 of 2 (agent-org): a run that ended `needs-human` because a pull request had requested changes reads cleared once that review is dismissed or approved at the head the run ended at and every open pull request reads mergeable, with the pull request still open. The end of the run records which open pull requests were changes requested (`outcomeBlocks`); the watch records `mergeable` in `pullHeads`. `pullAnswer` gains `cleared`, so the run reads Awaiting review with `the blocker cleared: the requested changes on a11ign/agent-org #1885 were lifted` and its question one click away. Step 1 (merged) already releases the run when the pull request merges: with `Partial:` the next step is queued, with `Closes` the ticket is completed. A needs-human not blocked on a requested change at its end, an unmergeable or `UNKNOWN` pull request, and an unread one clear nothing.

Acceptance:

```bash
# rstest needs a fixture project (as CI's suite job lays one), so it does not depend on the caller's home; it is removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
# pull-answer.test.ts and pool.test.ts (A11-258) drive the lifted-review clear; pool-blocker-cleared.test.ts drives the real refresh over a parked needs-human run: Partial queues the next step, Closes completes the ticket, a named pull request is adopted, an unrelated needs-human is left alone, a refused close is retried
AGENT_ORG_HOST="$work/project/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-blocker-cleared.test.ts src/ticket-mode/board-view/blocker-cleared.test.ts src/ticket-mode/plan-steps.test.ts src/ticket-mode/partial-merge-reopen.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view/pull-answer.test.ts src/ticket-mode/pool.test.ts
rm -rf "${work:?}"
npm run typecheck
```
