---
"agent-org": minor
---

A new per-row worker is assigned to a prompt arm by its row number (even rows `calm`, odd `control`), and the calm arm's first-contact preamble ends with the report's calm finish paragraph (no capitals, with its reasons); the control arm's preamble and every follow-up are unchanged. The arm is written once to a new `claim-orders` file beside the wake ledger when the worker is started. Separately, the gate's repeat orders to a live worker's claim (`claim-stalled`, `pr-checks-failing`, `pr-review-blocked`, `answer-label-unexplained`) are numbered per claim, and the third and later go to `orchestrator` instead of the worker, each logged with its claim, cause and number in the same file. A project that wants neither changes nothing: the paragraph is the report's text, and the cap is `MAX_CONTINUATIONS` in `claim-stall.mjs`. a11ign/a11ign#4070, #4055 move 2.
