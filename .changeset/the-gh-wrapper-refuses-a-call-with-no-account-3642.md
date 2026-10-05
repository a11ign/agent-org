---
"agent-org": minor
---

The `gh` wrapper (`host/gh`) refuses a call that has no `HERDR_WORKSPACE_ID` and no `GH_CONFIG_DIR` (a11ign/a11ign#3642), instead of falling through to the human's own `~/.config/gh`. Rule 5 was written for a person at a terminal, but a plain ssh shell and a unit that declares no `GH_CONFIG_DIR` look identical to that person, and both acted as the org owner with admin (one spent his search limit). The refusal exits non-zero before `gh-real` and before the call ledger, prints one line (`git push` shows its credential helper's stderr) naming both bot config dirs, and says to `export GH_CONFIG_DIR=...` or run in a workspace; the explicit-`GH_CONFIG_DIR` and workspace routes are unchanged. **A host that installs this wrapper must have every unit declare `GH_CONFIG_DIR` first**, or that unit goes from acting as the human to failing; `host:install` copies the wrapper, so installing it is the host operator's act.
