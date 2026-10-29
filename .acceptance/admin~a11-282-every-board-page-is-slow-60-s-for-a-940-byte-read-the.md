Step 5 (agent-org): three of the prompts the board sends a worker's pane hold no loop. The ticket was reopened on 2026-10-29 at 15 an hour against 10. The instance's ledger on v0.335.0 shows the GitHub plugin's event operations (A11-395), `pool-settle.ts:818` (step 4) and `pool-resume.ts:142`, the `herdr agent prompt` the board sends a pane (315 ms a call). The CI-budget warning, the notice of a blocked pull request a run waits on and the wake that says push access is fine now go through `sendToAgentAsync` (`ctx.herdrCall`). The figure may still read over 10 until A11-395's second step merges.

Acceptance:

```bash
# blocking-ledger.test.ts: a herdr call's site is the code that asked, not herdr-agents.ts or pool-herdr.ts
# server.test.ts: the start-up check runs in a child the loop is not held for, and its exit status is the check's
# org-repos.test.ts, pool-org-repos.test.ts, plugins/github/repositories.test.ts: the organisation is listed through the asynchronous read, as the synchronous one lists it
# plugins/github/stack-retarget.test.ts, pool-stack-merge.test.ts, plugins/github/sync-gh-guard.test.ts: the stacked bases are swept through an asynchronous gh with the synchronous sweep's rules, calls and notes
# pool-send-async.test.ts: a prompt is asked of herdr through the async seam, to the run's pane or its workspace's root pane, and a refusal is herdr's reason, never a throw
# ci-spend/watch.test.ts, pool-wait-pulls.test.ts, pool-push-check.test.ts: the warning, the pull-request notice and the access-is-fine wake go through the async seam and never the synchronous one; a run stopped while herdr answers is not ended afterwards
# pool-close.test.ts: an ended run's workspace is closed through the async seam and never through the synchronous one; the pass's fill and a start wait for it; a refused close says herdr's reason; an ending instance waits for it, bounded
# request-thread-load.test.ts: a held tick herdr listing leaves the board thread free; a held synchronous call still leaves every request-thread read answered
# loop-load-fetch.test.ts: the load script's network is refused from the machine itself, at once
bash -c 'set -euo pipefail
npm run typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/blocking-ledger.test.ts src/ticket-mode/server.test.ts src/ticket-mode/org-repos.test.ts src/ticket-mode/pool-org-repos.test.ts plugins/github/repositories.test.ts plugins/github/stack-retarget.test.ts src/ticket-mode/pool-stack-merge.test.ts plugins/github/sync-gh-guard.test.ts src/ticket-mode/request-thread-load.test.ts src/ticket-mode/request-thread-guard.test.ts src/ticket-mode/loop-load-fetch.test.ts src/ticket-mode/loop-load-routes.test.ts src/ticket-mode/pool-close.test.ts src/ticket-mode/pool-send-async.test.ts src/ticket-mode/ci-spend/watch.test.ts src/ticket-mode/pool-wait-pulls.test.ts src/ticket-mode/pool-push-check.test.ts src/ticket-mode/pool-restack.test.ts src/ticket-mode/pool.test.ts
# The after: every read the request thread answers is under 200 ms p99 while a 2 s gh and a held systemctl keep the sweeps busy, and the request thread spawned nothing synchronously.
PATH="$T:$PATH" node scripts/loop-load.ts --json > "$T/load.json"
node -e "const r = require(process.argv[1]); if (!r.pass || r.health.requestThreadSyncCalls !== 0) process.exit(1); console.log(r.routes.map((x) => x.route + \" p99 \" + x.p99Ms + \" ms\").join(\"\\n\"))" "$T/load.json"'
```
