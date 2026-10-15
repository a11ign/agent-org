`worker:state blocked` repeated with a reason a manager has ruled on no longer restores `answer:<session>` on the row. When the newest comment by a manager seat (orchestrator, product-manager, ceo) on the row is newer than the worker's last `BLOCKED` comment with the same reason from the same session, the declaration writes neither the label nor a second comment: it prints one line naming the ruling comment and its time, and exits 0. A different reason is declared as before, and so is a repeat no manager has ruled on (a11ign/agent-org#1493).

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/worker-state.test.ts
```

Printed: `VERDICT pass: 39 tests in 1 file` (baseline before the change: 36 tests, all green). The positive control (a second declaration with the same reason after a manager comment writes no label and no comment, and prints the ruling's URL and time) and the negative controls (a different reason, an older ruling, a worker comment later than the ruling, another session's `BLOCKED`, no own `BLOCKED`: each writes the label, the issue edit and the comment) are all in the 39 and pass. `pnpm exec tsc --noEmit -p tsconfig.json` exits 0. `src/packaging/gh-call-ratchet.test.ts` prints `VERDICT pass: 8 tests in 1 file`, and `docs/gh-call-baseline.json` is not changed: `src/worker-state.ts` stays at `calls: 4`, because the comments are read in the same `gh issue view` call the row was already read with.

Run in the worktree (`/home/agent/repos/wt-agent-org-1493`), not in `~/repos/agent-org`, which is a separate checkout.

Full suite (`pnpm test`): `VERDICT fail: 112 of 11729 tests failed in 705 files`. The same 112 tests fail on a clean checkout of this branch's HEAD (without the uncommitted change), with the same per-file counts (`VERDICT fail: 112 of 11726 tests failed in 705 files`). The 25 failing files are packaging and work-gate tests, and `src/worker-state.test.ts` is not among them. The difference of 3 tests is this change's 3 new tests, all green.

Mutation A: the ruling check deleted (`const ruling = null as RowComment | null;` in `applyLabel`, from a copy in the scratchpad). Run: `VERDICT fail: 1 of 39 tests failed in 1 file`, and the failing test is the positive control. Restored with `cp` from the copy and `diff`ed byte-identical.

Mutation B: the ruling counted regardless of its time (`return newest;` in `rulingOn`). Run: `VERDICT fail: 1 of 39 tests failed in 1 file`, and the failing test is the negative controls. Restored with `cp` and `diff`ed byte-identical.

Done-when 1 is the case set above: the positive control writes nothing and names the ruling, the negative controls each write the label and the comment, and both mutations are caught by exactly one test each.

## Judgement calls

- **The ruling is the newest comment by a seat in `RULING_SEATS`**, and the seat is read from the comment's last `decided-by:` line, through `decidedBy` from `src/decided-by.ts`. `RULING_SEATS` is a copy of `MANAGER_SEATS` in `src/pr-hold-state.ts`, which this leaf module does not load; the test asserts the two are equal, so the copy cannot drift.
- **"The same reason" is the first line of the body**, matched to ``BLOCKED (`<session>`, declared with `worker:state`): <reason>``, the header the command posts. A repeat from another session does not count against this session's own comment.
- **The declaration is still written in the ruled case.** No label stands, by design, and the worker is still blocked, so the local declaration records it. The comment on `main` is updated to say so; the rule that a `blocked` the row does not carry is never on disk keeps its meaning for every other case.
- **`--json comments` is one more field per row read**, in the same `gh issue view` call. The row read now carries every comment on the row, not only its state and labels, so the payload grows with the comment count. The call count does not change.
- **Not covered, and left for a follow-up**: the `--on` native-edge path does not run the ruling check. That path writes an edge, not a label, and the issue's scope is the label path (`applyLabel`).
- **Not covered, outside this Region, and a real gap**: the `worker:stop-hook` bound (`src/worker-stop-hook.ts`, `declareAtBound`) calls `applyBlocked` without `comments` (line 143), so a bound declaration on a reason a manager has ruled on still restores the label. It is the same defect class at a second caller. The fix is one line there (pass `comments: resolved.comments`, which `resolveBlockedRow` already returns), but that file is not in this issue's Region, so it is not made here. A follow-up row for it is to be filed.

platform: not affected. The change reads one more field from the `gh` CLI (`comments` in `gh issue view --json`); no platform feature is added or replaced.

Closes a11ign/agent-org#1493
