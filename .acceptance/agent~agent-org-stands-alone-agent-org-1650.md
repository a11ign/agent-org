The CI-runnable block for agent-org#1650's fifteen Region files. It has the shape of agent-org#1604's block. Its skips fire wherever a11ign's tracked `packages/` tree is absent, so on a11ign's own checkout every file runs in full: `VERDICT pass: 287 tests in 15 files`, no skips, measured on this branch. The row's Acceptance is the fixture form (a committed copy of `src/packaging/fixtures/project-tree/`, `AGENT_ORG_HOST` pointed at its `host.json`, then rstest over the same fifteen files). It is not in this block: `pr:open` refuses a `mktemp` wrapper in the Acceptance, as agent-org#1604 records. Its output is in the PR body.

The 54 subtests that failed on the fixture are skipped with named reasons in their files. Each skip is `{ skip: SKIP_FIXTURE }`, or a computed reason in `event-tunnel.test.ts` and `ci-health-liveness.test.ts`. The table of each skip and its reason is in `docs/project-tree-dependency.md` under "The fifteen Region files against the fixture (agent-org#1650)".

Acceptance:
```bash
node_modules/.bin/tsc --noEmit -p tsconfig.json && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/dora-release-commit.test.ts src/dora-direct-to-latest-has-no-channels.test.ts src/event-tunnel.test.ts src/host-kernel.test.ts src/packaging/shadow-window-arm.test.ts src/packaging/host-tool-install.test.ts src/packaging/project-roles.test.ts src/packaging/project-vocabulary.test.ts src/packaging/persistent-seat-running.test.ts src/packaging/org-retro.test.ts src/packaging/worker-profile.test.ts src/ceo-one-shot.test.ts src/orchestrator-one-shot.test.ts src/packaging/reconstitution-drill.test.ts src/ci-health-liveness.test.ts
```

Measured, on this branch on top of `agent-org` `main` `ff498ea4`:
- Before the change, the fixture run: `VERDICT fail: 54 of 286 tests failed in 15 files`. The run record holds 287 tests, 54 failing. The row's reading says 286; the figure recorded here is the verdict line's.
- After the change, the fixture run: `VERDICT pass: 232 tests in 15 files (55 skipped)`, EXIT=0. The run record has 0 failing. 54 of the 55 skips are new; `ci-health-liveness`'s "the heading, the seven-day window…" skip was in the source before this row.
- After the change, the same fifteen files on a11ign's own checkout, with `AGENT_ORG_HOST` at its host declaration and no fixture: `VERDICT pass: 287 tests in 15 files`, EXIT=0, no skips.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` exits 0.

Not covered, named:
- The bare `rstest` the row's Acceptance spells out, with no file list, was not run. It runs every `src/**/*.test.ts`, and a run of that kind is what queued real orders into the live herdr org (`docs/project-tree-dependency.md`, the incident paragraph under "The remaining families"). The fifteen files are the row's Region and its Open-check's scope.
- `pnpm run lint` does not exist in this repository; the typecheck is the only static check run.
- The skips are from reading the bodies of the failing subtests, each cause checked against the fixture's files. A skipped subtest is not run on the fixture; it is skipped by name.
- Candidate tracker rows for the moved files are not filed in a11ign's tracker; the doc lists them for product-manager.

Closes: a11ign/agent-org#1650
