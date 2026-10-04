---
"agent-org": minor
---

New command `agent-org trace -- <row-or-pr>` (a11ign/a11ign#3494, first slice): one append-only trace store of the org's model turns and wake-ledger deliveries, keyed by row, pull request and repository, and a printout of one row's events in order with tokens, cost and wall-clock. The model-turn source is the Claude transcript (platform-first reading on the row: Claude Code's OpenTelemetry has no file exporter, needs a receiver the host does not run, and cannot reach a running standing seat). A turn is built once per API message id, because a transcript writes a message once per content block; cost is computed from a price table checked against Claude Code's own `cost_usd`, and is `null`, never 0, for a model with no price. It reads `wakes-per-row.mjs`'s parsers by import. GitHub events, waits, the `gh` call ledger and Codex reviewer turns are not in the store yet, and the report says so.
