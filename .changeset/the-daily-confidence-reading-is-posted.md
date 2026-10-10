---
"agent-org": patch
---

`node src/decision-confidence-post.ts` posts the day's provider-confidence reading once, as an ANNOUNCEMENT: through the messenger to the announcements channel when `messaging.announcementsFile` is declared, to the chairman chat when only that is configured, and as one comment on a11ign/a11ign#4627 when no messaging is configured at all. It carries, per use and question, the decisions asked, the share under the floor, the mean and median, and the questions over #4750's line (more than 30% under the floor on at least 20 decisions); it asks the chairman nothing and has no question mark in it. One post per UTC day: the ledger dedupes the messenger's key and the epic's day marker is asked for before a comment is made. With no provider declared it posts nothing and prints nothing. A host declaration or messaging configuration that cannot be read exits 2 `CANNOT POST` and is never taken for "none". a11ign/a11ign#4755, use 1 and 2 of a11ign/a11ign#4627.
