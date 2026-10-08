---
"agent-org": patch
---

The board-truth audit asks an eighth question, `parked-on-the-chairman` (a11ign/a11ign#4201, `ceo`'s class fix A: a wait on the chairman is never a date). An open `parked` row without `needs:chairman` whose `Blocked-on:` line names the chairman is a finding for `product-manager`, whatever `Not-before:` or other wait it carries: #4159 sat parked behind a date while its line said the chairman's session had to mint a token, and `parked-without-condition` could not see it because the date is a condition. A `Waiting-for: labelled needs:chairman #n` line is a data wait and is not flagged.
