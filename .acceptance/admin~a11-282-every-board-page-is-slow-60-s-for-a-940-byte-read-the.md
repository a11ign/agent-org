Step 4 (agent-org): the pool's own herdr calls at the start and end of a run hold no loop. The ticket was reopened on 2026-10-29 with the figure at 14 an hour against 10. Since step 3 the instance's held-loop lines are mostly the reviewer's start (A11-379, #2002), the GitHub plugin's event operations (A11-395) and the pool's `herdr` calls: the workspace close every ended run makes (`pool-settle.ts:818`, 250 ms to 1 s, its result dropped at every call site) and the pane, listing and close of a run's start. Those now go through an async call (`ctx.herdrCall`, which carries herdr's own stderr like `herdrRun`), the pass's fill and every start wait for the closes that are out, and an instance that ends waits for them up to 5 s. The figure may still read over 10 until #2002 and A11-395 merge.

Acceptance:

```bash
# blocking-ledger.test.ts: a herdr call's site is the code that asked, not herdr-agents.ts or pool-herdr.ts
# server.test.ts: the start-up check runs in a child the loop is not held for, and its exit status is the check's
# org-repos.test.ts, pool-org-repos.test.ts, plugins/github/repositories.test.ts: the organisation is listed through the asynchronous read, as the synchronous one lists it
# plugins/github/stack-retarget.test.ts, pool-stack-merge.test.ts, plugins/github/sync-gh-guard.test.ts: the stacked bases are swept through an asynchronous gh with the synchronous sweep's rules, calls and notes
# pool-close.test.ts: an ended run's workspace is closed through the async seam and never through the synchronous one; the pass's fill and a start wait for it; a refused close says herdr's reason; an ending instance waits for it, bounded
# request-thread-load.test.ts: a held tick herdr listing leaves the board thread free; a held synchronous call still leaves every request-thread read answered
# loop-load-fetch.test.ts: the load script's network is refused from the machine itself, at once
bash -c 'set -euo pipefail
npm run typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/blocking-ledger.test.ts src/ticket-mode/server.test.ts src/ticket-mode/org-repos.test.ts src/ticket-mode/pool-org-repos.test.ts plugins/github/repositories.test.ts plugins/github/stack-retarget.test.ts src/ticket-mode/pool-stack-merge.test.ts plugins/github/sync-gh-guard.test.ts src/ticket-mode/request-thread-load.test.ts src/ticket-mode/request-thread-guard.test.ts src/ticket-mode/loop-load-fetch.test.ts src/ticket-mode/loop-load-routes.test.ts src/ticket-mode/pool-close.test.ts src/ticket-mode/pool-restack.test.ts src/ticket-mode/pool.test.ts
# The after: every read the request thread answers is under 200 ms p99 while a 2 s gh and a held systemctl keep the sweeps busy, and the request thread spawned nothing synchronously.
PATH="$T:$PATH" node scripts/loop-load.ts --json > "$T/load.json"
node -e "const r = require(process.argv[1]); if (!r.pass || r.health.requestThreadSyncCalls !== 0) process.exit(1); console.log(r.routes.map((x) => x.route + \" p99 \" + x.p99Ms + \" ms\").join(\"\\n\"))" "$T/load.json"'
```
