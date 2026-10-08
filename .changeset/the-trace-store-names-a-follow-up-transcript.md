---
"agent-org": patch
---

The trace store and `wakes-per-row` name a transcript's session from a follow-up order's `[order:<wake id> session:<session> cause:<cause>]` header as well as the old "You are `<session>`" phrase, the earlier match winning (a11ign/a11ign#4083, found in #4068). Both used to keep their own copy of the old phrase, so a transcript whose only wake was a follow-up was unattributed once the header changed; they now import `token-audit`'s `sessionOf`.
