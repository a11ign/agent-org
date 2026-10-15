---
"@a11ign/agent-org": patch
---

Retiring a reviewer seat ends the runs of its causes (a11ign/agent-org#1392). A reviewer seat that was retired while one of its causes was at the delivery cap left that cause refused for ever: the cap is read from the ledger, and nothing could start a run to reset it. Retiring the seat now writes a `RESET` line for each cause it owns that has a run, and the gate starts a capped cause again when its seat is absent from the registry and a complete listing. The `RESET` is written before the new delivery, so the new run is not counted as the seventh. A live seat stays capped.
