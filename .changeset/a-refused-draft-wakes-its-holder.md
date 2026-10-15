---
"@a11ign/agent-org": patch
---

A draft pull request refused at its current head now wakes its holder, as an undrafted refusal does (agent-org#958, split from a11ign/a11ign#5036). `reviewBlocked` read `mergeCandidates`, which drops every draft, so a draft a reviewer refused (CHANGES_REQUESTED) at its head was in no order while the same refusal on an undrafted pull request woke its holder. The draft is admitted only at the head it has now: a draft with no verdict stays `draft-awaiting-verdict`'s, a refusal at an older head stays outside the cause, and red, held and conflicting drafts stay excluded.
