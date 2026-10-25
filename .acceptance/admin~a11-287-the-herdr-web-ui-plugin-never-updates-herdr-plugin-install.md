## What it is

`agent-org update` ran `herdr plugin install devswha/herdr-web-ui --ref v0.4.16 -y` every ten minutes, the command exited 0, and the read-back said herdr's `plugins.json` "does not list devswha/herdr-web-ui at v0.4.16". The cause is upstream, not a herdr session, a pin or a `--ref` form: at v0.4.16 the plugin's manifest id changed from `devswha.herdr-web-ui` to `devswha.ovis`, herdr keys installs by that id, so the install ADDED a second entry with the same `source` and left the old one. agent-org took the first entry of the repository, which was always the old one.

- A herdr plugin is found by its GitHub repository (`src/install/herdr-plugins.ts`), never by its id. Of the entries that share the repository the **current** one is on the highest release tag, then the latest `installed_unix_ms`, then the last in the file; the others are **stale**. Upkeep's read-back, doctor's row and `pluginRoot` (the terminal service, `ticket:pair`, `onboard`) all read it, so the terminal runs the new copy and `onboard` no longer fails on a renamed entry.
- Once the terminal service runs the current copy (rewritten and restarted, only if it was running), upkeep runs `herdr plugin uninstall <id>` for each stale entry of a plugin it installed itself. This repairs a machine that already holds both entries on its first update.
- **A step that does not take is said once:** an install that exits non-zero or leaves `plugins.json` without the tag, or an uninstall that leaves the entry, is one error line holding herdr's own output (stdout then stderr, the last 20 lines, at most 2,000 characters), is recorded in `herdr-status.json` as `failed`, and makes that update run exit 1 (the tool move stays applied). Later runs on the same release run nothing and add no line; a newer release tries once more; `plugins.json` showing the plugin current with no stale copy clears the record.
- `doctor`'s `herdr plugin devswha/herdr-web-ui` row is **ok** at the newest release with one copy, **warns** when behind or when an older copy is still listed (naming `herdr plugin uninstall <id>`), and **fails** while a failure is recorded for the newest release (naming the command and herdr's first line).

## Acceptance

Each line of the ticket's Acceptance is proven by a named test:

- Why the install left `plugins.json` unchanged, and the move read back: "an install that adds the renamed entry is read back at the new tag, the terminal restarts onto it, and then the stale entry is uninstalled" and "of several copies of a repository the current one has the highest release tag…" (`herdr-upkeep.test.ts`); "herdr web ui's directory is the newest copy's when a renamed manifest id left two…" (`terminal.test.ts`).
- A move that does not take fails visibly, once, with herdr's output: "an install that exits 0 and leaves plugins.json unchanged is one failure with herdr's own output; later runs on that tag are quiet, and a newer tag tries once more", "an install that exits non-zero is held the same way…", "an uninstall that fails, or exits 0 and leaves the entry, is one failure…" (`herdr-upkeep.test.ts`); "an update whose herdr upkeep met a new plugin failure exits 1 after the tool moved, and one with a held failure exits 0" (`update.test.ts`).
- Doctor is ok at the newest release: "with the old and the renamed entry listed, doctor reads the newest one and is ok once it is at the newest release and the old one is gone", plus the stale-copy warning and the recorded-failure row (`doctor.test.ts`).

The chairman session's After-merge line (doctor on the agents host and the Mac shows the plugin at the newest release) is a live check: after the next `agent-org update` on each machine, `agent-org doctor` prints `ok herdr plugin devswha/herdr-web-ui: at v0.4.16, which is the newest release` and `herdr plugin list` shows one `devswha/herdr-web-ui` entry.

Acceptance:
```bash
npm run typecheck
npm run lint
STAND_IN="$(mktemp -d)"; printf '#!/bin/sh\nexit 0\n' > "$STAND_IN/tailscale"; chmod +x "$STAND_IN/tailscale"
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
PATH="$STAND_IN:$PATH" AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/herdr-upkeep.test.ts src/install/terminal.test.ts src/install/doctor.test.ts src/install/update.test.ts src/install/onboard.test.ts src/install/service.test.ts src/ticket-mode/pair-command.test.ts
STATUS=$?; rm -rf "${STAND_IN:?}" "${P:?}"; exit $STATUS
```

Consumer-declaration: none -- `failed` is an optional key of `herdr-status.json` entries, which only `doctor` and `update` read, and a status file without it is still valid; no host file key changes meaning.
