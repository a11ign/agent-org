---
"agent-org": minor
---

`agent-org onboard --profile <name>` sets up a fresh machine from a saved answer file, which holds no secret: the provider blocks, the repositories, the conventions plugin (added from its repository and installed for every session), the worker and review notes, the reviewer's GitHub App, and the exposure. It asks only for the Linear key and the reviewer App's private key. Doctor checks Codex under the atomic reviewer. The hand-set `gh-wrapper-watchdog` and the herdr `KillMode` drop-in are retired on Linux once their replacements are proven, and doctor no longer advises `KillMode=process`. `agent-org update` refreshes the conventions plugin.
