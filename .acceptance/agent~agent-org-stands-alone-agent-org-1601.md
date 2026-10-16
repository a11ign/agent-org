Switches the wake family's three files (`src/packaging/wake-order-shape.test.ts`, `src/packaging/fyi-does-not-wake-a-seat.test.ts`, `src/reviewer/reviewer-setup.test.ts`) to run against the fixture project `src/packaging/fixtures/project-tree/`. The fixture's roster gains the `liaison` entry the fyi test asks for, with a minimal `.agent-org/roles/liaison.md` beside the other briefs. The three subtests that assert on a11ign's own recipe and `docs/known-gaps.md` §48 move, byte for byte, to a new `src/reviewer/reviewer-recipe.test.ts`, which still runs in the default suite against a11ign. `reviewer-setup.test.ts` keeps the verdict-door subtests (#2952). `docs/project-tree-dependency.md` names the reader of each failing subtest.

Acceptance:
```bash
bash -c 'test -f src/packaging/fixtures/project-tree/.agent-org/roles/liaison.md && grep -q liaison src/packaging/fixtures/project-tree/.agent-org/roles/sessions.json' && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/reviewer/reviewer-recipe.test.ts src/reviewer/reviewer-setup.test.ts
```

Measured (from this worktree, on top of `origin/main` `efe2fad7`). The fixture run is the row's own Acceptance, a copy of the fixture with its host file pointed at the copy, run on the host with the fixture variable set. It is not in the `Acceptance:` block above: CI's acceptance job has no token, fleet or corpus, and refuses a command that names the Proxmox key (`A11Y_PVE_KEY`), which this one does:
- Before the change: `VERDICT fail: 4 of 33 tests failed in 3 files`. The four were the `liaison` declaration (`fyi-does-not-wake-a-seat.test.ts`) and three project-content subtests in `reviewer-setup.test.ts`.
- After the change: `VERDICT pass: 28 tests in 3 files` (33 less the five subtests moved to `reviewer-recipe.test.ts`). `wake-order-shape.test.ts` is 11 of 11, `fyi-does-not-wake-a-seat.test.ts` 14 of 14, `reviewer-setup.test.ts` 3 of 3.
- `node --test src/reviewer/reviewer-recipe.test.ts` with no fixture variable (a11ign's own host): `ℹ pass 5`, `ℹ fail 0`, exit 0.
- `pnpm run typecheck` is clean. There is no `lint` or `verify` script in this repository.
- The moved block is 107 lines, byte-identical to lines 20–126 of the pre-split `reviewer-setup.test.ts`.

Not covered, named: `wake.test.ts`, `wake-reviewer-instance.test.ts` and `wake-engineer-brief.test.ts` (row 5). `reviewer-recipe.test.ts` is not on the fixture at all; it runs against a11ign, and moves to a11ign in row 5.

Closes: a11ign/agent-org#1601

platform: nothing in GitHub, pnpm or git holds a fixture project; the change is test files, a roster entry, a brief and a doc, and runs on the existing rstest runner.
