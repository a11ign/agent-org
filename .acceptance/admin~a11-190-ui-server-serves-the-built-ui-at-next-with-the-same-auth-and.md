## What it is

`ticket:ui` serves the built board UI (`ui/`, A11-188) at `/next/`, beside today's board at `/`. It sits behind the same Host and Origin refusal and the same browser pairing: an unpaired browser's page request gets the pairing page, an unpaired asset request gets 401, and a request with the board key is served as it is for `/`. A `/next` page reaches an instance through the routes the board uses (`/api/connections`, `/c/<connection>/api/...`), so `connections.ts` and `remote-proxy.ts` are unchanged. The build is looked for in `ui-build/` beside the running version, then in `ui/dist/`, each counted when it holds `index.html`, on every request. A client-side route falls back to the nearest page above it, files under `_astro/` are cached for a year, pages and other files are `no-cache`, a path out of the build is a 404, and with no build `/next` answers a plain 503 page naming `pnpm ui:build`.

## Acceptance

The unit tests drive `createUi` over a temporary build: the built page, an asset, the fallbacks, the headers, the same authentication, a remote (ssh) connection's calls beside `/next`, the missing-build page, a path out of the build, and `/` as it was. The live check builds the real UI, starts `ticket:ui` against a temporary state directory on free-looking ports, pairs a browser with the board key, and shows the headers of `/next/` and one `_astro` asset, a client-side route, a missing asset and `/`; it removes the process and the directory on exit.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ui-build.test.ts src/ticket-mode/ui-server.test.ts
rm -rf "${P:?}"
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:build >/dev/null
T=$(mktemp -d); PID=
trap '"'"'[ -z "$PID" ] || kill "$PID" 2>/dev/null || true; rm -rf "${T:?}"'"'"' EXIT
printf "{\"clones\":{\"x\":\"%s\"},\"stateDir\":\"%s/state\",\"tickets\":{\"port\":47301,\"uiPort\":47302}}" "$T" "$T" > "$T/host.json"
AGENT_ORG_HOST="$T/host.json" node src/ticket-mode/ui-server.ts --no-open > "$T/ui.log" 2>&1 &
PID=$!
B=http://127.0.0.1:47302
for _ in $(seq 50); do curl -s -o /dev/null "$B/" && break; sleep 0.2; done
KEY=$(cat "$T/state/tickets/board.key")
CODE=$(curl -sf -X POST -H "x-ticket-token: $KEY" "$B/api/pair-code" | sed "s/.*\"code\":\"\([^\"]*\)\".*/\1/")
COOKIE=$(curl -sf -D - -o /dev/null -X POST -d "{\"code\":\"$CODE\"}" "$B/pair" | sed -n "s/^set-cookie: \(ticket_session=[^;]*\);.*/\1/Ip" | tr -d "\r\n")
echo "--- /next/ (paired)"; curl -s -D - -o /dev/null -H "cookie: $COOKIE" "$B/next/" | grep -iE "^(HTTP|content-type|cache-control|content-security)"
ASSET=$(curl -s -H "cookie: $COOKIE" "$B/next/" | grep -o "/next/_astro/[^\"]*\.js" | head -1)
echo "--- $ASSET (paired)"; curl -s -D - -o /dev/null -H "cookie: $COOKIE" "$B$ASSET" | grep -iE "^(HTTP|content-type|cache-control)"
echo "--- $ASSET (unpaired, want 401)"; curl -s -o /dev/null -w "%{http_code}\n" "$B$ASSET"
echo "--- /next/deep/route (paired, want 200 text/html)"; curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "cookie: $COOKIE" "$B/next/deep/route"
echo "--- /next/_astro/gone.js (paired, want 404)"; curl -s -o /dev/null -w "%{http_code}\n" -H "cookie: $COOKIE" "$B/next/_astro/gone.js"
echo "--- / (paired, want no-store)"; curl -s -D - -o /dev/null -H "cookie: $COOKIE" "$B/" | grep -iE "^(HTTP|cache-control)"'
```

Consumer-declaration: none -- `/next` is a new route of the page's own service (`ticket:ui`); no option is added to a project declaration and no consumer reads one.
