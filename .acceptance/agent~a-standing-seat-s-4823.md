A `claude` started in a standing seat's herdr workspace, other than `ceo`'s, is given `--settings '{"autoMemoryEnabled":false}'` by a wrapper installed ahead of the real binary on PATH, so the flag survives herdr restoring the seat as a bare `claude --resume <id>`.

Closes a11ign/a11ign#4823

## What changes, and why

- **`host/claude`** (new): routes by `HERDR_WORKSPACE_ID` as `host/gh` does, takes the seat's NAME from herdr's own label for that workspace (`herdr workspace get`, 5 s, never a guess) and appends the flag when the label is in the seat list; otherwise it execs the real binary unchanged. A call that already names `--settings` (a spawned worker's, from `agentArgs`) is passed through with exactly one and costs herdr no question; so is one whose first argument is not a flag (`update`, `mcp`) or that holds `--`.
- **`src/host-units.ts`**: `claude` joins `TOOL_ENTRIES`; the wrapper is rendered with the seat list read from the roster (`autoMemorySeatLabels`: live, not `spare`, not a family, minus `ceo`; unreadable is `null` and the install refuses, a project declaring no `roles` is `[]`), and is an owned file installed in `~/.opencode/bin`. `seatWrapperNotes` is a `host:check` NOTE when `zsh -c 'command -v claude'` is anything but the wrapper.
- **Tests**: the new `host-install-claude-wrapper.test.ts` RUNS the wrapper (the row's Acceptance, and it imports nothing of the tool); the roster, the install, `host:check` and the note are eight `#4823` tests at the end of `host-units.test.ts`, whose end-to-end install now leads its PATH with the wrapper's directory and reads the note before and after; `host-project-paths.test.ts`'s three pins move with the shipped list (27 -> 28 entries, 30 -> 31 files, the owned list).

## Where it is installed, and why not the other places

`~/.local/bin/claude` is a symlink into `~/.local/share/claude/versions/<v>` which the CLI's self-update rewrites, so a wrapper AT that path is replaced by the next update. The first directory on a pane's PATH is `~/.opencode/bin` (`~/.zshenv` prepends it last), which nothing rewrites, and the wrapper execs `~/.local/bin/claude`, so an update is followed. `host:install` does not edit `~/.zshenv`; the note says when the directory is not first.

## The smaller change the row allowed, and why it is not this one

The binary reads `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (measured in 2.1.296: `process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`, truthy -> memory `off`), and `~/.zshenv` already sets `CLAUDE_CODE_PROMPT_CACHE_TTL` by workspace id the same way. It would be a three-line edit to a person's dotfile and nothing tracked, tested or compared by `host:check`; the row's Acceptance pins the wrapper's argv, and the wrapper's `--settings` shows in `ps` where an environment variable does not. If `ceo` prefers the variable, the wrapper's seat list and this row's test are what to delete.

## Two things the row did not say

- **The seat list is the roster's, not `host.json`'s leads list.** `gh.leadsWorkspaces` names three workspaces (w6 w2 w5) and the fourth seat herdr restored, `liaison` (w190), is in no host file; workspace ids are not in the roster on purpose (`_rolesNotProcesses`). So the seat is the herdr label, which the roster's `name` is.
- **`host-project-paths.test.ts` pins the shipped list too** and is not in the row's Region; its three assertions move with the 28th entry and are a separate commit.

## How you verified it

- Acceptance (below): 9 pass.
- Live, read-only, against this host's real herdr and the real roster: the rendered wrapper's `SEATS=product-manager orchestrator liaison`; run with a stub binary, `HERDR_WORKSPACE_ID` w2, w5 and w190 got `--settings {"autoMemoryEnabled":false}`, w6 (`ceo`) and this worker's w373 did not, `update` was untouched; 0.11 s per call. Run with the real `claude`, `--version --settings {...}` prints `2.1.296 (Claude Code)`.
- `host-units.test.ts` 165 pass (eight of them new), `host-project-paths.test.ts` 13 pass, `host-install-agent-org-launcher.test.ts` 6 pass; `rstest run --changed=origin/main` with `AGENT_ORG_HOST` set: `VERDICT pass: 765 tests in 13 files`. (A first run failed `work-gate.test.ts`'s history-population ratchet, because the new test imported `host-units.ts`; the roster and install tests moved into `host-units.test.ts`, which is already declared, rather than declare another file.)
- `tsc --noEmit`: only the two `mjs-ratchet.test.ts` missing-module errors, which `origin/main` has too.
- NOT done: the wrapper is not installed on the host from here (Done-when 1 is `host:install` after the release), and no seat was restarted (Done-when 2 is read off the next restore).

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/packaging/host-install-claude-wrapper.test.ts`

Mutation: (the wrapper, in the acceptance file) the flag never appended -> 2 red (the seat test, the bare-launch test); the seat check removed so it always appends -> 4 red (the `ceo` control, the worker, the herdr-failure case, argv[0]); a named `--settings` no longer passed through -> 1 red (the worker); a non-flag first argument not exempt -> 1 red; the self-exec guard removed -> 1 red (it loops until the test's timeout); (the roster and install, in `host-units.test.ts`) `spare` entries kept in the seat list -> 1 red; `ceo` kept in it -> 2 red; an unreadable roster read as `[]` -> 2 red; a declaration with no `roles` read as unreadable -> 1 red; a fixture that moved `scriptDir` made to own the real home's wrapper -> 1 red; the shadowing note always silent -> 1 red, always firing -> 1 red.
