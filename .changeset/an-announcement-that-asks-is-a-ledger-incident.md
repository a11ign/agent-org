---
"agent-org": minor
---

The messaging audit (`src/messaging/audit.ts`, a11ign/a11ign#4746, row 4 of 5 of #928). An announcement that asks the chairman something (a line ending in `?`, a `needs:chairman` or `answer:` marker, or the word "reply") and an ask with no row or no record are each a failure-ledger entry of class `messaging-audience-misuse`, naming the message ref and which half failed (`announcement-question`, `ask-row`, `ask-record`) and quoting at most 80 characters, redacted. `auditMessaging` reads only the ledger lines past a cursor (the first run baselines, so asks sent before #4745 are not incidents), writes nothing twice, and prints `messaging audit: n checked, m flagged`. The tick's call to it is a follow-up row: `failure-recorders.ts` is outside this row's Region.
