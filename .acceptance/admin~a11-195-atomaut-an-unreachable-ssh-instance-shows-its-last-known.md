## What it is

An SSH remote connection that cannot be reached shows its Last known view and Check now. `ticket:ui`'s proxy (`src/ticket-mode/last-known.ts`, wired through `remote-proxy.ts` and `ui-server.ts`) keeps the last good read of each SSH connection's page reads with the time it was read, in memory and in one mode-600 file per connection under `<stateDir>/tickets/last-known/`, and sends it beside its "cannot reach" 502. The page keeps the time and draws no age. The polling hook shows that copy when it has read nothing yet, and `refresh` (Check now, Retry) starts the backoff over. The shell exposes `unreachable`, `reconnected` and `checkNow`; the Tickets page draws `AtomautUnreachable` (alert, Last known pill, Check now, Switch to this machine, queueing paused, the reconnected banner). Settings keeps its own board (Retry, no pill).

## Acceptance

Acceptance:
```bash
bash -c 'set -euo pipefail
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/last-known.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui-server.test.ts
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint src/ticket-mode ui --quiet
ls ui/captures/next-tickets-unreachable-1440x900.png ui/captures/next-tickets-unreachable-390x844.png ui/captures/next-tickets-reconnected-1440x900.png ui/captures/next-tickets-reconnected-390x844.png'
```

After merge, in a chairman session (a live check, the one thing that cannot run before merge): add `{ "personal": { "ssh": "<host>" } }` to `~/.config/agent-org/connections.json`, open `/next/tickets?connection=personal` once while `agent-org ticket:serve` runs on that host, then stop `ticket:serve` there. A pass: within about 5 seconds the page shows "Can't reach personal over SSH.", the Last known pill and the last tickets; after a reload the same view shows at once. Start `ticket:serve` again and press Check now: the banner "personal is reached over SSH again. Showing live tickets." shows and the list is read again.

Consumer-declaration: none -- `ui/` is a private package, and `ticket:ui`'s proxy answer gains a `lastKnown` field that `ui.html` ignores; no option is added to a project declaration.
