---
"@a11ign/agent-org": patch
---

The `gh` wrapper names a GitHub App role only for a config that is the role's own: an explicit `GH_CONFIG_DIR` that is neither the workers' nor the leads' directory (the reviewer's `a11ign-bot`, a unit's own) gets no app token and goes out as that config's account. It used to read as `workers`, so a reviewer acted as the App that authored the pull request and GitHub refused its approval (nine pull requests stuck at `REVIEW_REQUIRED`, a11ign/agent-org#817). `AGENT_ORG_GH_ROLE` still wins, and an unset `GH_CONFIG_DIR` or the workers' or leads' directory routes as before.
