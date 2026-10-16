Switches the work-gate family's five files (`src/packaging/work-gate.test.ts`, `src/packaging/work-gate-awaiting-evidence.test.ts`, `src/work-gate-cross-repo-pr-owner.test.ts`, `src/packaging/cross-repo-red-refusal.test.ts`, `src/packaging/cross-repo-red-disarms.test.ts`) to run against the fixture project `src/packaging/fixtures/project-tree/`. Three changes make the fixture run pass: the test pull-request literals carry `isCrossRepository: false` (production `readPrs` always supplies it, and `decide` reads its absence as "outside"), the work-gate tests pin `decide`'s identities to a test-owned list (#1311), and the fixture's `project.json` declares `lab` under `code` for `legSourceOf` (`src/cross-repo-red.ts`). Twenty-eight top-level subtests that read a fact the fixture tree cannot supply move, byte for byte, to `src/packaging/work-gate-a11ign-readers.test.ts`, which still runs in the default suite against a11ign. Their readers are named in `docs/project-tree-dependency.md`. The new file is declared in `DECLARED_HISTORY_POPULATION` because it imports the same `host-units.ts` edge as the others there.

Acceptance:
```bash
d=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$d" && git -C "$d" init -q && sed -i "s|@@PROJECT@@|$d|" "$d/.agent-org/host.json" && env -u A11Y_CONTROL_HOST_FILE -u A11Y_PVE_KEY AGENT_ORG_HOST="$d/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/work-gate.test.ts src/packaging/work-gate-awaiting-evidence.test.ts src/work-gate-cross-repo-pr-owner.test.ts src/packaging/cross-repo-red-refusal.test.ts src/packaging/cross-repo-red-disarms.test.ts
```

Measured (from this worktree, on top of `main` `74235022`):
- Before the change, the fixture run: `VERDICT fail: 71 of 470 tests failed in 5 files` (work-gate 48, awaiting-evidence 1, cross-repo-pr-owner 8, cross-repo-red-refusal 8, cross-repo-red-disarms 6).
- After the change, the fixture run: `VERDICT pass: 442 tests in 5 files` (470 less the 28 that moved).
- The same five files on the default host (no fixture variable), after the change: all pass except the 11 moved subtests in `work-gate-a11ign-readers.test.ts` that depend on the session roster and the CI job set. Those same 11 fail at `HEAD` on this sandbox's default host too (`VERDICT fail: 38 of 416 tests failed`, 11 of them in this group), so the sandbox cannot show them green. They are not verified on a11ign's own CI here.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` (the `typecheck` script's command) exits 0 with no output.
- There is no `lint` or `verify` script in this repository.

Not covered, named: the 28 moved subtests are not in the fixture run by design; their readers are in `docs/project-tree-dependency.md` (section "The work-gate family against the fixture"). The remaining families, and the 10 tests-the-project and 14 needs-real-project subtests, are row 5 (a11ign/agent-org#1604). The Acceptance command names `A11Y_PVE_KEY` (in the `env -u` list, as the row amended it), which the 1601 record says CI's acceptance job refuses; this is not changed here and is for the orchestrator to decide.

Closes: a11ign/agent-org#1602
