A queued order whose session the org does not know is dropped at a bound, with one line and a comment on the row it carried. `dropUnknownHandoffs` in `src/wake.ts` runs on every tick right after the ended-session settle, before the backlog, the stale report and the delivery. A session is UNKNOWN when it is not a standing seat (`engineers`, the roster, a lead seat), not a reviewer instance, and has no pane with an agent (absent from herdr, or `unknown`). An engineer instance (`worker-<n>`) is unknown only when its row is CLOSED, the reading `settleOrphan` already takes. The bound is `UNKNOWN_SESSION_MS` (2h, = `HANDOFF_STALE_MS`), measured from the first tick that saw the session unknown, kept in `handoff-unknown-since.json` beside the queue; a session that comes back clears its clock. Nothing is dropped while the account is paused. A drop appends a `dropped` record carrying the prompt, prints one `DROPPED` line naming the order, the session and the first `#n` the order names, and comments on that row.

Acceptance: `cd /home/agent/repos/wt-agent-org-1416 && node --test src/packaging/wake.test.ts` (the row's `~/repos/agent-org`, which is this worktree's clone)

Mutation (each reverted byte-identical from a saved copy after its run):
- never drop (`kept: handoffs, lines: []`): failed the drop test only.
- drop without the bound (`now - first < 0`): failed the drop test and the comes-back test.
- a working seat counted as unknown (`&& false` on the status check): failed the working test and the comes-back test.
- the pause guard removed: failed the working/paused test only.

On `main` the test file does not load (`UNKNOWN_SESSION_MS` is not exported), so every test in it fails there; the per-behaviour evidence is the mutation list above.
