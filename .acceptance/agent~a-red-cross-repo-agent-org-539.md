A red `cross-repo` leg, or a red nightly, of a declared code repository's `ci.yml` on `main` is read by the tick's trunk read and wakes the fixer: `readTrunkRed` also asks for `event=schedule` runs, takes the newest verdict run of either event, and reads its jobs even when it is green (a11ign/agent-org#539).

Acceptance:
```bash
grep -q 'event=schedule' src/trunk-red.ts && node --test src/trunk-red.test.ts
```

The row's command is `cd /home/agent/repos/agent-org && grep -q 'event=schedule' src/trunk-red.ts && node --test src/trunk-red.test.ts`. The primary clone carries the change only after the merge, so the command above is the same one run in the PR's own tree, with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`. Printed: `ℹ tests 9 / ℹ pass 9 / ℹ fail 0`, exit 0. At `HEAD` before the change the `grep` fails (0 matches) and the test file has 2 tests.

Change 1, the measurement (done-when 2), with `gh api repos/a11ign/lab/actions/runs/<id>/jobs`, 2026-10-10: the job `checks (cross-repo)` reads `conclusion: "failure"` (failed step `The tests of this leg`) while its run reads `conclusion: "success"` and `gate` reads `success`, on lab's schedule run 38045596539 and push run 38044280935; the same job read `failure` on all 11 of the newest `ci.yml` runs on `main` (11 of 11, push and schedule). So the leg's own job conclusion IS readable, and it is the only place the red is.

Mutation:
- Each mutant was applied with a script to `src/trunk-red.ts`, run against `src/trunk-red.test.ts` (9 tests), and restored from a copy (`diff` identical afterwards; never `git checkout --`).
  - the leg is never read (`gate` alone, the row's negative control): 5 fail, the red-leg test, the red-nightly test, the refused-read control, the no-cross-repo-job test and the clears-it test.
  - the schedule filter is never asked: 3 fail, the red-nightly test, the refused-read control and the clears-it test. With the literal removed from the code the Acceptance's `grep` exits 1 too (the only other mention is reworded so a comment cannot satisfy it).
  - the leg matcher matches every job (always fires): 1 fails, `a job that only contains the words is not the leg`.
  - the leg matcher matches nothing (never fires): 5 fail, the same five as the leg never read.
  - a refused runs read is looked through: 1 fails, the refused-read test.
  - the primary also asks both events / the primary reads a leg: 1 fails each, `the primary is read exactly as before`.
  - a nightly goes to the merger of the newest commit: 1 fails. The `event` fact dropped: 1 fails.

Suite: `tsc --noEmit -p tsconfig.json` shows the same 2 errors as `HEAD`, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable in this tree), none in `trunk-red`. The 91 test files that mention the trunk read, `scopeTick` or `ci.yml` were run one by one: 8 files fail identically with `HEAD`'s `src/trunk-red.ts` swapped in (host declaration and trace store of this checkout), and `src/packaging/trunk-revert.test.ts` (25) and the row's own file pass.

Outside the row's Region, declared on the PR with `Outside-Region:` lines: two existing tests pin the call shape this row changes on purpose, and each failed with the change at one assertion (both pass at `HEAD`; verified by running them on the unmodified `trunk-red.ts`). `src/work-gate-trunk-red-agent-org.test.ts` `a healthy main costs exactly one call` now pins two runs reads and one jobs read, and `src/work-gate-other-scopes-concurrent.test.ts` `each other repository's main is asked in the same wave` now pins two `/actions/workflows/` calls per repository. Each is a one-assertion edit, and with it the two files read 10 of 10 and 11 of 11. NOT touched, and named for `product-manager`: the comment above `perOtherCodeRepository` in `src/work-gate.ts` still says "ONE REST CALL PER NON-PRIMARY CODE REPOSITORY ... push runs", which is now three calls on a healthy tick (two runs reads and one jobs read).
