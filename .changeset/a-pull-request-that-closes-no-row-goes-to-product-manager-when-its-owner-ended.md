---
"@a11ign/agent-org": patch
---

A pull request whose owner session has ENDED and which names no row (`Closes: none`) is now ordered to `product-manager` as `owner-gone`, not to `ceo` as owner-unresolved. The ladder's owner-gone rung read only the rows a PR names, and a PR that names none gave it nothing to decide on, so the PR fell through to `ceo` and was recorded as an unresolved owner. The order now says the owner ended and that the PR closes no row. A live label, an unlabelled PR and a PR whose rows could not be read keep their rungs as before. a11ign/a11ign#5115; a11ign/agent-org#1020.
