---
"agent-org": patch
---

The failure ledger records a keyed repository's red `main` as a `main-red` event, as it already did the primary's (a11ign/a11ign#4475, move 1a of #4437). `scopeTick` now returns the `trunkRed` reading it already holds, `recordTickFailures` takes one per keyed scope (`keyedTrunkReds`) and turns each into a `main-red` line whose ref is the run's URL, which names the repository, so two repositories' reds are two refs and the same red run read on two ticks is one line. A green or unreadable `main` (`null`) and a scope with no code repository (`undefined`) append nothing, and the primary's line is unchanged. No second ask of GitHub: the reading is the one `otherScopeTicks` made for the scope's order.
