---
"agent-org": minor
---

Ticket mode's Pick view filters by label group. The source port carries each ticket's labels with their group (`labels` on `Ticket` in `src/ticket-mode/source.ts`, optional, so a tracker without labels needs nothing), and Linear reads them, with each label's parent, in the same Pick request. Pick shows one row of chips for each label group among the listed tickets, named after the group (a "Goal" group gets a "Goal" row), plus a "Labels" row for labels in no group when there are any; each works like the Projects row (All, several at once, AND across rows), is remembered in the browser, and offers "(no <group>)" for the tickets not yet labelled. Each ticket row shows its group labels as small tags. The decisions are pure functions in `src/ticket-mode/label-filters.ts`, which the board's page service sends as `/label-filters.js`.
