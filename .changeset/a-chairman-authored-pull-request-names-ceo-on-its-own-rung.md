---
"@a11ign/agent-org": patch
---

`ownerOfPr` gains a `chairman-author` rung before its `ceo` fallback: a pull request the chairman opened, with no live session label, no row owner, no branch owner and no stamp, names `ceo` with `source: "chairman-author"` instead of falling off the ladder, so `owner-unresolved` stops recording a correct address as "nobody could be named" (a11ign/a11ign#5041, the seventh occurrence). It reads `CHAIRMAN_LOGINS` only: the worker account, any other person and an unlabelled agent PR still reach `ceo`'s last rung and are still recorded. The stalled-PR, not-convinced, rebase and shared-file orders say "the chairman opened it" for it, not "its label names you". a11ign/agent-org#950.
