The publisher and the reviewer are now bundled agent-org plugins: `plugins/slack` (the publisher, contract 1.1, which gained `agent()`) and `plugins/atomic-reviewer` (the reviewer, contract 1.0, named `atomic` by its manifest's new optional `agentOrg.name`, so no live host file changes). Each has its settings, its doctor checks, its onboard step and its contract suite, and "none" is the absence of an enabled plugin: the built-in rows and the pin that kept core on them are gone, and the atomic port moved out of `src/ticket-mode/reviewer-port.ts` (the gate it drives stays core's, handed over through `deps.reviewing`). `tickets.providers.reviewer.required` says whether this machine's pull requests wait for the reviewer; with it required and the reviewer off the Board shows "Reviews are required and the reviewer is off", each open pull request says "waiting on the reviewer (off)" and doctor fails with the command that enables it; with no reviewer and nothing required each run's open pull requests say "awaiting your review" and nothing else is shown. A disabled publisher hides Publish and says "publishing off" on a run Ready to merge. Both concerns are enabled and disabled from `agent-org plugin` and from the Settings page with no core change.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/slack plugins/atomic-reviewer src/plugins src/install/doctor.test.ts src/install/onboard.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/review-command.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/providers.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/readme-keys.test.ts src/packaging/host-units.test.ts src/packaging/acceptance-commands.test.ts src/remedies-say-pnpm.test.ts
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "reviewer": "atomic" } }' > "$scratch/host.json"
export AGENT_ORG_HOST="$scratch/host.json"
node src/bin.ts plugin list | grep -qE '^  atomic  *enabled  *contract 1\.0  *plugins/atomic-reviewer$'
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "reviewer": { "provider": "atomic" } } } }' > "$scratch/host.json"
node src/bin.ts plugin disable atomic
grep -q '"enabled": false' "$scratch/host.json"
node src/bin.ts doctor > "$scratch/off" || true
grep -q 'reviews are required and the reviewer is off' "$scratch/off"
grep -q 'agent-org plugin enable atomic' "$scratch/off"
node src/bin.ts plugin enable atomic
! grep -q '"enabled": false' "$scratch/host.json"
node src/bin.ts doctor > "$scratch/on" || true
! grep -q 'reviews are required and the reviewer is off' "$scratch/on"
grep -q 'reviewer gate' "$scratch/on"
node src/bin.ts plugin install slack --set 'run=post {prs} into {dir}' --set 'connectors=["^mcp__chat__send"]' --confirm
grep -q '"provider": "slack"' "$scratch/host.json"
node src/bin.ts plugin disable slack
grep -q '"enabled": false' "$scratch/host.json"
node src/bin.ts plugin enable slack
node src/bin.ts plugin config atomic required=false
grep -q '"required": false' "$scratch/host.json"
node src/bin.ts plugin uninstall atomic
grep -q '"required": false' "$scratch/host.json"
test -f plugins/slack/package.json && test -f plugins/atomic-reviewer/package.json
rm -rf "$scratch"
```

Consumer-declaration: none -- no existing host file changes meaning: `tickets.providers.publish` and `tickets.providers.reviewer` keep their shape (`provider: "slack"` or `"atomic"`, `enabled`, the publisher's `run`, `model`, `effort` and `connectors`), the old `tickets.publish` and `tickets.reviewer` keys are read as aliases as before, and a machine with no reviewer block is not required to have one while one that names the reviewer is, so the personal instance (`tickets.reviewer: "atomic"`) and the work instance (no reviewer) read as the chairman described them with no migration. The Settings page draws the same publisher rows (now from the Slack plugin's manifest) and one new reviewer row, `required`. `src/ticket-mode/reviewer-port.ts` keeps what core and the github plugin read (the gate's loader, the reviewer's memory, the readers of its reviews); its port moved to `plugins/atomic-reviewer/port.ts`, which no other repository reads.
