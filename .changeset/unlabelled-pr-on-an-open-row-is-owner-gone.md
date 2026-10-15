---
"@a11ign/agent-org": patch
---

An unlabelled pull request whose branch or closing reference names an open row nobody holds is owned by `product-manager` as `owner-gone`, not recorded `owner-unresolved` (a11ign/agent-org#1136, a11ign#5201). `rowsNobodyHolds` now runs for any pull request no row rung answered, labelled or not, so the tenth such PR routes like a dead owner's. A pull request that names no row still falls to `ceo` and is still recorded. The order for an unlabelled pull request says it carries no `session:` label, never "ENDED".
