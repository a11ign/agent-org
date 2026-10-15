---
"@a11ign/agent-org": patch
---

`ROLE_LOGIN.ceo` names the leads' App login as well as `a11ign-ai-leads` (a11ign/agent-org#816, after #811/#815): `a11ign-managers[bot]` (what `pr-open`'s viewer read and REST print) and `a11ign-managers` (a GraphQL `Bot` author, what `arm-pr` and `auto-arm-sweep` read), so a leads session's PR into `.github/workflows/` is refused at all three doors. `APP_ROLE_LANE_OWNER` accounts for every `github-apps` role, so a new App role cannot go unlisted. `managers` is one App for `ceo`, `product-manager` and `orchestrator`: its login cannot tell them apart.
