---
"@a11ign/agent-org": minor
---

A GitHub rate limit no longer stops a session (a11ign/a11ign#4898). `host/gh` recognises a primary or secondary rate-limit refusal of a WRITE, keeps the call whole (arguments, working directory, stdin, any `--body-file`) under `<GH_CONFIG_DIR>/refused-queue`, and exits **75**, which means *held, not failed*: the session is told when the call will be made and carries on. `pr-open` reports a held `pr create` as `QUEUED, NOT FAILED` with exit 75 and attaches the arm and the session label to the entry, so they are made after the create does. The gate's tick (`ghQueueTick`) makes each call after its reset, backing off when refused again, and keeps a call that fails for any other reason, or is over six hours old, under `failed/` with the reason. Reads are never queued. `A11Y_GH_QUEUE=off` restores the old behaviour.

The same tick reads each identity's gh call ledger and, when a pool has spent 70% of its hour before it resets, writes one `incident` ledger line naming the top callers (once an hour per pool). **A project that installs the wrapper must run `host:install` again;** until it does, `host:check` reports the installed `gh` as DIVERGED.
