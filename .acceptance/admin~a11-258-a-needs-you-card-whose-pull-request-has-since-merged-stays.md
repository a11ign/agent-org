Refs A11-258

Step 1 of 2 (agent-org): a run that ended `needs-human` and whose pull request then merged lets go of its parked workspace in the tracker refresh. The same sweep then queues the next plan step on a `Partial: step N of M` merge, or completes the ticket on a `Closes` merge, and the card reads `the blocker cleared: a11ign/agent-org #1885 merged` (with `; step 2 of 2 queued` for the next step). A `needs-human` that names a pull request of the ticket in its reason and holds none takes the same path once that pull request, read open, merges. A `needs-human` about something unrelated to a pull request is left parked and asking. Partial: step 1 of 2; step 2 clears the same needs-human when its review is dismissed or approved and the pull request is mergeable, with the pull request still open.

Acceptance:

```bash
# rstest needs a fixture project (as CI's suite job lays one), so it does not depend on the caller's home; it is removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
# pool-blocker-cleared.test.ts drives the real refresh over a parked needs-human run: Partial queues the next step, Closes completes the ticket, a named pull request is adopted, an unrelated needs-human is left alone, a refused close is retried
AGENT_ORG_HOST="$work/project/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-blocker-cleared.test.ts src/ticket-mode/board-view/blocker-cleared.test.ts src/ticket-mode/plan-steps.test.ts src/ticket-mode/partial-merge-reopen.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts
rm -rf "${work:?}"
npm run typecheck
```
