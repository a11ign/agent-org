---
"agent-org": patch
---

The hand-fix ledger no longer counts a dependency bot's pull request as a hand fix (a11ign/agent-org#560). `classifyLogin` returned `"human"` for any login in neither `ORG_LOGINS` nor `AUTOMATION_LOGINS`, so every Dependabot bump was `counted`/`derived` and the `hand-reroute` failure class read repeated on a population that is not one (23 of 30 refs measured 2026-10-09). A login `DEPENDENCY_BOT_LOGIN` matches (`app/dependabot`, `dependabot[bot]`, Renovate in both spellings) is now `automation`, read from the one definition in `src/dependency-bot-login.ts`. A person's commit, a declared `Hand-fix:` line and a login that merely contains a bot's name are counted as before.
