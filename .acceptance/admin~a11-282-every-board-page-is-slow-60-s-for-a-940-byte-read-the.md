Refs A11-282

Step 1 of 2 (agent-org): the instance's loop is measured, and the board shows it. `src/ticket-mode/loop-delay.ts` reads `perf_hooks.monitorEventLoopDelay` as p50, p99 and max over the last minute, past the sampler's own 10 ms, and the worst since start. `src/ticket-mode/blocking-ledger.ts` wraps `spawnSync`, `execFileSync` and `execSync` on `node:child_process` at start (with `syncBuiltinESMExports`, so no call site is edited) and counts each call against the code that asked, as `path:line`; a call of 250 ms or more is one stderr line. `GET /api/health` on the instance answers `{ loop: { board }, blocking }` (the ten worst sites), and the page service answers its own loop at its root `/api/health`; the proxy passes the instance's on. The sidebar shows `Loop p99 18 ms` under the connection pill, warning from 100 ms, and nothing for an instance without the route. `scripts/loop-load.ts` runs a throwaway instance with a 2 s stand-in `gh` and the sweeps every second, and reads every route 20 times: in this step it is the "before", and exits 1. `scripts/loop-watch.ts` is the after-merge check.

Acceptance:

```bash
# loop-delay.test.ts: the window so far, idle and empty histograms reading 0, a kept minute, the worst since start, stop, and a real 300 ms stall
# blocking-ledger.test.ts: a wrapper answers and throws what the original did, counts against the call site past Node and the seams, logs a slow call, and reaches a named import taken before install (a real Node child)
# health-route.test.ts and ui-server-health.test.ts: the instance's and the page service's /api/health, unpaired refused, absent before, and passed on by the proxy
# ui: loop-line.test.ts (the words, the warning, the tooltip, hidden when unread) and test/shell-loop/loop.page.test.ts (Chromium, 1440 and 390 wide, writes ui/captures/shell-loop/)
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/loop-delay.test.ts src/ticket-mode/blocking-ledger.test.ts src/ticket-mode/health-route.test.ts src/ticket-mode/ui-server-health.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui-server.test.ts
pnpm ui:build >/dev/null
pnpm --dir ui exec rstest run --config rstest.config.ts src/shell/loop-line.test.ts test/shell-loop/ test/shell.page.test.ts
# The before: every read waits on the sweeps, so the script exits 1, and the ledger names the 2 s stand-in gh's call site among the sites that held the loop.
node scripts/loop-load.ts --json > "$T/load.json" || test $? -eq 1
node -e "const r = require(process.argv[1]); if (r.pass || r.health === null || !r.health.blocking.some((s) => s.program === \"gh\" && s.maxMs >= 1900)) process.exit(1); console.log(r.health.blocking.slice(0, 5))" "$T/load.json"'
```

Step 2 (the request thread, which makes `scripts/loop-load.ts` pass) follows in its own pull request.
