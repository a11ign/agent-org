With `prs.ownerRouting` ON, a REFUSED pull request (`pr-review-blocked`) whose owner is gone (`ownerOfPr` reads `owner-gone`) is ordered to the worker pool `engineers` (`DEPENDENCY_BOT_WORKER_SESSION`, the same pool as #1368, so one constant), not to its ended `session:` label and not to `product-manager`. `routeDeadOwnerRefusals` (`src/work-gate/pr-orders.ts`) does this after `withholdOutsideFollowUps`, in `decide` (`src/work-gate/tick.ts`), and only when the flag reads on. The order's `causeKey` moves with the session (`engineers/pr-review-blocked/pr-<ref>/<code>`, #2001). Its prompt says the worker is FRESH, names the pull request's branch, drops the sentence that says the rework is the ended label's, and carries the refusing review's body (the newest `CHANGES_REQUESTED` in `reviews`, which `gh pr list --json` returns with `body`). A pull request whose label stands is untouched. The flag off, nothing in the reroute runs, so every order is what it was.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/dead-owner-respawn-order.test.ts` (run in the worktree, where the new file is). Measured: `VERDICT pass: 2 tests in 1 file`. The two tests are the flag-on refusal (the fresh-worker order, its causeKey, no `product-manager` order for the pull request, the branch named, the reviewer's words carried) with the flag-off run as its positive control (the ended label still addressed, as before), and the live-owner control (label stands, no `engineers` order).

Mutation, each source backed up to the scratchpad by `cp`, changed by one line, run, and restored by `cp` with `diff` after:
- M1, the refusal's session in `toFreshWorker` set to `"product-manager"` (the refusal goes to the manager pool): `VERDICT fail: 1 of 2 tests failed`, the flag-on test red.
- M2, the reroute removed from `decide` (the flag on then orders as the flag off does): `VERDICT fail: 1 of 2 tests failed`, the flag-on test red.

Before-state: M2 is the before-state under the flag, and it is red; the flag-off path is unchanged code.

Regression: `pnpm run typecheck` exits 0 with no output. There is no `lint`, `verify` or `test:org` script in this repository (`package.json` has `typecheck` and `test`). `pnpm test` (rstest, all files): `VERDICT fail: 112 of 11604 tests failed in 700 files`. The same 112 fail at HEAD: the 25 failing files were run at HEAD (`src/work-gate/pr-orders.ts` and `src/work-gate/tick.ts` from `git show HEAD:`, then restored), `VERDICT fail: 112 of 733 tests failed in 25 files`. They fail identically with this change removed, so they are not this change's; they include a missing `tsx` module (`src/packaging/live-tree-independence.test.ts`).

Not here, and named: a fresh process is not started. `wake.ts`'s `SPAWN_CAUSES` is exactly `["ready-row-unclaimed"]` (pinned by `src/ceo-one-shot.test.ts`), so the `engineers` order for `pr-review-blocked` is delivered to an IDLE engineer and is not a spawn. Widening `SPAWN_CAUSES`, or adopting the branch for a fresh process, is outside this row's Region. An UNLABELLED owner-gone refusal (no `session:` label, `#5201`) stays in the `product-manager` set order; this row covers the labelled one. The `verdict-not-convinced` order for an owner-gone pull request still goes to `product-manager` with its fallback; this row covers the refusal only.

Closes a11ign/agent-org#1370

platform: linux, Node v24.21.0; the reroute is pure over `decide`'s inputs, so no `gh`, `git` or herdr is read by the test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
