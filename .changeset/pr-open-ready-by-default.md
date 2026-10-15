---
"@a11ign/agent-org": patch
---

`pr:open create` opens every pull request ready and armed unless `--draft` is passed (a11ign/a11ign#4968). The wrapper never added `--draft`; the product-PR draft was a convention, and the `armAfterCreate` comment and three tests now say and pin it.
