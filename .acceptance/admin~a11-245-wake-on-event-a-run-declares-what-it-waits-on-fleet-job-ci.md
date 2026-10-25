Closes A11-245

Step 2 of 2 (agent-org): a worker declares what it waits on, the board reads it and prompts the worker once. A `working` outcome may carry `waitingOn` as a list of `{ fleetJob }`, `{ ciRun }`, `{ pullRequest, until }` and `{ ticket, until }`, with `until` as the deadline. The board reads each event (fleet jobs through `fleet job status <id> --json`, CI runs and pull requests through the code host, tickets through the tracker) at most once a minute while the agent is idle, and prompts the pane ONCE when all have finished or any has failed, with what happened; past `until` it prompts once with the pending items' progress and marks the run Stalled after `tickets.stallMinutes` more. The card reads `Waiting on fleet job fj-1 (4 of 6 pages, about 20 min)`, not Stalled. The stop hook lets a declared `working` stop, and the worker brief says to declare, end the turn and write no wait loop.

Acceptance:

```bash
# rstest needs a fixture project (as CI's suite job lays one) and a writable private-tmp root, so neither depends on the caller's home; both are removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
# pool-wait.test.ts drives the real tick over a fake pane: each kind of event finishing sends exactly one prompt (and a stub `fleet` program answers the real exec seam), a failure's prompt starts with the reason, `until` passing sends one prompt, and the card reads the line above
AGENT_ORG_HOST="$work/project/.agent-org/host.json" A11Y_PRIVATE_TMP_BASE="$work/tmp" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-wait.test.ts src/ticket-mode/wait-on src/ticket-mode/outcome.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts src/install/house-notes.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts
rm -rf "${work:?}"
npm run typecheck
```
