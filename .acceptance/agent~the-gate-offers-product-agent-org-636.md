The gate offers `product-manager` the untiered-ready sweep after two ticks above zero: `retrospectiveTick` reads the `ready` rows with no tier decision on every tick, keeps the count in the state dir, and returns one `ready-rows-untiered` order naming the rows when the count is `read` and above zero on this tick and the one before (a11ign/agent-org#636, follows #466).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/untiered-ready-rows.test.ts src/packaging/worker-profile.test.ts
```

Run in the PR's own tree with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json` and `node_modules` linked to the primary clone's (this worktree has none): `VERDICT pass: 59 tests in 3 files` for that pair plus `src/packaging/project-roles.test.ts`; `src/untiered-ready-rows.test.ts` is 23 tests (`node --test`: pass 23, fail 0).

The row's negative controls, each a test in `src/untiered-ready-rows.test.ts`: count 0 offers nothing (two ticks of 0, and a run ended by a 0); count above zero on ONE tick offers nothing; `unknown` offers nothing and breaks the run (the next read above zero is a first tick again); two ticks above zero offer one order to `product-manager` naming `#7` and `#466`; the same rows on the third tick, in another order, are the same `causeKey`, and a changed stock is another.

Mutation (each applied with a script to `src/untiered-ready-rows.ts`, run against the 23 tests, restored from a copy; `git diff --stat` afterwards shows only the row's 37 added lines):
- one tick is enough (the previous count is not required): 5 fail.
- a count of 0 offers: 3 fail.
- an `unknown` is remembered as a count of 1 (so it offers on the next tick): 2 fail.
- the key sorted as strings (`#10` before `#9`): 2 fail.
- the key not sorted in `untieredSweepKey`: 1 fails (`untieredOffer` also sorts, so the order of the named rows is held by two places).

Suite: the whole `rstest` run reads `35 of 8606 tests failed in 475 files`, and the same 13 failing files re-run in a detached worktree at `HEAD` read `35 of 366 tests failed in 13 files`: the same 35, none in a file this row touches. `tsc --noEmit -p tsconfig.json` shows the 2 errors `HEAD` has, both in `src/packaging/mjs-ratchet.test.ts`.

Outside the row's Region, declared on the PR with `Outside-Region:` lines, because a new declared cause is counted in tests that list every cause: `src/packaging/project-roles.test.ts` (42 tool causes becomes 43, and the three recorded lists gain `ready-rows-untiered`) and `src/packaging/work-gate.test.ts` (the FINISH list). And four tests that call `retrospectiveTick` with their own `read` seam gain `readUntiered: () => null`, so none of them reaches the real `gh` now that the sweep is read on every tick: `src/packaging/org-retro.test.ts`, `src/org-retro-dora-resumes.test.ts`, `src/merged-row-open-incident.test.ts`, `src/idle-claim-incident.test.ts`.

`.agent-org/roles/engineer.md`, which the order says to read first, is not in this repository's tree (the roles live in the project's checkout); the row's own text and the existing sweep code were the brief.
