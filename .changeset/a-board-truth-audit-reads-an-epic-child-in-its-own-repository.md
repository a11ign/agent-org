---
"agent-org": patch
---

The board-truth audit reads each child of an all-closed epic through the ticket port scoped to the child's own repository. An epic in one repository whose children are in another was UNREAD on every tick, because the epic's port answers only for its own scope, so `outcome-closed-by-non-build-row` was never asked (a11ign/agent-org#1564). A child that still cannot be read leaves the question UNREAD, and the digest now names what failed and which child, where it named only the question before.
