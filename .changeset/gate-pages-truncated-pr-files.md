---
"agent-org": patch
---

The gate compares a row with the whole of a pull request of more than 100 files instead of dropping it: `gh pr list --json files` returns the first 100 and `comparablePrFiles` refuses a short list, so a row overlapping the 146-file version PR was offered every tick and refused at the spawn (30 ticks, 2026-10-03). `readPrs` now pages a truncated PR's files through REST, as the claim does, caches the list by PR number and head sha in the state directory (`truncated-pr-files.json`, newest 20), and, when paging fails, leaves the PR out of the comparison as before and says so on stderr.
