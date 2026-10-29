Step 6 (agent-org): the board thread holds nothing the board's figure counts. The ticket was reopened four times by `syncHolds.lastHour` (26, 14, 15 and 84 an hour against 10) with the loop p99 under 10 ms each time: requests were answered, and the board thread still made synchronous `herdr`, `systemctl` and `git` calls every pass. The journal named only calls of 250 ms or more, so the 100 to 249 ms calls the figure counts were nowhere; its line and the figure's count are now one constant. The pass's pane read, the run-directory sweep, the read of herdr's start, the start dialog, the safety prompt, the prompts to a worker, the environment check, the reseat, the session settling, the closes of a parked run and of a run stopped for an update, a CI budget or a ticket wait, the instance's start, the clones' origins and the organisation's repositories are asynchronous. What stays synchronous is listed with its loop and a rate in `board-thread-sync-guard.test.ts`.

Acceptance:

```bash
# blocking-ledger.test.ts: every call the health figure counts as a hold is a line of the journal, and no shorter call is either
# herdr-async-sites.test.ts: each converted site is run over a context whose synchronous herdr throws; a pass, the sweep, the start of an instance, a close and a start dialog ask herdr only through the asynchronous seam
# async-state-rechecks.test.ts (and the wrong-repo case in pool-org-repos.test.ts): a run changed while herdr (or the code host) answers is not prompted, observed, ended, resumed, stopped for an update, moved or have its workspace closed as a leftover; each has a control that leaves the run alone and sees the action
# board-thread-sync-guard.test.ts: no synchronous spawn or herdr call in src/ticket-mode or plugins but the listed ones, each with a loop and a rate, and the rates sum under 10 an hour
# request-thread-load.test.ts: with the board thread held by a stand-in synchronous call, every read the request thread answers is answered, and a write lands once it returns
# pool.test.ts, pool-resume.test.ts, run-isolation.test.ts and the pool family: the behaviour of the converted passes is as it was
bash -c 'set -euo pipefail
npm run typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/blocking-ledger.test.ts src/ticket-mode/herdr-async-sites.test.ts src/ticket-mode/async-state-rechecks.test.ts src/ticket-mode/pool-org-repos.test.ts src/ticket-mode/board-thread-sync-guard.test.ts src/ticket-mode/request-thread-load.test.ts src/ticket-mode/request-thread-guard.test.ts src/ticket-mode/loop-load-routes.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/pool-resume.test.ts src/ticket-mode/run-isolation.test.ts src/ticket-mode/pool-readopt.test.ts
# The after: every read the request thread answers is under 200 ms p99 while a 2 s gh and a 150 ms herdr keep the sweeps busy, the request thread spawned nothing synchronously, and the board thread held its loop 0 times.
PATH="$T:$PATH" node scripts/loop-load.ts --json > "$T/load.json"
node -e "const r = require(process.argv[1]); if (!r.pass || r.health.requestThreadSyncCalls !== 0 || r.health.figures.syncHolds.lastHour !== 0) process.exit(1); console.log(r.routes.map((x) => x.route + \" p99 \" + x.p99Ms + \" ms\").join(\"\\n\"))" "$T/load.json"'
```
