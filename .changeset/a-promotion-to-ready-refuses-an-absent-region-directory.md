---
"@a11ign/agent-org": patch
---

A promotion to Ready refuses a Region whose top-level directory the row's repository does not have, as `--ready` filing already did (#855), so a backlog row is not let past it. `promoteRefusalReason` calls `absentRegionTopDirReason` with `act: "promote"`, and the keyed Region token reader moves from `row-file.ts` into `regionPathTokens` in `region-paths.ts`, the one reader. A keyed entry whose clone is not declared on the host is still not checked. a11ign/agent-org#877.
