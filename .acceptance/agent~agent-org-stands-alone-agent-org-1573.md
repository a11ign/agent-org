agent-org can arm a project's pull requests from outside it, behind the flag `outside.arm` in the project's `.agent-org/decisions.json` (absent = off, shipped OFF). Read through `readSwitches`, like every other key there. The host gate (`settleOutsideArm`, `src/work-gate/pr-orders.ts`, called first in `readArmingOf`) arms an open, non-draft, same-repository, unheld, unarmed pull request against `main` and readies then arms an approved draft; it leaves alone what a11ign's `arm` / `arm-approved` jobs refuse, and a pull request already armed takes no write (the second actor does nothing). `.github/workflows/auto-arm.yml` gains `outside-sweep` and `outside-stalled` on a 15-minute schedule; each reads the flag before it mints a token, and the sweep's mint is scoped to `a11ign/a11ign`. Off, nothing is read from GitHub and nothing is written.

Acceptance: `bash -c 'git grep -l -F outside.arm -- src && npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/outside-arm.test.ts src/packaging/project-vocabulary.test.ts'`

Mutation: each run on `src/packaging/outside-arm.test.ts` (node:test), restored byte-identical by `cp` from a copy and `diff -q`. `outsideArmOn` always true: 5 tests fail (the flag table, the diagnostic, the off pass, the gate's off, the CLI off); always false: 6 fail (the flag table and every ON case). No fork refusal: 2 fail; fork refusal always: 6 fail. No already-armed refusal: 3 fail (the second actor test among them). No draft refusal: 2 fail. No base refusal: 2 fail. `if (!on) return` removed: 2 fail (the off pass and the gate's off). The workflow's mint step without its flag `if:`: 1 fail; `schedule` added to the `arm` job's `if:`: 1 fail.

Measured: `src/packaging/outside-arm.test.ts` 11 of 11 and `src/packaging/project-vocabulary.test.ts` pass. `pnpm run typecheck` exit 0. `rstest run --changed=origin/main` in this worktree: 23 failing files and 109 failing tests, against 22 files and 108 tests for the same 23 files on `origin/main`; the one extra was `project-vocabulary.test.ts` (the `"ready"` verb in `auto-arm-sweep.ts`), now declared there and passing. The other 22 fail identically at `origin/main` in this clone. The repository has no lint script, so lint was not run.

Not here, and named: the Octo STS policy for the identity `outside-arm` is a file in a11ign (a11ign/a11ign#5619), so until it lands a mint with the flag on is a red `outside-sweep` step that says so. The flag is set by a11ign/a11ign#5603. The gate's half and the scheduled jobs were not run live: the flag is off everywhere, and the fixture `gh` of the tests is the only GitHub they met. `~/repos/agent-org`, the row's own Acceptance path, is the main clone and has no `outside.arm` until this merges; the first command of the Acceptance above is that same `git grep` in this worktree.

Closes a11ign/agent-org#1573

Flag: outside.arm
Health-signals: blind-ticks, wakes-held
Revert: set `outside.arm` to `false` (or delete the key) in the project's `.agent-org/decisions.json`; it ships OFF, so today's arming is the default, and a11ign's own jobs keep running beside it. Or revert this pull request.

Outside-Region: src/work-gate/tick.ts — the one call site: `readArmingOf` calls `settleOutsideArm` first, and imports it.
Outside-Region: src/packaging/outside-arm.test.ts — the new test of the flag, the verdict, the second actor and the workflow.
Outside-Region: src/packaging/project-vocabulary.test.ts — declares `"ready"` in `ticket-port/outside-arm-calls.ts` as GitHub's `gh pr ready` verb, as it does for `work-gate/orders.ts`.
Outside-Region: src/ticket-port/outside-arm-calls.ts — the two new `gh` call shapes (the open-PR list, `pr ready`) go through the port, because `gh-call-ratchet.test.ts` refuses a new shape in baselined `auto-arm-sweep.ts`; the baseline is not raised.
Outside-Region: .changeset/agent-org-stands-alone-arm-1573.md — the entry a project that pins a tag reads.

platform: GitHub's scheduled workflows and Octo STS (the sweep's token) are used; GitHub has no native arm-on-event for another repository, and the host gate already ticks every 2 minutes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
