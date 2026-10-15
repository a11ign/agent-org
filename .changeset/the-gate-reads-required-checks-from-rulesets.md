---
"@a11ign/agent-org": patch
---

The gate and the queue table read the required checks from the rulesets. Classic branch protection was deleted on every repository on 2026-10-11 and each `merge-queue-main` ruleset took over `required_status_checks`, so `requiredCheckNames` (`work-gate.ts`) and `requiredContexts` (`queue-table.ts`) read `branches/main`'s `protection` object, got `{"enabled": false, "contexts": []}`, and fell back to treating every check as blocking. Both now call one `readRequiredContexts`: it unions the contexts of every `required_status_checks` rule in `GET repos/{repo}/rules/branches/main` (readable with `pull`), and asks `branches/main`'s classic list only when no ruleset rule gave one. Unknown is still `null` and still fails open. A tick on a repository whose rulesets answer pays one call; one the rulesets do not cover pays two, and the `CANNOT READ the required checks` line now names both reads. a11ign/a11ign#5020.
