Closes A11-250

Step 2 of 2 (agent-org): the reviewer honours the ticket's Decisions. A blocked head whose ticket's `## Decisions` changed since the reviewer's last look is re-reviewed once (a round, handed back at the cap), and the reviewer is told which Decisions lines changed (`rereview.decisions`, reviewer contract 1.7). A reply or new description line that says a person decided something and does not link the ticket's Decisions reaches the reviewer as `rereview.unsupported`, and the prompt says it does not answer the finding. A finished run holding a blocked pull request has its ticket's text read again from the tracker, so a person's edit of the Decisions in the tracker is seen too.

Acceptance:

```bash
# rstest needs a fixture project (as CI's suite job lays one), so it does not depend on the caller's home; it is removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
# pool-rereview-decisions.test.ts: an answered entry reaches the reviewer's brief (the review after it is briefed with the decision), a Decisions change re-reviews the same head once and tells the changed lines, a look with no decisions is left alone, the cap hands the run back, a tracker edit reaches a blocked run, and a "decided" reply with no ticket link is passed as unsupported
# ticket-decisions.test.ts covers unsupportedClaims; prompt.test.ts the reviewer's words for a Decisions change and an unsupported claim
AGENT_ORG_HOST="$work/project/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-rereview-decisions.test.ts src/ticket-mode/ticket-decisions.test.ts plugins/atomic-reviewer/prompt.test.ts src/ticket-mode/pool-rereview.test.ts src/ticket-mode/pool-reviewers.test.ts src/ticket-mode/review-command.test.ts src/plugins/built-in.test.ts src/plugins/cli.test.ts plugins/atomic-reviewer/index.test.ts
rm -rf "${work:?}"
npm run typecheck
```
