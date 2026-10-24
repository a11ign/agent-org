## What it is

The Atomaut shell, in `ui/`: the 248px sidebar every main page has (the mark, the instance switcher, the connection pill, Tickets and Runs, the page's own middle section, Settings at the bottom; full width at 820px and below), the design tokens in one file (`ui/src/styles/tokens.css`), the shared lifecycle components (`ui/src/lifecycle/`: skeletons, the empty panel, the error banner with Retry, the unreachable frame), and a placeholder page for each route inside the shell: `/next/tickets`, `/next/runs`, `/next/runs/<key>` and `/next/settings/<models|workers|machine|plugins>`, the active item marked. The switcher lists this instance and the configured connections and moves every read to the one chosen. The sidebar's reads are `/api/connections` once, `/api/config` and `/api/tickets` once per connection (the poll's new `repeat: false`), and `/api/queue` every 5s. A11-188's placeholder page and its `Counter` island are gone.

## Acceptance

The component checks (happy-dom) drive the shell over a stand-in instance: the switcher's labels, a switch (remembered, reads move to `/c/<name>/api/...`, nothing of the other instance stays), the pill for each state, the active item of each route, the Tickets, Projects and Goals counts, the Settings sub-nav, each lifecycle component for each state with Retry calling `refresh`, and the one-shot poll with fake timers. The page checks drive Chromium over the real build: every route inside the shell with its title and active items, the redirects, a switch surviving a navigation, 248px at 821px and full width at 820px, no horizontal overflow at 1440px and 390px for each route, the Tab order, the focus ring, and the shimmer off for reduced motion. The token check refuses a colour literal or a stray pixel length outside `tokens.css`. The live check serves the build with `ticket:ui` on a temporary state directory and shows that each route answers with its page and title.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
T=$(mktemp -d); PID=
trap '"'"'[ -z "$PID" ] || kill "$PID" 2>/dev/null || true; rm -rf "${T:?}"'"'"' EXIT
printf "{\"clones\":{\"x\":\"%s\"},\"stateDir\":\"%s/state\",\"tickets\":{\"port\":47311,\"uiPort\":47312}}" "$T" "$T" > "$T/host.json"
AGENT_ORG_HOST="$T/host.json" node src/ticket-mode/ui-server.ts --no-open > "$T/ui.log" 2>&1 &
PID=$!
B=http://127.0.0.1:47312
for _ in $(seq 50); do curl -s -o /dev/null "$B/" && break; sleep 0.2; done
KEY=$(cat "$T/state/tickets/board.key")
CODE=$(curl -sf -X POST -H "x-ticket-token: $KEY" "$B/api/pair-code" | sed "s/.*\"code\":\"\([^\"]*\)\".*/\1/")
COOKIE=$(curl -sf -D - -o /dev/null -X POST -d "{\"code\":\"$CODE\"}" "$B/pair" | sed -n "s/^set-cookie: \(ticket_session=[^;]*\);.*/\1/Ip" | tr -d "\r\n")
for R in tickets runs runs/A11-1 settings/models settings/workers settings/machine settings/plugins; do
  echo -n "--- /next/$R: "; curl -s -o "$T/page.html" -w "%{http_code} " -H "cookie: $COOKIE" "$B/next/$R"; grep -oE "<title>[^<]*|aria-label=\"Atomaut\"" "$T/page.html" | tr "\n" " "; echo
done
echo "--- /next/ and /next/settings (want the redirect pages)"; for R in "" settings; do curl -s -H "cookie: $COOKIE" "$B/next/$R" | grep -o "url=/next/[a-z/]*"; done'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
