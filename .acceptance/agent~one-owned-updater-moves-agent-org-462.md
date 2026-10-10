`agent-org agent-tool:update` is the one owner of a version move for Codex (the CLI and the app-server daemon) and Claude Code. It reads the three installed versions, picks one target per tool, moves only the tools that are behind, smoke-starts a Codex reviewer and a Claude worker headless after the move, and REVERTS a move whose smoke stopped on a dialog, with one `tool-drift-interactive-prompt` incident naming the tool, both versions and the pane text. `host:check`'s existing `CODEX CLIENT AND DAEMON DISAGREE` finding now names this command as the owner.

Closes a11ign/agent-org#462

## What changes, and why

- **`src/agent-tool-update.ts` (new).** A flow of pure decisions over injected seams (`Deps`): read installed, pick targets (a tool with no readable target is named `NO TARGET`, never guessed), plan, pin the daemon's own update loop off, refuse while a seat is mid-turn (unless `--let-finish=<session,...>` names the sessions to wait for, bounded), move each tool and read it back, smoke, then keep or revert (all touched tools, reverse order, read back). One line is printed (`agent-tool:update: ...`) and the exit is non-zero for anything but a kept, proven move or an at-target run.
- **Smoke verdicts.** `prompt` (kept), `dialog` (reverted, one incident), `not-ready` / `unrun` / `unread` (UNPROVEN: kept, exit 1, not reverted, because a reviewer that did not start is not a reviewer that stopped on a dialog). The smoke starts the pane through `herdr agent start` in a throwaway workspace and always closes it.
- **A revert that fails is named.** A tool whose revert threw, or whose read-back still shows the new version, is on the line by name with the version it was wanted back at, and the exit is 1.
- **`src/commands.ts`:** one entry, `agent-tool:update`.
- **`src/codex-drift.ts` (outside the Region, one sentence):** the existing finding's detail names `agent-org agent-tool:update` as the owner of a version move. No second finding.

## Why a revert is allowed here

The chairman's 2026-09-24 ruling, "fix forward, never revert", is about CODE: a commit that is reverted loses its history and hides the defect it carried. This row's direction is newer and specific to TOOL INSTALLS. A tool version is not a commit: the previous release is still on disk (`~/.codex/packages/*/releases/<ver>`, `~/.local/share/claude/versions/<ver>`), putting it back is one symlink flip, and a seat stopped on a dialog costs a session every wake until it is. The incident (not the revert) is the record: it is written before the line is printed, so the failed move is not hidden. A smoke that could not run is never a reason to revert (`unrun`/`unread` keep the move and exit 1), so a revert is never a guess.

## Platform first, deleting first

platform: n/a for the move itself (Codex and Claude Code have no managed-fleet update channel that smoke-starts and reverts; the daemon's own `pid-update-loop` is what this replaces as owner, see below). Net lines: positive, a new module and its test; nothing it replaces. The `host:check` finding already exists (#461) and is not duplicated.

## What stops the daemon updating itself (MEASURED vs not)

- **Measured:** the loop is the `pid-update-loop` process of `codex app-server daemon`; it wrote 25 `package_selected` entries in its log, all `0.162.1`, spaced 3600 s apart (the row's "300 seconds" is not the cadence on this host).
- **Measured:** `~/.codex/app-server-daemon/settings.json` with `{"updater":{"autoUpdateEnabled":false}}` is RECOGNISED by Codex: in a scratch `CODEX_HOME`, `codex doctor` reports `automatic updates disabled (configured)`. On this host the file does not exist, so the default (ON) applies; the `--check` line below says so.
- **Unmeasured:** whether the RUNNING loop re-reads that file without a restart, and whether a move by the loop mid-run would be seen. The command writes the key (merge, idempotent, a non-object refuses) before it moves anything and says on its line when the loop cannot be switched off; it does not kill the loop's process.
- **Measured, as an absence:** no other off-switch was found in the daemon's own subcommands and settings; a search that found nothing is not proof there is none.

## How you verified it

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/agent-tool-update.test.ts src/codex-drift.test.ts
VERDICT pass: 35 tests in 2 files
```

The new file is 24 cases: a kept move; a dialog on the reviewer reverts with ONE incident naming both versions and the pane text (negative control: the same run with the dialog absent keeps the move and writes none); the real ledger line, written once for the same episode; a worker dialog reverts Claude; an at-target tool is not touched (plus a one-behind control); a revert that throws or has no effect is named; a move refused while a seat is mid-turn, waited for when named with `--let-finish`, refused after the bound when it never finishes; an installer that has no effect is `move-failed` with no smoke and no incident; an unproven smoke is kept with exit 1; `--check` writes nothing; the dialog reader; the live seams on a scratch `HOME` (daemon pin merge, symlink flips, target reads, the smoke always closes its workspace); the command is registered; `host:check`'s finding names the owner once.

LIVE, READ ONLY, this host, this branch (nothing moved):

```
$ node src/agent-tool-update.ts --check --session=worker-agent-org-462
agent-tool:update: would move codex-cli 0.157.0->0.162.1 (read only; the daemon's own update loop: ON (/home/agent/.codex/app-server-daemon/settings.json is missing, which is the default); a run switches it off).
exit=0
```

The CLI is 0.157.0, the daemon 0.162.1, Claude Code 2.1.296 (at target). **A real move was not run from this unmerged branch**: the live move path (`codex update`, `codex app-server daemon update --from-cli --yes`, the revert flips) and the live smoke start are UNMEASURED on this host until the post-merge run, which is the gate's or a new row's, and is posted on the row.

`src/packaging/acceptance-commands.test.ts` fails at import here (`AGENT_ORG_HOST` unset): environmental, not this diff's.

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-462 && npx rstest run --config scripts/rstest/rstest.config.ts src/agent-tool-update.test.ts'`

Mutation: ten, each restored byte-identical (`diff` of a copy in the scratchpad, never `git checkout --`), each turns its own test red. Never revert a failed move -> 4 red; always revert (also a proven move) -> 4 red; the dialog verdict ignored -> 6 red; every tool touched, including one at target -> 6 red; a failed revert reported as success -> 2 red; the busy refusal dropped -> 2 red; `--let-finish` that does not wait -> 2 red; the move not read back -> 1 red. The finding's owner sentence dropped -> 1 red; the owner misnamed -> 1 red. Both directions of the revert guard (never / always) and of the busy guard (dropped / the wait skipped) are among them.

Outside-Region: src/codex-drift.ts — the one finding that already says the CLI and the daemon disagree; its detail is where `host:check` names the owner (row item 4), and the finding is not duplicated.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
