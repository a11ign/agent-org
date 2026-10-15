---
"agent-org": patch
---

A reviewer instance no longer mints its GitHub App token itself, so the App's private key is not read from the reviewer's sandbox (agent-org#1348). Wake mints the `reviewer` token into the instance's token directory (`node_modules/.cache/app-tokens`) before the pane opens, through `app-token.ts` into a scratch directory that replaces the token only on success, and refreshes it on each tick once it has less than 30 minutes left. A spawn whose mint fails is refused with the reason, and no pane opens. A host that does not declare `reviewer` as a `github-apps` role mints nothing, as before. Outside reviewers get no token.
