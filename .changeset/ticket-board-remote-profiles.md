---
"agent-org": minor
---

The ticket board can show other machines' boards over SSH. A profiles file, `~/.config/agent-org/profiles.json` (or under `$XDG_CONFIG_HOME`), names this board as `{ "local": true }` and each other machine by its ssh target, and the header gains a switcher. The local board reads a remote board's port, key and terminal address with the new `agent-org ticket:remote-info` over ssh, holds an `ssh -N` tunnel to it with BatchMode and no TTY, reopens it when it drops, and passes a paired browser's `/p/<profile>/api/...` calls through it with the remote's own `Host` and the key in `x-ticket-token`. The key stays in memory. Open terminal on a remote run goes through the same connection. With no profiles file the board is unchanged.
