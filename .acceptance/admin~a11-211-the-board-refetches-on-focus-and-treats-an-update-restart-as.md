## What it is

An `agent-org update` restarts the instance and the board's page service for 10 to 30 s. A board tab left open showed the failed read in red until a later poll succeeded (browsers slow timers in a background tab), and its Open terminal links stayed on the pane they were built from (A11-211).

Now, in both the current page (`src/ticket-mode/ui.html`) and the new UI's hook (`ui/src/api/`):

- The tab becoming visible, or the window gaining focus, reads at once, forgets the failures in a row, clears the message on success, and draws every terminal link from the fresh queue.
- A read with no answer (connection refused, a network error) or a 502 or 503 from a proxy is a restart: a quiet "Reconnecting…" line (the hook's state `reconnecting`), tried again after 2 s, 4 s ... up to 60 s. Red is for an error the server answered with, and for a press that got no answer.
- A terminal link is read again when it is clicked, if the state it was built from is older than 5 s (the page), and `current()` does the same for the hook.

## Change

- `src/ticket-mode/board-view/reconnect.ts` (new, pure, joined into `/board-view.js`): the poll schedule (`POLL_MS`, `nextDelay`), `isUnreachable` and the new `looksLikeRestart`. `ui/src/api/answer.ts` and `poll-schedule.ts` re-export them.
- `src/ticket-mode/ui.html`: `call()` reads the status before the body and marks a restart; `report()` shows `#reconnecting` or red; the poll is a chained timeout; `focus` and `visibilitychange` read at once; a stale terminal click reads the run's pane again.
- `ui/src/api/poller.ts`, `use-poll.ts`: the focus read, `reconnecting`, `readAt` and `current()`. `ui/src/lifecycle/Lifecycle.tsx` and `ui/src/shell/shell-model.ts` handle the new state.
- `README.md`, `.changeset/`.
- `scripts/board-restart-check.ts` (new): the after-merge check, run against this checkout in a real browser.

## Acceptance

The tests: `reconnect.test.ts` (the rule), `ui.test.ts` (the A11-211 cases: focus and visibility, a restart window, a real server error, a refused press, a page opened during the outage, stale terminal clicks) and the `ui/` cases for the hook, `Lifecycle` and the shell. The check below runs the root and `ui/` typechecks, then those tests, then `scripts/board-restart-check.ts`, which starts this checkout's `ticket:ui` with a stand-in instance in a throwaway folder, opens the board in headless Chromium, stops the instance for longer than one poll, and shows the tab says "Reconnecting…" with no red while it is down and, once the instance is back on another pane and the tab is focused again, shows no red and the run's terminal link on the new pane, with no reload. It removes its throwaway folder and both children on every exit. It needs Chromium (`pnpm --dir ui exec playwright-core install chromium`).

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/reconnect.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/ui-server.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/
node scripts/board-restart-check.ts'
```

After merge, once the release is installed, the chairman session runs the live check: open the board in a tab, put the tab in the background, restart the instance and the ui user services (`agent-org-instance.service` and `agent-org-ui.service`) with one `systemctl --user restart` command, wait 60 s and come back to the tab. A pass: the tab showed "Reconnecting…" at most while the services were down and never red; coming back draws the current queue at once, without a reload; a run's Open terminal opens that run's live pane.

Consumer-declaration: none -- the page and the hook change how they read; no route, answer or project declaration changes.
