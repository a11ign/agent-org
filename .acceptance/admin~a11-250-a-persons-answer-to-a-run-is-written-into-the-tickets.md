Refs A11-250

Step 1 of 2 (agent-org): `POST /api/queue/<KEY>/answer` takes a person's answer to the run waiting on them and writes it, with the run's question, into the ticket's description under `## Decisions (<who>, <date>)` through the tracker plugin, then sends it to the run. Only that route writes a Decisions entry; `ticket:hook` refuses a run any command that names the board's key or a queue action route, and any file tool on the key. Every worker brief, a review round and a talk session say to read the ticket's Decisions first and to relay a decision to a pull request only with a link to its entry. A planner's plan for a ticket with Decisions carries a `## Ticket decisions` section, and a plan that states a `Conflicts:` or has no such section is not attached. Partial: step 1 of 2; step 2 makes the reviewer honour Decisions, re-review once when they change, and refuse a "decided" claim with no ticket entry.

Acceptance:

```bash
# rstest needs a fixture project (as CI's suite job lays one), so it does not depend on the caller's home; it is removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
# server-answer.test.ts drives the route over HTTP on a board with a fake tracker and a fake herdr: the answer lands in the ticket's Decisions before the run is told, and a request without the key or from another origin writes nothing
# pool-answer.test.ts and answer-decision.test.ts cover the entry, the refusals and the retry; hook-answer.test.ts the key and the routes a run may not name
# worker-files-decisions.test.ts and plan-ticket-decisions.test.ts cover the briefs and the plan check, which refuses a plan with a Conflicts bullet or no Ticket decisions section
AGENT_ORG_HOST="$work/project/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/server-answer.test.ts src/ticket-mode/pool-answer.test.ts src/ticket-mode/answer-decision.test.ts src/ticket-mode/hook-answer.test.ts src/ticket-mode/worker-files-decisions.test.ts src/ticket-mode/plan-ticket-decisions.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/server.test.ts src/ticket-mode/pool.test.ts
rm -rf "${work:?}"
npm run typecheck
```
