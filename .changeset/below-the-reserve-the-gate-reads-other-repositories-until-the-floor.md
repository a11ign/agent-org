---
"agent-org": patch
---

Below `GRAPHQL_RESERVE` (1000) a paced gate tick skips the org-health reads only, and keeps reading the other repositories' open pull requests until the new `GRAPHQL_FLOOR` (500); below the floor it skips both, as before. Before, the reserve dropped the two together, so a settled-green pull request in another repository got no reviewer order for ~20 minutes each hour (a11ign/agent-org#1417). `Pacing` carries `belowFloor` beside `paced`, and a skipped lane is still reported unread, never clean. The floor is a judgement (half the reserve), not a measurement of one tick's cost.
