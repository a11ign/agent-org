---
"@a11ign/agent-org": patch
---

The gate no longer orders `ceo` to review a pipeline pull request (`pr-codeowner-review-missing`, a11ign/a11ign#5044 step 2). The cause asked for a review from the `a11ign-ai-leads` login, which is an App, and an App cannot be a code owner (a11ign/a11ign#4981), so that review could never be given. The owned-path check (`owned-path-signoff.ts`) is what answers for owned paths now. The cause name stays declared. Its files were keyed by repository and number (a11ign/a11ign#3720) and a refusal on the current head settled it (agent-org#483); with no login mapped there is nothing left for either to decide, so their tests now assert that nothing is named.
