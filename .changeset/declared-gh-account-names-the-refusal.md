---
"agent-org": patch
---

`declaredGhAccount` answers UNKNOWN, naming the wrapper's refusal, for a call with neither `HERDR_WORKSPACE_ID` nor `GH_CONFIG_DIR` (a11ign/a11ign#3665). Since #3642 the `gh` wrapper refuses that call, but STEP 3 still read `~/.config/gh` and returned the human account, so `work-gate.mjs` named the human for a call the wrapper will not make. The workers README that `host:install` writes no longer says "only a shell with no workspace id is a person and uses the default config"; it says that call is refused and a shell outside a workspace must export `GH_CONFIG_DIR`. Both are pinned by a test that fails on the old text.
