## What it is

A release is tagged minutes before CI attaches its UI build (`agent-org-ui-<tag>.tar.gz` and its `.sha256`). `agent-org update` read the tags, so inside that window it targeted the new tag, got a 404 for the asset and failed with exit 2 on every machine, for every release (v0.306.0, 2026-10-25).

- `agent-org update`, when it follows the newest release (no `--version`, no `toolVersion` pin), now targets the newest **released** tag: one that declares no UI build, or whose declared build is attached (its `.sha256` answers 200). A tag that declares a build (`agentOrg.shipsUiBuild`) and answers 404 is "not released until it has": it is skipped with one log line, `current` stays, no service restarts, the update exits 0, and the status file's `latest` is the newest released tag. The next update moves as usual once the build is attached.
- A probe that fails any other way (HTTP 5xx, no network, no releases address) is not "not released": the tag is targeted and the build reports the real failure. A named `--version` or `toolVersion` pin is not walked and keeps its refusal.
- A release version folder with no UI build of its own now serves the newest older release folder's build (which shows Updating, then Back), and when there is none, a minimal "Updating Atomaut" page that reloads itself every 5 seconds (503, `Retry-After: 5`). The "The UI build is missing" page stays for a checkout and the main channel. `doctor` still looks only at the running version's own build.

The release workflow is not reordered: the tag is pushed by the shared `release-per-merge.yml`, and `agent-org update` reads tags, never Releases, so the ticket's "or, equally" side is taken.

## Acceptance

- "A release is never visible without its UI build" (updater side): `update.test.ts` "A11-284: a release whose declared build is not attached yet is not released…" (current unchanged, no restart, one probe, status `latest`, then moves once attached); "only the release whose build is late is skipped"; "the walk stops at the installed version…".
- "`current` never moves to a version that has no UI build": the same first test, and the existing A11-266 `swapCurrent` tests; "a version named with --version is not walked" keeps the refusal.
- "A missing build serves the Updating page": `ui-server.test.ts` "A11-284: a release install with no build answers the Updating page…"; `ui-build.test.ts` "A11-284: a release version folder is served from its own build, then each older release's…"; `ui-asset.test.ts` "A11-284: a release's build is attached when its checksum answers 200…".

Acceptance:
```bash
npm run typecheck
npx eslint --quiet src/install/update.ts src/install/ui-asset.ts src/ticket-mode/ui-build.ts src/ticket-mode/ui-server.ts
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/update.test.ts src/install/ui-asset.test.ts src/ticket-mode/ui-build.test.ts src/ticket-mode/ui-server.test.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- `UpdateDeps` gains a `released` seam used only by `update.ts` and its fixture, and `ui-build.ts` gains functions; no consuming repository's declaration needs a line.
