Refs A11-272

Step 1 of 3. A run whose worker declares a `ticket` wait on a ticket that is not done gives up its slot and its files. The board records that ticket as a blocker in the tracker, closes the run's workspace and queues the ticket behind it with its Claude session. The run is held until the ticket is done, then resumes that session. A run never holds its files against a ticket it waits on, directly or through the tickets those wait on. A fleet job or CI run names no ticket, so a run parked on one still holds its files against the others.

Acceptance:

```bash
# rstest needs a fixture project (as CI's suite job lays one) and a writable private-tmp root, so neither depends on the caller's home; both are removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
# The A11-231/A11-229 shape through the board's tick (pool-ticket-wait.test.ts): the deadlock reproduced; the parked run released (tracker blocker, workspace closed, queued with its session) and NBF-2 started on the files; the resume on its own session once NBF-2 is completed; a tracker with no addBlockers still holding it; a workspace herdr will not close left running; a ticket already done woken as before.
# The pure pieces: the re-queue and its hold (never stacked, held by the stop's record until the tracker lists it, let go on completed or canceled and not on a merge that leaves the ticket open, read at most once a minute); the waits graph; the overlap exemption for ticket, pull request and transitive waits, while a fleet job, a CI run, a woken holder and a done blocker still hold, and a planner's claims are unchanged.
# Kept: the update drain's stop and resume, which shares the re-queue body; the pool's tick (pool.test.ts, which leaves nothing in its TMPDIR).
AGENT_ORG_HOST="$work/project/.agent-org/host.json" A11Y_PRIVATE_TMP_BASE="$work/tmp" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-ticket-wait.test.ts src/ticket-mode/pool-wait.test.ts src/ticket-mode/queue/queue-blocker-wait.test.ts src/ticket-mode/board-view/waits-on.test.ts src/ticket-mode/overlap-hold.test.ts src/ticket-mode/update-drain.test.ts src/ticket-mode/pool.test.ts
rm -rf "${work:?}"
npm run typecheck
```

After merge: none for this step. Step 2 carries the ticket's After-merge check (no ticket `running` with a `waitingOn` ticket, none `queued` behind a parked run's files) as a command over the live queue.
