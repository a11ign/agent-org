---
"@a11ign/agent-org": patch
---

A worker is started with a `Stop` hook (`agent-org worker:stop-hook`, a11ign/agent-org#853, a11ign#4957 cause 4) that refuses to end a claimed worker's turn while its row has no open pull request and no fresh `worker:state` declaration, and names `agent-org pr:open` and `agent-org worker:state blocked <row> <reason>`. It is bounded: it honours `stop_hook_active`, refuses at most twice in a row for one row, then allows the stop and writes a `stop-hook-bound` line to the failure ledger. It allows the stop, saying why on stderr, when a worker is not claimed or when the declarations or the board cannot be read.
