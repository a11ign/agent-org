`agent-org onboard` sets up what ticket mode needs on a new machine, with no step done by hand. Onboard installs bun when there is none. It installs herdr web ui, writes `tickets.terminal`, and starts the `terminal` service on `127.0.0.1` with `HERDR_SOCKET` naming the tickets session (A11-66). With the key readable, it registers Linear's MCP and allows its read and comment tools (A11-71). It records the host file, so a `ticket:*` command run with an empty environment reads the same host file and `gh` account as the services (A11-68). It registers an hourly `auto-update` service. `doctor` and `status` report a unit systemd loads as `bad-setting`, with the reason (A11-67). The tests stub `systemctl`, `launchctl`, `herdr`, `claude` and the network. The one child process is `node` running `ticket:remote-info` with an empty environment.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/bun.test.ts src/install/terminal.test.ts src/install/paths.test.ts src/install/service.test.ts src/install/onboard.test.ts src/install/doctor.test.ts src/install/update.test.ts src/packaging/bin-commands.test.ts
```

Consumer-declaration: none -- these are install commands (`onboard`, `doctor`, `start`, `stop`, `status`, `update`) and the `bin.ts` dispatch, which a person runs on their own machine. No project's declaration names them.
