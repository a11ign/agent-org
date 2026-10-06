---
"agent-org": patch
---

The gate's `gh` runner is cut at 30 s (`GH_READ_TIMEOUT_MS`, the same bound `wake.mjs`'s `defaultGh` uses). `defaultRun` ran `gh` with no `timeout`, so one `gh` that never returned held the whole tick until the unit's `TimeoutStartSec=600` killed it, and every lane's reads went with it; `systemctlRun` and `herdrRun` already had one. A call that hits the bound is killed and thrown as the `ETIMEDOUT` refusal every reader already turns into `null` for its own lane, with one line on stderr naming the subcommand (`GH CUT in <repo>: \`gh pr list\` ran past 30 s and was killed`); the other lanes' reads go on. The batched path (`BATCH_WORKER`) is not bounded by this change and is the row after it (a11ign/a11ign#3843). This does not say a hung `gh` caused any of the 600 s kills in the journal; the line it writes is how a next one will be told.
