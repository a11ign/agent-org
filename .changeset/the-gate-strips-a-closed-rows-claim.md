---
"agent-org": patch
---

The work gate takes the claim labels (`in-progress`, `started`, `session:*`) off a CLOSED row whose `session:` holder herdr does not list. The close path strips only a close it drives itself, so a row closed by hand, as not planned, or by a `Closes` GitHub resolved with another actor kept its claim for ever. The gate reads the closed rows carrying `in-progress` (one call, labels only), compares each holder with the herdr listing it already reads (and only a complete one), and strips through the close path's own decision; a row whose holder is listed is named on stderr and left alone. `labelsToStrip` and the strip itself move to the leaf `claim-label-strip.mjs`, which `close-rows-for-merged-pr.mjs` re-exports, so the gate need not import the close path. a11ign/a11ign#3883.
