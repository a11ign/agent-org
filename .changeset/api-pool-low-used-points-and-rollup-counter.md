---
"agent-org": patch
---

`api-pool-low`'s Spender sentence now states the pool's own used points (`limit - remaining`) beside the ledger's total and the share of them the ledger accounts for, and says so when that is under 90%; the `host/gh` hourly rollup keeps the pool's counter movement as a row's 8th field, so an hour trimmed out of the ledger reads as the counter saw it and not as its floor (agent-org#1420).
