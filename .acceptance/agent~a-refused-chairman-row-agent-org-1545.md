A refused `priority:chairman` row that `ceo` has answered stays silenced across a tick that did not read the primary's Ready rows. The refusal ledger (`chairman-refusals.json`, read in `chairmanRefusedOrders` in `src/work-gate/causes/rows-offer.ts`) used to be rewritten to the rows refused THIS tick, so a tick whose shelf was empty (a refused or event-gated primary read: `blocked` is `[]`) forgot every entry, and the next refusal was told as a first telling. `hierarchyOrders` now takes `laneUnread`, which `decide` sets from the gate's `primaryUnread` (`!primaryRead || readyRows === null || openRowsRead === null`, in `src/work-gate.ts`). On an unread tick the ledger keeps its entries and a blocker is not read as closed; a read tick that does not refuse the row still forgets it. The new test in `src/work-gate-offer-hierarchy.test.ts` (`#4405`) pins control (a), tick 1 refuses, tick 2 did not read the lane, tick 3 refuses again with a ceo answer: no order; (a') a refused unread tick with no open rows read does not tell an answered row; (b) a read tick that does not refuse the row forgets it, so tick 3 is a first telling; (c) a changed reason is told after an unread tick; (d) a ledger that cannot be written re-tells every tick.

Acceptance: `cd /home/agent/repos/wt-agent-org-1545 && node --test src/work-gate-offer-hierarchy.test.ts`

Mutation, each restored byte-identical from a saved copy (`cmp`): the carry-forward removed (`if (false)`) fails control (a) at tick 3; the carry-forward on every tick (`if (true)`) fails (b) at tick 3 (a first telling, as it always was); the blocker-closed read on an unread tick restored (`laneUnread` dropped from `silenced`) fails (a') at tick 2.

Against main's three source files (`rows-offer.ts`, `tick.ts`, `work-gate.ts`, with the final test file): fails at control (a), tick 3, `actual: 1, expected: 0`.

Measured: `ℹ tests 13 / ℹ pass 13 / ℹ fail 0` for the acceptance file. `pnpm run typecheck` exits 0. `pnpm run lint` is not a script in this repository.

Full suite (`pnpm test`, `rstest run`): 114 failed tests in 27 files. The 27 files rerun with the correct config on this tree give 113 failed and 658 passed; the same 27 files on main's three source files and test file give the identical 113-title failure list. So these failures are on main already and are not caused by this change. The one extra run failure, `gh-secondary-burst` `(b) POSITIVE CONTROL`, did not recur: the file passes 11 of 11 alone on this tree, and it did not fail in either correct rerun (this tree or main's sources). It is a load-sensitive failure, not a stable one.

Not here, and named: the work-tick journal for 2026-10-15 22:00–23:50Z is not in `~/.cache/a11ign`, so which tick shape dropped a11ign#4405's entry is not read from it (see the PR body). The gate itself was not run end to end, since the resource ban rules out `fleet:*` and `lab:*`; the wiring from `decideArgs` through `decide` (`src/work-gate/tick.ts`) to `hierarchyOrders` is checked by `tsc` and by reading, not by a tick. `host:install` is the host's step and is not run here.

Closes a11ign/agent-org#1545

🤖 Generated with [Claude Code](https://claude.com/claude-code)
