---
"@a11ign/agent-org": patch
---

`reviewer` is a fourth role in `github.identity` (a11ign/a11ign#5044 step 1, agent-org#955): `GITHUB_ROLES` names it, `host.json` reads it as `user-accounts` unless it says `github-apps`, and the `gh` wrapper accepts `AGENT_ORG_GH_ROLE=reviewer`, which `reviewerEnvironment` now sets on every reviewer instance. A host that declares the role sends the reviewer's calls out on the reviewer App's installation token; a host that declares nothing (every host today) is unchanged, byte for byte: the call goes out as the reviewer's own config account, `a11ign-bot`, with no minter started. The revert is the existing one line, `"mode": "user-accounts"` for the role, then `agent-org host:install`. The App itself is not created here.
