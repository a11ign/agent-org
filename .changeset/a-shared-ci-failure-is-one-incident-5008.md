---
"@a11ign/agent-org": patch
---

A CI failure shared by two or more open pull requests (same failing check, step and first error line) is held at the gate instead of waking each worker, and is filed or joined as ONE `ci-shared-failure` incident row listing the PRs. When the PR closing that row merges, every noted PR that is still open and behind is updated through `PUT /pulls/{n}/update-branch`; a refused update (a conflict) is written to the row as `Refresh-failed:` and that PR's worker gets its order again. An unnoted PR whose check went red before the merge and is still unrefreshed 10 minutes after it is refreshed too. A PR's own failure, a hung check, an ejection and a refused log read still wake as before. a11ign/a11ign#5008.
