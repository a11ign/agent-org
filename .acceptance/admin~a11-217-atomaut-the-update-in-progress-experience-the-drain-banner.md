## What it is

The board restarts on every auto-update. A page left open used to show a plain "Reconnecting…" (A11-211) and never said an update was the cause. Now the Atomaut pages show the update in progress (A11-217), as the six boards `AtomautUpdating`, `AtomautUpdatingBreaking`, `AtomautUpdatingSlow`, `AtomautUpdatingBack`, `AtomautTicketsDraining` and `AtomautRunsDraining` draw it.

## Change

- `src/ticket-mode/update-next.ts` (new, read-only) and `server.ts`: `/api/queue`'s `update` gains `next`, the version an update is moving to while `update.lock` names a live process.
- `ui/src/updating/` (new): the pure model (the detection rule, the Slow threshold, Back), the hook, the Updating/Slow/Back card and the drain banner. `ShellFrame` draws them; `shell-model.ts` and `Sidebar.tsx` give the pill its amber "Updating"; `ui/src/api/poller.ts` and `use-poll.ts` cap the wait after failures at 5 s while the card shows.
- `README.md`, `.changeset/`, `scripts/board-update-check.ts` (new): the real-browser check over a real throwaway install.

## Acceptance

The tests: `update-next.test.ts` (the `next` rule and `/api/queue`), and in `ui/`: `update-model.test.ts` (the detection rule, Slow at 59.999 s and 60 s, Back only on a changed version), `updating.test.tsx` (each card state for both releases, the pill, the 5 s cadence, what is not an update), `drain-banner.test.tsx`, `tickets-draining.test.tsx`, `runs-draining.test.tsx` (the banner and the per-run lines), `shell-model.test.ts` and `use-poll.test.tsx`; and the page checks `ui/test/updating/updating.page.test.ts` (the six boards at 1440px and 390px with no horizontal overflow, captures in `ui/captures/updating/`).

`scripts/board-update-check.ts` builds a throwaway install (a bare mirror of a throwaway remote that holds three releases of this checkout, `versions/<tag>` built by `buildVersion`, `current` swapped by `swapCurrent`), starts the real `ticket:serve` and `ticket:ui` through `current` with a stub herdr that lists a run while a real process stands for its worker, and drives a paired headless Chromium on `/next/runs` through `update()` run under the update lock: a normal update (Updating, Slow after 60 s, Back, the page reloads; the run is still running on its old version and its worker's process is the same) and a breaking release (built and drained: the banner and the run's "finishing before the update" line; the worker ends; applied: Updating with the breaking words, Back, a reload, no banner). It takes about four minutes, needs `pnpm ui:build` first, touches no real instance, key, port, unit or herdr, and removes its folder and children on every exit.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
pnpm ui:build >/dev/null
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/update-next.test.ts src/ticket-mode/update-drain.test.ts
pnpm ui:test
node scripts/board-update-check.ts'
```

After merge, once the cutover (A11-202) has made `/` Atomaut, the chairman session checks the next auto-update on the agents host: a page left open shows Updating, then Back, and reloads. A pass: the card names the real versions, the pill is amber while it shows, the run list is the same after the reload, and no run was stopped by a normal update.

Consumer-declaration: none -- `/api/queue`'s `update` gains one field; no route, project declaration or command changes.
