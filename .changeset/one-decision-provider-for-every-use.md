---
"agent-org": minor
---

`decide(use, state, questions, deps)` (`src/decision-provider.ts`) is the one interface every use of the structured-decision provider goes through: atomic `choice` and `score` questions over a trimmed state, a switch per use in `.agent-org/decisions.json` (absent or malformed is every use off), a deterministic fallback per question that also replaces any answer under its `minConfidence`, and an append-only decision log beside the wake ledger with `recordOutcome` for what came of it. It never throws and never asks when the use is off. `triage-provider.ts` keeps the one Jev client (now `askProvider`, many questions per call) and `triageOrder` is `decide`'s first caller with its signature, requests and answers unchanged. a11ign/a11ign#4628.
