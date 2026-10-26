Closes A11-297

`request-thread-load.test.ts` no longer asserts a wall-clock percentile. Its stand-in `gh` (a gated one, new in `scripts/loop-load.ts`) returns only when the test opens a gate file, so the board thread stays held for exactly as long as the test reads. The test waits for a sweep's `gh` call to start, reads every route the request thread answers three times while no `gh` call has returned, and only then opens the gate and lands a write. A read that came back is a read answered before the `gh` returned, at any runner speed. The one timeout left is the 15 s a single read may take before the test calls it unanswered, which is far over ten times a read's median (a few ms). `ci.yml` gains a pull-request job that runs the file 50 times when the change touches it.

Acceptance:

```bash
# request-thread-load.test.ts: every local read is answered while the gated gh is held (no gh call has returned), the board snapshot only ages, the request thread spawned nothing synchronously, a write lands once the gate opens
# The mutation: with the request thread forwarding every read to the board thread, the test fails ("/api/config was answered while the board thread was held").
bash -c 'set -euo pipefail
npm run typecheck
node .github/scripts/workflow-paths.ts
T=$(mktemp -d); printf "#!/bin/sh\nexit 0\n" > "$T/tailscale"; chmod +x "$T/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
run() { PATH="$T:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/request-thread-load.test.ts src/ticket-mode/loop-load-routes.test.ts; }
run
cp src/ticket-mode/request-thread.ts "$T/request-thread.ts.orig"
trap "cp \"$T/request-thread.ts.orig\" src/ticket-mode/request-thread.ts" EXIT
sed -i "s|return method === \"GET\" ? readRoute(board, method, path, query) : undefined;|return undefined;|" src/ticket-mode/request-thread.ts
! git diff --quiet src/ticket-mode/request-thread.ts
if run; then echo "the mutated request thread passed: the test proves nothing"; exit 1; fi
echo "the mutated request thread fails the test, as it must"'
```
