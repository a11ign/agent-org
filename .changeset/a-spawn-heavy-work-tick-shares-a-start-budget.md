---
"@a11ign/agent-org": patch
---

The starts of one work tick share a 60 s budget (`START_BUDGET_MS`). `herdr agent start` may wait the full 30 s of `defaultRun`'s timeout, and a chairman row or a reviewer is not held by `MAX_SPAWNS_PER_TICK`, so a tick with three starts waited three timeouts and overran its 180 s limit (402 s measured). A start that would begin with the budget spent is deferred to the next tick before its claim, pane or checkout, with its order kept, classified as a wait and counted on a `START BUDGET:` line. The cost line's `subcommands` now names `herdr agent start` apart from `agent list` and `agent read`: `--session` is a value option, so its value `org` is no longer read as the first subcommand word. agent-org#1025.
