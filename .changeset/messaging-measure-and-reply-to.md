---
"agent-org": minor
---

`messaging:measure` reads how fast the org acknowledges and answers the chairman from the delivery ledger, for a window (`--window=<n>h`, default 24h): per message from the chairman, seconds to acknowledge and seconds to the first reply that names it (or `unanswered`), and asks sent, answered by the chairman, withdrawn (cleared with no answer before it) and refused by the brief rule. It writes nothing and judges nothing; a window with no lines prints `no messages in the window`, never a zero rate. `chairman:reply --to <messageRef>` (the flag was `--reply-to`) now refuses a ref no inbound ledger line holds, so a reply's `replyTo` always names a message that exists; without it `replyTo` is still `null`, and such a reply answers no message in the reading.
