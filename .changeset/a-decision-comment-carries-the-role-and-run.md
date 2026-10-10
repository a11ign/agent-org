---
"agent-org": patch
---

A decision comment, a review and a comment on a pull request carry the role and run that posted them. `host/gh` appends one trailing line, `<!-- decided-by: <role> run: <id> -->`, to the body of `gh issue comment`, `gh pr comment` and `gh pr review`, so a comment posted as `a11ign-ai-leads` says whether `ceo`, `product-manager` or `orchestrator` decided (Move 0 of a11ign/a11ign#4505). The role is the herdr label of the call's workspace and the run is the session id the call ledger already records (`CLAUDE_CODE_SESSION_ID`, else `CODEX_THREAD_ID`); with no run id the line carries the role alone, and a call the wrapper cannot attribute is posted unchanged. `--body`/`-b`, `--body-file`/`-F` (a path or `-` for stdin) are handled in each spelling, and a body that cannot be rewritten is posted as it was, never refused. The line is an HTML comment, so the rendered comment reads as before. agent-org#486.
