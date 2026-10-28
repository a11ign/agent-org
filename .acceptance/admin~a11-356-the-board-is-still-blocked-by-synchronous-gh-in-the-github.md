Refs A11-356

Step 1 (agent-org): the code host's reads that the board's sweeps make on every pass answer a promise and run `gh` through `deps.execAsync` (code host contract 2.0, ADR 0015), so the board's loop is not held while GitHub answers. The GitHub plugin reads a repository's open pull requests with one `gh pr list` that every pull request of it and every caller shares for ten seconds (`plugins/github/reviews.ts`, `shared-reads.ts`), where each caller read each pull request with its own `gh pr view`. `plugins/github/sync-gh-guard.test.ts` refuses a synchronous spawn under `plugins/`, requires the reads to reach `deps.execAsync` and never `deps.exec`, and names each operation that still runs `gh` synchronously (the writes and the reads done on an event). The pool's sweeps wait on the reads, a few at a time, and the server runs each sweep one at a time. What remains: those synchronous operations, which are not the call sites that held the loop in the ticket's table.

After merge, the board runs the ticket's reading (runner: board, per its Done-when) on the host with the instance: `journalctl --user -u agent-org-instance --since "1 hour ago" --no-pager | grep -c "a synchronous gh held the loop"`. A pass is a count under 10, for each hour of the 7 days after the release is installed. The block below is the same reading before merge: a real instance whose `gh` takes 2 s must show no `gh` among the calls that held the board thread.

Acceptance:

```bash
# reviews.test.ts: five pull requests of one repository, read by two callers, are one `gh pr list` and no `gh pr view`
# shared-reads.test.ts: callers of one key share one read until the bound after it settled; a failed read is not kept
# sync-gh-guard.test.ts: no synchronous spawn under plugins/ but the listed ones; the reads reach execAsync and never exec; the synchronous operations are exactly the listed ones
# checks.test.ts: doctor's stacking rows ask through execAsync
# pool-reads.test.ts: at most four reads at once, answers in the items' order
# pool-watch-stale-run.test.ts: the watch leaves alone a run that is no longer finished when its reads return, and merges no base into a branch a worker has started on
bash -c 'set -euo pipefail
npm run typecheck
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts plugins/github/reviews.test.ts plugins/github/shared-reads.test.ts plugins/github/sync-gh-guard.test.ts plugins/github/checks.test.ts plugins/github/code-host.test.ts plugins/github/conformance.test.ts src/ticket-mode/request-thread-guard.test.ts src/ticket-mode/pool-reads.test.ts src/ticket-mode/pool-watch-stale-run.test.ts src/ticket-mode/pool-look-one-at-a-time.test.ts src/ticket-mode/after-merge/observe-windows.test.ts
# The after, on a real instance whose stand-in gh sleeps 2 s per call: no gh holds the board thread, and /api/queue answers under 2 s.
PATH="$T:$PATH" node scripts/loop-load.ts --json > "$T/load.json"
node -e "const r = require(process.argv[1]); const held = r.health.blocking.filter((s) => s.program === \"gh\"); const queue = r.routes.find((x) => x.route === \"/api/queue\"); if (!r.pass || held.length > 0 || !(queue.p99Ms < 2000)) { console.error(JSON.stringify({ held, queue })); process.exit(1); } console.log(\"no gh held the board thread; /api/queue p99 \" + queue.p99Ms + \" ms\")" "$T/load.json"'
```
