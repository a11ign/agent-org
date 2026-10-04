---
"agent-org": patch
---

A request alert reaches the chairman as a brief and not as a ticket with a header: the message opens with `What is happening:` and carries `Ask`, `Only you because`, `Checked`, `How long` and `Unblocks`, the row's number and title appear nowhere in it, and the link is its last line. A brief that offers options (a `chairman-options` block, well-formed or not) must also carry `Recommend` and `Trade-off`; one that offers none must carry `Not the chairman's Claude session because`. A brief missing a required line is refused as before (`alert not sent:`, naming each missing label, logged once). The ledger's `text` field now holds the message as sent, link included (a11ign/a11ign#3412).
