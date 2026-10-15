---
"@a11ign/agent-org": patch
---

A `release:*` announcement is no longer read as asking the chairman: a `?` at the end of a line, a `needs:chairman` or `answer:` label, and the word "reply" in its notes do not hold it back or flag it in the audit (a11ign/agent-org#1388). A release that quotes a change log, such as the v0.196.1 notes, was refused by the audience guard for those words. `announcementAsks(key, text)` in `src/messaging/audit.ts` is the one predicate, read by the delivery guard and the audit detector alike. Every other announcement kind is still read for all three checks, so a `milestone` or `incident` that asks is still refused.
