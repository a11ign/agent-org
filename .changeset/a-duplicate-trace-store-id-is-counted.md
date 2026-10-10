---
"agent-org": minor
---

The trace store's duplicate ids are counted, and the one command that sums the store exists. `trace duplicates [--store <path>]` prints the ids on more than one line and the extra lines they hold, and exits 1 above zero; `trace -- --ingest` prints the same `duplicate ids: n` line and exits 1 above zero, as it does for an unreadable source. `trace cost --by day|row|cause|session [--since <ISO>] [--store <path>]` sums turns read through `readStore` and repriced from `PRICES` (never the stored `costUsd`, which is a first reading priced on the day of ingest), with a second column that reprices cache reads at $0.20 per million, the rate Claude Code's own cost display reads at. A test refuses a module under `src/` that reads the store file's lines itself. agent-org#476, a11ign/a11ign#4437.
