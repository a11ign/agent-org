---
"agent-org": patch
---

A refusal for a rate limit that names an installation (`for installation ID <n>`) while the GraphQL pool probe reads healthy now says "a secondary limit: the installation was refused while its pool reads N of M left", with the pool's count, where it said "another resource, search or secondary, which the message does not name" (#1523). The probe's count is the evidence for a secondary limit, so the line names it. An unreadable probe, and a refusal that names an account and no installation, keep their words.
