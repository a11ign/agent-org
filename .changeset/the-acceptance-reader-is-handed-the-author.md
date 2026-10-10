---
"agent-org": patch
---

The acceptance reader is handed the pull request's author and changes no verdict by it. `resolveAcceptanceSource` takes an optional `author`, `BodyReportInput` and `acceptanceSourceOfThisPullRequest(body, cwd, author?)` carry it, and the CLI entry reads it from `PR_AUTHOR` (`prAuthorFromEnv`: unset or empty is `undefined`, never argv, never the body, a label or a branch name). agent-org#519 builds the narrow exemption on this. agent-org#666.
