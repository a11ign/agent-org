Switches the row-file and filing-gate family's five files (`src/packaging/row-file.test.ts`, `src/packaging/row-file-refuses-duplicate-title.test.ts`, `src/packaging/row-claim-session-eligibility.test.ts`, `src/duplicate-row.test.ts`, `src/packaging/spec-block-refusal.test.ts`) to run against the fixture project `src/packaging/fixtures/project-tree/`. Each subtest whose reader is a11ign's own tree is skipped, with a named reason, and the skip fires only when that reader is absent: 67 read a11ign's tracked `packages/` tree (`SKIP_NO_PACKAGES`, `trackedTopLevelDirs()`), and 19 read a11ign's `vocabulary.resources` (`SKIP_NO_RESOURCES`, `RESOURCES`). Each skipped subtest's reader is named in `docs/project-tree-dependency.md`, section "The row-file and filing-gate family against the fixture (agent-org#1603)". Four subtests read the fixture's own tracked `docs/` and are not skipped; the Acceptance copy now commits the fixture so they pass.

Acceptance:
```bash
d=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$d" && git -C "$d" init -q && sed -i "s|@@PROJECT@@|$d|" "$d/.agent-org/host.json" && git -C "$d" add -A && git -C "$d" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q --no-verify -m fixture && env -u A11Y_CONTROL_HOST_FILE AGENT_ORG_HOST="$d/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/row-file.test.ts src/packaging/row-file-refuses-duplicate-title.test.ts src/packaging/row-claim-session-eligibility.test.ts src/duplicate-row.test.ts src/packaging/spec-block-refusal.test.ts
```

Measured (from this worktree, on top of `main` `1f87b458`):
- Before the change, the fixture run (the Acceptance as it stood then, with the copy uncommitted): `VERDICT fail: 90 of 250 tests failed in 5 files` (row-file 72/184, row-file-refuses-duplicate-title 6/9, row-claim-session-eligibility 2/31, spec-block-refusal 9/10, duplicate-row 1/16).
- After the change, the amended Acceptance above: `VERDICT pass: 164 tests in 5 files (86 skipped)`.
- The same five files on a11ign's own host (`AGENT_ORG_HOST` pointing at its `.agent-org/host.json`, no fixture): `VERDICT pass: 250 tests in 5 files`, no skips. The conditional skips do not fire where their readers exist.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` (the `typecheck` script's command) exits 0.
- There is no `lint` script in this repository, and no biome or eslint configuration.

Not covered, named: the 86 skipped subtests are not in the fixture run by design; their readers and the row 5 hand-off are in `docs/project-tree-dependency.md`. The remaining families are row 5's (a11ign/agent-org#1604).

Closes: a11ign/agent-org#1603
