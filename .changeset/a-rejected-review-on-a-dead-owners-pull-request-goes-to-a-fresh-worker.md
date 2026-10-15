---
"agent-org": patch
---

With `prs.ownerRouting` on, a refusal (`pr-review-blocked`) on a pull request whose owner has ended (`owner-gone`) is ordered to the `engineers` pool, not to the ended `session:` label and not to `product-manager`. The prompt says the worker is fresh, names the branch, and carries the refusing review's words. The flag off, every order is unchanged (agent-org#1370, builds on #1325).
