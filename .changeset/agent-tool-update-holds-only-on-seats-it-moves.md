---
"agent-org": patch
---

`agent-tool:update` holds only on mid-turn seats that run a tool the run is about to move. It refused on every mid-turn seat, and the org always has one, so the first live run was refused seven times in 33 minutes, each time naming a different set of seats. A move of `codex-cli` or `codex-daemon` now waits for and names only the reviewers (`reviewer`, `reviewer-…`); a move of `claude-code` only the Claude seats (`ceo`, `orchestrator`, `product-manager`, `worker-…`). A seat whose label matches neither rule is held for every tool being moved (unknown is not idle), and the refusal says which tools each seat is held for. `--let-finish`, `--wait-minutes` and the unread-listing refusal are unchanged. The label-to-product rule is one function, `productOfSeat`. a11ign/agent-org#665.
