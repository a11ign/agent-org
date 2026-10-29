Step 3 of 4 (agent-org): the board thread's own calls hold no loop (ADR 0014, "Taking the board thread's own calls off its loop"). The ticket was reopened on 2026-10-28 with the board's figure "synchronous holds an hour" at 26 against a threshold of 10: the request thread (step 2) keeps reads from waiting on the board thread, but the board thread still held its loop for every synchronous `gh`, `git` and `herdr` call of its tick and sweeps, which delays writes and `GET /api/session-asks` and is what the figure counts. This step makes asynchronous the calls that run on every pass or every sweep and that the code could take without a rewrite of the reviewer's start: the start-up `gh` wrapper check, the tick's herdr listings, the clone sweep's organisation listing and the stacked pull requests' base sweep (code host contract 2.2, two OPTIONAL operations). It also repairs `scripts/loop-load.ts`, which reached the real Linear and failed its own 200 ms bound on 300 ms of internet.

Acceptance:

```bash
# blocking-ledger.test.ts: a herdr call's site is the code that asked, not herdr-agents.ts or pool-herdr.ts
# server.test.ts: the start-up check runs in a child the loop is not held for, and its exit status is the check's
# org-repos.test.ts, pool-org-repos.test.ts, plugins/github/repositories.test.ts: the organisation is listed through the asynchronous read, as the synchronous one lists it
# plugins/github/stack-retarget.test.ts, pool-stack-merge.test.ts, plugins/github/sync-gh-guard.test.ts: the stacked bases are swept through an asynchronous gh with the synchronous sweep's rules, calls and notes
# request-thread-load.test.ts: a held tick herdr listing leaves the board thread free; a held synchronous call still leaves every request-thread read answered
# loop-load-fetch.test.ts: the load script's network is refused from the machine itself, at once
bash -c 'set -euo pipefail
npm run typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/blocking-ledger.test.ts src/ticket-mode/server.test.ts src/ticket-mode/org-repos.test.ts src/ticket-mode/pool-org-repos.test.ts plugins/github/repositories.test.ts plugins/github/stack-retarget.test.ts src/ticket-mode/pool-stack-merge.test.ts plugins/github/sync-gh-guard.test.ts src/ticket-mode/request-thread-load.test.ts src/ticket-mode/request-thread-guard.test.ts src/ticket-mode/loop-load-fetch.test.ts src/ticket-mode/loop-load-routes.test.ts src/ticket-mode/pool-restack.test.ts src/ticket-mode/pool.test.ts
# The after: every read the request thread answers is under 200 ms p99 while a 2 s gh and a held systemctl keep the sweeps busy, and the request thread spawned nothing synchronously.
PATH="$T:$PATH" node scripts/loop-load.ts --json > "$T/load.json"
node -e "const r = require(process.argv[1]); if (!r.pass || r.health.requestThreadSyncCalls !== 0) process.exit(1); console.log(r.routes.map((x) => x.route + \" p99 \" + x.p99Ms + \" ms\").join(\"\\n\"))" "$T/load.json"'
```
