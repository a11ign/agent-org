---
"agent-org": minor
---

The ticket board's settings are grouped into named provider blocks under `tickets.providers`: `tracker` (linear), `codeHost` (github), `publish` (slack or none), `reviewer` (atomic or none) and `exposure` (local or tailscale). Each block reads only its own settings, and a block left out takes its provider's default, which doctor says. The old keys still work for one release, as aliases: doctor names the place each one moves to, and `agent-org doctor --fix` moves them, keeps a backup of the host file beside it, and writes nothing unless the moved file reads the same settings. The Settings page edits a provider's values; a provider is chosen through `agent-org onboard`.
