---
"agent-org": minor
---

The daily retrospective counts the `ready` rows that have made no tier decision. `src/untiered-ready-rows.ts` reads the open `ready` rows of every declared tracker and counts those carrying neither the `tier:haiku` label nor a line opening `Tier: sonnet -- <reason>` (outside a code fence, in the body or any comment, with a non-empty reason); a row that is `lane:ceo`, `lane:orchestrator`, `needs:chairman` or `hold:*` and has no decision is listed apart and not counted. `org-retro.ts` prints the count and the first ten row names. A tracker that cannot be listed, a list at its limit, a row with no labels or comments field, or no declared tracker makes the number `unknown`, never 0. The direction of 2026-10-09 08:45Z ("every mechanical row with a machine-checkable Acceptance is `tier:haiku`, including rows already ready and not yet claimed") ran 80 minutes unexecuted because nothing counted it. a11ign/agent-org#466; epic a11ign/a11ign#4437, move 4.
