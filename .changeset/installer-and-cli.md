---
"agent-org": minor
---

agent-org installs with one command, `curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash`, which clones the newest release tag (or `--version vX.Y.Z`) into `~/.agent-org/agent-org` and writes an `agent-org` launcher into `~/.local/bin`. Six new commands run the install: `onboard` writes the host file and starts the instance service, `doctor` checks the install and prints a fix for each failure, `start`, `stop` and `status` run a service (`instance` or `ui`) under launchd or systemd, and `update` moves to the newest release and restarts each service that was running.
