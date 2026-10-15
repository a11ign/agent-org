---
"@a11ign/agent-org": patch
---

`src/due-index.ts` (new, not yet called) is the index a dated wait's instant lives in, so a repository with no event is still seen when a `Not-before:`, `Fleet-hold-until:` or aged-backlog instant passes between two ticks. `writeDueIndex` replaces one repository's entries and keeps the others', `readDueIndex` returns an empty index for a missing file and `null` with a reason for a corrupt one (a caller treats that as "everything may be due"), and `dueRepos` names the repositories with an instant after the previous tick and not after now. a11ign/agent-org#994, part of a11ign/a11ign#5043.
