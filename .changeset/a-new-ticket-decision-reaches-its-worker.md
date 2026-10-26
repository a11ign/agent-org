---
"agent-org": patch
---

A decision added to a ticket's Decisions while its pull requests are open now reaches the worker. The board starts a review round for a finished run whose ticket gained a Decisions line it was not briefed with, without anyone pressing Respond, and the round counts toward no cap. Every review round's brief, whatever started it, opens with a section "The ticket's Decisions changed": the changed lines and "make the pull requests meet them, or reply quoting why they already do". The Stop hook refuses a `reviewed` that pushed nothing and whose final message does not quote the new lines and say why the pull requests meet them. The "a person merges it" card for a merge flow's first install waits while a ticket has Decisions no round has answered (A11-305).
