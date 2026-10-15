---
"@a11ign/agent-org": patch
---

`pr:open` no longer refuses every worker's pull request into a review-only lane (`.github/workflows/`). It asked `gh api user` who is opening the PR, and since the workers moved to a GitHub App that answers an installation token `HTTP 403 Resource not accessible by integration`, which `pr:open` read as "could not say who is opening it". `loginThrough` now falls back to the GraphQL `viewer { login }`, which answers for an installation token (`<slug>[bot]`); a user token still pays one call, and an identity neither read answers still refuses, so the owner check is unchanged. a11ign/agent-org#811, follow-up of #4910.
