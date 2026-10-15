---
"@a11ign/agent-org": patch
---

The stuck-claim report reads a keyed row's own worktree. `claimRefusalOf` looked at `wt-<number>` for every row, but a row of a keyed repository is claimed into `wt-<key>-<number>` (`wt-agent-org-724`), so its existing tree was never seen, the streak never started and `product-manager` was never told (agent-org#724: 69 `UNDELIVERED` lines in 3 hours, no `ready-row-unclaimable`). The name now follows `claimNames`, and a test pins the two and the refusal's words together. agent-org#819.
