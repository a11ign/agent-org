---
"agent-org": patch
---

A `gh` call inside the gate's batch is cut at 30 s, as `defaultRun` cuts one run on its own. `BATCH_WORKER`'s `execFile` had no `timeout`, and the `execFileSync` around the worker had none either, so a stalled `gh` held the whole batch (the gate's, the claim's and the wake's pre-claim read) until the tick's own `TimeoutStartSec`. A cut call now answers as a refused one (`failed`, `status: null`, `code: "ETIMEDOUT"`, its stderr), so every caller's fail-open verdict and log line stand and the other calls' answers are intact. The worker's own wait is 5 s longer than the call's; if the worker is killed anyway, `runBatch` throws and the caller runs its calls one by one, as it already did. a11ign/a11ign#3843.
