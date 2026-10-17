---
"agent-org": minor
---

`agent-org onboard` now makes ticket mode work out of the box on a new macOS or Linux machine. Each of these steps was done by hand on the agents host on 2026-10-17:

- **Web terminal (A11-66).** Onboard installs bun into `~/.bun/bin` when the machine has none. It downloads the release zip and reads it with node's `zlib`, so it needs no `unzip` and no `sudo`. It installs the herdr plugin `devswha/herdr-web-ui`, writes `tickets.terminal` when that key is absent, and starts a new `terminal` service. The service runs the plugin's supervisor on `127.0.0.1` for `tickets.herdrSession`, as a launchd agent or a systemd user unit. It sets `HERDR_SOCKET`, which is the variable the plugin reads.
- **Linear for workers (A11-71).** With a readable key, onboard registers Linear's MCP for Claude Code at user scope, authenticated by the key. It adds Linear's read and comment tools to `tickets.connectors`. The key is never printed.
- **Host file without `AGENT_ORG_HOST` (A11-68).** Onboard records the host file's path in `<home>/host-file`. Every command looks for the host file in this order: `$AGENT_ORG_HOST`, the recorded path, the instance unit's `AGENT_ORG_HOST`, then `<home>/host.json`. A `ticket:*` command is passed that host file, and the workers' `GH_CONFIG_DIR` from the host file. The instance, ui and auto-update units carry the same `GH_CONFIG_DIR`.
- **Auto-update.** A new `auto-update` service runs `agent-org update` every hour, as a systemd timer or a launchd interval job. Update still restarts the services only when the checkout moved. Opt out with `--no-auto-update` or `agent-org stop auto-update`. `--update-channel main` makes it follow `main`.
- **Bad unit settings (A11-67).** `doctor` and `status` report a systemd unit that loads as `bad-setting`, with the line `systemd-analyze verify` refused. `agent-org start` is the fix.
- **More doctor checks.** `doctor` also checks that `claude mcp list` shows `linear` connected, that the terminal answers `/api/health` on the port `tickets.terminal` names, and that auto-update is registered.
