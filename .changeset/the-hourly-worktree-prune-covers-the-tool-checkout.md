---
"@a11ign/agent-org": minor
---

The hourly worktree prune covers the agent-org checkout as well as the project's. Installed with a `tool`, the unit makes one pass over the tool's checkout and one over the project's, each named by the host's declaration, so the tool's own worktrees stop piling up toward the cap of 100 that refuses claims. The tool's pass is bounded at ten minutes and does not stop the project's pass if it fails or hangs. Each pass keeps its own per-run limit and every refusal, and `--force` is never passed.
