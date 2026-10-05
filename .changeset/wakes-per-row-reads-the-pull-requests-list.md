---
"agent-org": patch
---

`wakes-per-row` reads the merged pull requests of its window from the REST pull-requests list (a11ign/a11ign#3692), through the reader `trace` already uses (`listMergedPulls`), not the search API through `gh api --paginate`, which is 30 calls a minute per user, one call per page in one unpaced burst, and cut at 1,000 results without saying so. `readMergedPulls` keeps its signature and takes the reader as an optional third argument, so its cases run with no GitHub. A window the list cannot finish in its 30 pages is refused, and the refusal names `--from` (this tool's flag) where the reader's own message names `--since`.
