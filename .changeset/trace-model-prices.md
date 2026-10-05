---
"agent-org": patch
---

The trace store prices turns of `claude-sonnet-5` and `claude-opus-5` (a11ign/a11ign#3582). `PRICES` matched by `startsWith` and its prefixes began at `claude-sonnet-5-5` and `claude-opus-5-5`, so the older ids matched none and every such turn had `costUsd: null`: 97% of two weeks' turns on the private store. The new rows are the published rates ($2 / $10 and $5 / $25 per million tokens, cache reads $0.20 and $0.50), marked `verified: false` because neither was reproduced against Claude Code's own `cost_usd`, and they stand after the `-5-5` rows because the first matching prefix wins. A Codex model still has no row: no rate for it is sourced, so its turns stay `null` rather than carry an invented figure.
