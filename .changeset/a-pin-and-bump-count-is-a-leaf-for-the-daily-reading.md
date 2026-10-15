---
"@a11ign/agent-org": patch
---

The daily reading's count of hand-filed pin or bump rows and of stuck Renovate PRs (`src/pin-bump-measure.ts`) is a pure leaf that reads nothing, and a refused read is `unknown`, never 0. Nothing calls it yet; its wiring behind a default-OFF flag is a separate row (agent-org#1172).
