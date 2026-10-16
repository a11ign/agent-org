---
"agent-org": patch
---

`declaredIdentities` reads the workers' and leads' accounts from their `gh` config directories (`<dir>/gh`), as the `gh` wrapper and `declaredGhAccount` do. It read the bare `<dir>`, which holds no `hosts.yml`, so `a11ign-ai-workers` was never declared. Every pull request a worker opened as that account (the wrapper falls back to it when an App token cannot be minted) was reviewed as a stranger's: read-only, its Acceptance never run, and its not-convinced verdict waking no session. agent-org#1615 and #1663 were stalled that way.
