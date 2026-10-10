---
"agent-org": minor
---

The gate arms a lone unarmed pull request itself, and `product-manager` is woken for `pr-green-unarmed` only when every candidate is unarmed or the gate could not arm what it tried. `settleUnarmedPrs` (`src/work-gate.ts`) reads the fork from the count the gate already holds (`readArming` returns the candidates that are armed beside the unarmed ones): one unarmed candidate, or several beside an armed one, is armed through the code-host port's `armMerge` (`arm-pr`'s own command, read back from the pull request's state) and recorded as one `postDecision` on the pull request; several unarmed and none armed is the credential-outage arm, where the gate arms nothing and the order goes out with the count in it. A pull request the gate could not arm stays in the order with what it saw. `A11IGN_PR_GREEN_UNARMED_BY_GATE=off` in the tick's environment restores today's order, with no write. a11ign/agent-org#488.
