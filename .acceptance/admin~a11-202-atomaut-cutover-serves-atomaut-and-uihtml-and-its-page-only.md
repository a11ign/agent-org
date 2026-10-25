## What it is

The last step of the Atomaut epic (A11-192). `ticket:ui` serves Atomaut at `/`, `/next` redirects to the same address without it, the old board (`src/ticket-mode/ui.html`) and the code and tests that existed only for it are deleted, and the canvas walk, the PARITY.md walk and the keyboard walk of every page were run before the switch.

## Change

- `src/ticket-mode/ui-server.ts`, `ui-build.ts`: every `GET`/`HEAD` that is not an instance call is the build's; `/next/<rest>` is a 302 to `/<rest>`; an unpaired browser gets `pair.html` for any page address and a 401 for a file or a call; `endedPage` links to `/runs/<KEY>?connection=<c>`. Deleted: `ui.html`, `ui.test.ts`, `ui-css.test.ts`, the `/*.js` script routes and their five server functions.
- `ui/`: `BASE` is empty and Astro's `base` is `/`; `ui/src/shell/old-links.ts` sends the old board's `?connection=` and anchors to their pages; Run detail's Timeline (`run-timeline-model.ts`, `Timeline.tsx`); a plugin's description and where it is; the Reconnecting line on Tickets and Settings and a retry of the Plugins read after a restart; `CodeWords`; the shell's placeholder pages are gone.
- `ticket:capture`, `scripts/board-restart-check.ts`, `scripts/board-update-check.ts`, doctor and `install.sh` say `/` and drive Atomaut. `docs/design/atomaut/PARITY.md`, its README's board index (60 boards) and the root README follow.

## Acceptance

Tests: `ui-server.test.ts` (`/` and a page path are the build's; `/next` redirects, never to another origin; an unpaired page path is the pairing page and an unpaired file or call is a 401; the instance's calls answer with a build and without one; the old `/board-view.js` is a 404), `ui-build.test.ts` (`movedFromNext`), `capture.test.ts`, `capture-command.test.ts`, `remote-proxy.test.ts`; in `ui/`: `old-links.test.ts` and `shell.page.test.ts` (each old form lands on its page with the instance chosen), `run-detail-timeline.test.tsx`, `plugins-states.test.tsx`, `pages-lifecycle.test.tsx` (every page's failed first read), `use-modal-focus.test.tsx`, and the page checks `ui/test/cutover/keyboard.page.test.ts` and `walk.page.test.ts` (the keyboard walk of every page and the differences the canvas walk fixed). `parity.test.ts` was run once on the last commit that held `ui.html` (10 passed) before the file was deleted.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
pnpm ui:build >/dev/null
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/ui-build.test.ts src/ticket-mode/capture.test.ts src/ticket-mode/capture-command.test.ts src/ticket-mode/remote-proxy.test.ts src/install/doctor.test.ts
pnpm ui:test
node scripts/board-restart-check.ts
test ! -e src/ticket-mode/ui.html'
```

After merge, once the agents host's auto-update has brought the release, the chairman session runs, on the agents host and again on the laptop (`<uiPort>` is `tickets.uiPort`, 4748 by default):

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:<uiPort>/next/tickets   # a pass: 302 http://127.0.0.1:<uiPort>/tickets
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<uiPort>/board-view.js                    # a pass: 401 (an unpaired call), and 404 once paired
```

and opens `http://127.0.0.1:<uiPort>/` in a paired browser. A pass: it goes to `/tickets` and shows Atomaut's sidebar and the Tickets page of the instance (with `?connection=<name>` it opens on that instance); `/#run-<KEY>` opens that run's page.

Consumer-declaration: none -- no route of the instance API, project declaration or command changes; the page's service stops answering `/board-view.js` and the four other script routes, which nothing but the deleted page used.
