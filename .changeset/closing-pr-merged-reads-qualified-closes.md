---
"@a11ign/agent-org": patch
---

`closing-pr-merged` reads a `Closes owner/name#n` line, so a merged pull request that says `Closes a11ign/agent-org#1204` names that row while it is still open. Before, only the unqualified `Closes #n` was read, and a row whose PR had merged stayed open. A row number named by another repository never closes this tracker's row.
