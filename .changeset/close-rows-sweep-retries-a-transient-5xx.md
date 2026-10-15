---
"@a11ign/agent-org": patch
---

`close-rows-sweep` reads the merged-PR list again when GitHub answers it with a transient 5xx (`HTTP 5xx`), up to 3 attempts with a 1 s then 2 s pause, and never on a 4xx. Before, a single 502 on that read exited `CANNOT ASK` and turned `trunk`'s `closeRows` job red. The retry is behind `SWEEP_RETRY_TRANSIENT=1` and is OFF unless that variable is set, so the sweep makes one read as before until the switch is turned on. a11ign/agent-org#1175.
