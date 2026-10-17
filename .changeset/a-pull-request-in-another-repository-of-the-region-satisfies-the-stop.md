---
"agent-org": patch
---

The stop hook reads the row's `## Region` when the row's own tracker has no pull request of the row, and asks the code repositories the Region names for one. A pull request there that closes the row by its reference (`Closes a11ign/agent-org#N`) satisfies the stop, where it was refused, because only the tracker's repository was read (agent-org#1713). A repository the Region does not name is never read. An unreadable Region or repository is a said allowance (UNREAD), never a refusal, and writes no ledger line. The row's own pull request is now also matched by the `Closes` reference, not only by its branch, suffix or title.
