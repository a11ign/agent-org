Closes A11-282

Step 2 of 2 (agent-org): the instance answers requests on a thread of its own (ADR 0014). `serve()` keeps the pool, the tick and the sweeps on the board thread, which stays the queue's one writer, and starts the HTTP server in a `worker_threads` worker (`src/ticket-mode/request-thread.ts`). The board thread posts a snapshot of the queue and the pool's readings after every queue change and every second (`board-thread.ts`); the request thread answers every GET route of `read-routes.ts` (moved out of `server.ts`), `/api/health` and `POST /api/terminal-run` from it, with its own activation of the tracker, and forwards every other request whole to `createBoard(...).api`, carrying the page's copies of the tickets the body names. `/api/health` answers `{ loop: { requests, board }, boardSnapshotAgeMs, blocking, requestThreadSyncCalls }`. A request thread that exits is started again, 3 times a minute at most. `request-thread-guard.test.ts` walks the request thread's imports and refuses a synchronous spawn outside its listed exceptions; `request-thread-load.test.ts` and `scripts/loop-load.ts` prove every read stays under 200 ms p99 while a 2 s `gh` holds the board thread.

Acceptance:

```bash
# board-thread.test.ts: reads over a snapshot answer what the board's routes answer; a forwarded write carries the page's copies and brings back the tracker's; restarts and their budget
# read-routes.test.ts: the request gate (host, key, a route's sentence as a 400) and the tracker's reads both threads use
# health-route.test.ts: the request thread's health view, and its ledger counting a synchronous spawn only after it listens
# request-thread-guard.test.ts: no module the request thread runs spawns synchronously, but the listed exceptions, none stale
# serve-ticket-only-host.test.ts ("stopping the instance stops the plugin checks it started"): a SIGTERM leaves no gh a check started running, so nothing writes under a test's HOME after it ends
# request-thread-load.test.ts: a real instance, 2 s gh, every local read p99 under 200 ms, the board thread held meanwhile, a forwarded write lands
bash -c 'set -euo pipefail
[ -d ui/node_modules ] || pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-thread.test.ts src/ticket-mode/read-routes.test.ts src/ticket-mode/health-route.test.ts src/ticket-mode/request-thread-guard.test.ts src/ticket-mode/request-thread-load.test.ts src/ticket-mode/serve-ticket-only-host.test.ts src/ticket-mode/server.test.ts src/ticket-mode/session-asks.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/ui-server-health.test.ts src/ticket-mode/loop-load-routes.test.ts src/ticket-mode/settings-read.test.ts src/ticket-mode/blocking-ledger.test.ts
# The after: every read the request thread answers is under 200 ms p99 while the sweeps hold the board thread, and the request thread spawned nothing synchronously.
PATH="$T:$PATH" node scripts/loop-load.ts --json > "$T/load.json"
node -e "const r = require(process.argv[1]); if (!r.pass || r.health.requestThreadSyncCalls !== 0 || r.health.loop.requests === undefined) process.exit(1); console.log(r.routes.map((x) => x.route + \" p99 \" + x.p99Ms + \" ms\").join(\"\\n\"))" "$T/load.json"'
```
