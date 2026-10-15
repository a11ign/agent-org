---
"@a11ign/agent-org": patch
---

An Acceptance that `cd`s into the clone of the repository the row is built in is refused at filing, as #4322 refuses the primary checkout (a11ign/agent-org#852). A row filed into a second tracker (agent-org's own, which `row-file` files org rows by) lands its pull request in that repository, and its Acceptance runs in that clone's primary checkout, which carries the change only after the merge. `builtInCheckoutOf` (`src/built-in-checkout.ts`) takes the tracker `rowTracker` picks off the Region and reads its clone from the host's `clones.<key>`; `primaryCheckoutCdReason` refuses a `cd` into that clone and names it. The home tracker has no such clone, and a host that names none or cannot be read is `cannot tell`, so the check is skipped rather than passed. A `Hand-run:` body is exempt as before.
