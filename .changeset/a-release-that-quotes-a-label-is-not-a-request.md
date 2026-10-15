---
"@a11ign/agent-org": patch
---

A release announcement that quotes a label name, such as "once its answer:ceo is removed", is no longer filed as `messaging-audience-misuse` (a11ign/agent-org#999). The audience audit read the `answer:` and `needs:chairman` markers in every announcement, so the two release lines the ledger holds as false flags were counted as asking the chairman. A release now has no label markers read against it (`markersOf` in `src/messaging/audit.ts`); its question mark and the word "reply" still count, and a non-release announcement is checked for every marker as before.
