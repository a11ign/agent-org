---
"agent-org": patch
---

The Haiku trial reading (`node src/trace/haiku-tier-report.ts`) now prints the effort each row's turns ran at, so a row started at `low` before the launch moved to `high` is told apart from a row started at `high`. A stored turn carries the `effort` Claude Code wrote on its transcript record (`perTurnEffort`, else `effort`), and `measuresOf` reports a row's one effort, `mixed` where its turns differ, or `unknown` where none names one (never `low`). Each arm prints a line per effort ("at low: 2 rows; first-pass merge ...") and each row's effort beside its number; the stop rule's figures and verdicts are unchanged. The `api_request` records the OTLP receiver stores keep the request's `effort` attribute too. The trace ingest state moves to version 5, so the next `trace -- --ingest` reads every transcript from byte 0 once and gives the turns already stored their effort. agent-org#469.
