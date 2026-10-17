A person installs agent-org with one command, `install.sh` at the repository root, which clones the newest release tag (or `--version`) into `$AGENT_ORG_HOME/agent-org`, refuses a Node older than 24 with the way to get one, and writes the `agent-org` launcher into `~/.local/bin`. `onboard` writes the host file and starts the instance service without printing the Linear key (`src/install/onboard.ts`). `doctor` checks Node, the launcher, the host file, herdr, the key and the service, each with its fix (`src/install/doctor.ts`). `start`, `stop` and `status` run a service named `instance` or `ui` as a launchd user agent or a systemd user unit, and refuse a service whose command the table lacks (`src/install/service.ts`). `update` moves the checkout through `update-tool.ts`'s `updateTool`, or follows `main` with `--channel main`, and restarts only the services that were running (`src/install/update.ts`). `isPrimaryWorktree` moves to `src/lib/primary-worktree.ts`, so `update-tool.ts` imports no project-config chain.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install
```

Consumer-declaration: none -- six new commands and a new root script; no existing command, unit or host key changes what it does.
