A pull request held on a declared wait gets no NOT CONVINCED rework order (`verdict-not-convinced`) for as long as the wait stands. The hold is a `hold:*` label on the pull request, whoever placed it, or an open native `blockedBy` edge recorded at its head (`isWaitingRed` in `src/red-pr.ts`). `settledVerdictOrder` in `src/work-gate/pr-orders.ts` returns no order for a not-convinced verdict in either case. The order returns when the label is removed, the edge closes (empty `edges`), or a new head is pushed. A convinced verdict on a held pull request is left as it was, and the positive control (the same pull request unheld) is still ordered to the session its row holds.

Acceptance:
```bash
node --test src/work-gate/not-convinced-held-pr.test.ts
```

Mutation: the exemption in `settledVerdictOrder` was mutated four ways, each restored from a copy and checked with `cmp` (byte-identical) after its run. Never exempting (the pre-change code) fails 3 tests: the standing hold, the hold ending with the label, and the open edge at the head. Always exempting (`return null`) fails 5: the positive control, the edge closing, a stamp with no head or no edges, a push, and the hold ending. Dropping the hold key fails 2 (the standing hold, and the hold ending). Dropping the wait key fails 1 (the open edge at the head).

Measured: `node --test src/work-gate/not-convinced-held-pr.test.ts` prints `ℹ pass 8`, `ℹ fail 0` with the change. On the unchanged `pr-orders.ts` the positive control passes and the three held cases above fail. `pnpm run typecheck` exits 0. The full repository suite (`node --test`, 11527 tests) fails 121 with the change and 124 without it; the difference of 3 is the new held-PR tests, so no previously passing test changed. Among those 121 are 17 in `src/work-gate-unlabelled-pr-owner.test.ts`, `src/work-gate-red-pr-waiting.test.ts` and `src/packaging/pr-owner-total.test.ts`, which fail identically on the unchanged code and in the primary checkout (`~/repos/agent-org`, `991ddf90`); they are not claimed here. The row's acceptance command was run in this worktree, not in `~/repos/agent-org`, because the primary checkout lacks the change.

Closes a11ign/agent-org#1466

Test: `src/work-gate/not-convinced-held-pr.test.ts`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
