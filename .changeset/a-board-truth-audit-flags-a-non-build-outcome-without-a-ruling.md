---
"@a11ign/agent-org": patch
---

The board-truth audit reports a closed non-build child of an open epic whose children are all closed, when that child has no `Chairman-ruling: <url>` line whose URL is a comment by `DanBeckDev` (agent-org#881). A non-build child is a row titled `SPIKE`, `Decision` or `Measure`, or a row whose Region lies wholly under `docs/`. The finding is `outcome-closed-by-non-build-row`: it names the epic, the child and the missing field, with chairman-brief lines for `product-manager` to post, and the audit posts nothing to the chairman. The children are read through the ticket port (`TicketPort.readItem`, ADR 0046); a refused read, a child that cannot be read, or an epic with exactly the port's cap of 50 children is UNREAD, never agreement. The one comment-author read is a counted `gh api` call, the +1 on `docs/gh-call-baseline.json` for `src/board-truth-audit.ts`.
