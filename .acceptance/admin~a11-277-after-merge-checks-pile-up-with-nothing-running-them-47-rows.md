Closes A11-277

Step 3 of 3 (agent-org): each After-merge check is sent to its runner, and one left open a week is sent again, once, overdue. `src/ticket-mode/session-asks.ts` is the person's session's queue, `GET /api/session-asks`: every open check the session runs, as `kind: "after-merge-check"`, with its ticket, line, owner, role, the evidence that would close it, `sentAt`, `overdue` and the close route; a check is sent the first time the queue lists it, and `?since=<at>` lists only what was sent after an earlier read. `src/ticket-mode/after-merge/dispatch.ts` says where each check goes (a `person` check on an escalation item waits under Needs you and is never sent to the session) and marks a check overdue once, 7 days after it was sent (a Needs-you check is sent when the sweep first shows it; a board check counts from when the board began to watch it); a board check nobody saw pass becomes the session's. A row's runner is the runner the check is sent to. The sweep runs the overdue rule, the list's rows carry `needsYou` and `overdue`, the Runs page draws "Needs you" above "Failed: follow-up?", and the escalation rule names the session's queue.

Acceptance:

```bash
# after-merge/dispatch.test.ts: who each check is sent to; sent once; overdue at 7 days, once, and nothing on the 8th or 9th day; an unsent session check never overdue; a board check moved to the session, still watched; a Needs-you check overdue but never sent
# session-asks.test.ts: a session check listed with its ticket, line and evidence and sent once; a person check on the list under Needs you and not sent, one off the list sent; closed from its ask; since and the overdue resend; a bad since refused; the 33 lines of 2026-10-25 each read an owner and are all listed after one sweep
# after-merge/sweep.test.ts: the sweep sends an overdue check again once, and moves an unobserved board check to the session
# escalation.test.ts: the rule names the session's queue and the close route, and no organisation
# board-view.test.ts, after-merge/route.test.ts: the list's rows carry needsYou and overdue
bash -c 'set -euo pipefail
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/after-merge/ src/ticket-mode/session-asks.test.ts src/ticket-mode/escalation.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts'
```

The After-merge line ("Chairman session: the remaining 34 rows are each closed with evidence, or sent to their runner, within a day of release") is run by the chairman session after release: `curl -s -H "Authorization: Bearer $(cat ~/.local/state/agent-org/tickets/board.key)" http://127.0.0.1:<port>/api/session-asks`. A pass is every After-merge row of the board's list either listed there or closed, and no row reading "owner not named" for a "Chairman session:" line.
