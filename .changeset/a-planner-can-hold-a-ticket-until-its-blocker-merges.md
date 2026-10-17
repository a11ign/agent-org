---
"agent-org": minor
---

A batch planner can say a ticket waits for its blocker to merge rather than stacking on the blocker's open pull request: `"wait": "merged"` beside `after` in its `order.json` entry. The ticket stays Blocked, and the board says "Waits for NBF-1 to merge", until the blocker's pull request merges, then it starts on the default branch. Without the field a ticket stacks as before (`"wait": "stacked"` says so explicitly), and any other value refuses the whole order. The batch planner's brief says when to choose each: stacking for code that builds on the blocker's diff, merged for work that needs the blocker's change live. A11-77, after the board started A11-44 on a blocker's open pull request its plan said to wait for.
