## What it is

The `agent-org` a person types is now checked against the installed tool (`~/.agent-org/tool/current`). On 2026-10-25 an alias in `~/.zshrc` pointed at a v0.276.0 checkout while v0.304.1 was installed, and `agent-org update` run by hand ran that stale code and left the board without its UI build.

- `agent-org doctor` has an `agent-org command` row. It asks the login shell (`$SHELL -lic 'type agent-org'`, covering an alias, a function and a file on `PATH`), follows the answer to the copy of the tool it runs, and is **ok** only when that is the installed tool reached through `current` (the shim, or an alias or function naming `current/src/bin.ts`), or a checkout host.json names as `devTool` that is at least as new. Otherwise it **fails**, naming the file and line, the copy and its version against the installed one, and the exact fix.
- `agent-org command:check [--fix] [--ask]` is the same row; `--fix` comments the alias or function out under a marker (or replaces a file on `PATH`) with the installed shim, after keeping a copy of the whole file as `<file>.before-agent-org-<stamp>`.
- `install.sh` and `agent-org onboard` end by running that check and fix. Unattended they replace and say so; neither reports success while the shell's `agent-org` would run another copy. `onboard` writes the shim itself on a host that declares no project.
- `agent-org update`, `host:install` and `start` refuse (exit 2) to run from a copy that is not the installed tool and is older than it, naming the copy and the command to run; `--allow-older-copy` overrides.
- An org host's `agent-org` launcher now runs `<agent-org home>/tool/current`, as its services do.

The doc is `docs/installing-and-updating.md`.

## Acceptance

Each line of the ticket's Acceptance is proven by a named test: an alias to an old checkout fails doctor and names the line (`shell-command.test.ts`, `doctor.test.ts`); the shim passes (`shell-command.test.ts`, `launcher.test.ts`); `update` from an older copy refuses (`command-guard.test.ts`); an install on a machine with an alias to an old checkout ends with the shim in place and the alias line replaced and backed up (`install-sh-command.test.ts`).

Acceptance:
```bash
npm run typecheck
npm run lint
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/tool-copy.test.ts src/install/shell-command.test.ts src/install/command-guard.test.ts src/install/launcher.test.ts src/install/install-sh-command.test.ts src/install/install-sh.test.ts src/install/doctor.test.ts src/install/onboard.test.ts src/host-units/launcher-render.test.ts src/packaging/bin-commands.test.ts
```

Consumer-declaration: none -- `devTool` is an optional host-file key read only by doctor's new row, and a host file without it behaves as it did; no consuming repository's declaration needs a line.
