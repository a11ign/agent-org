agent-org's non-test, non-fixture `src` names `a11ign/a11ign` only in comments. The 32 code occurrences at HEAD (listed with their replacements in the #1607 table comment on a11ign/agent-org#1607) now read the home repository from the project declaration (`homeProjectDeclaration().tracker[0].repo` or `.repo`, from `src/project-config.ts`) or take a parameter. The row-number references in comments stay: 325 comment lines holding 326 occurrences, all comment lines, 0 non-comment lines.

`src/reviewer/pr-review-verdict.sh` no longer defaults `GH_REPO` to a literal. With `GH_REPO` unset it reads `tracker[0].repo` from the declaration beside its directory through the tool's `project-config.ts`, and refuses (exit 2) if that cannot be read. This is a behaviour change for an installed copy outside the checkout, not verified on a host.

`src/provider-low-confidence.ts` writes its row pointers bare (`#4750`, `#4751`). It has a no-provider path that must not load `project-config.ts` (a static import fails the `--question` CLI when no host is set), so the declaration is not read there.

`src/trace/triage-labels-4074.json` is a FROZEN record. Only its `source` prose changed (`a11ign/a11ign#4074:` to `row #4074:`). `triage-sample` reads only its `"label":"wake"` check.

`src/repeating-lines.allowlist.json`: four `reason` strings now say `row #N` where they named `a11ign/a11ign#N`.

`src/decision-run/classes/ready-queue-empty.ts`: the `"agent-org": "a11ign/agent-org"` entry of `SCOPES` is a different repository and is left as it was (out of this row).

Guard: `src/no-project-names.test.ts` adds "#1607 no non-comment line of non-test, non-fixture source names a11ign/a11ign" (refuses a non-comment line naming the repo) and "#1607 POSITIVE CONTROL" (a fixture code line is refused, a fixture comment line is not). A line whose first text is `//`, `/*`, a block's ` *`, or `#` is a comment.

`src/packaging/door-refuses-stale-head.test.ts`: the mutant test now copies the door into `reviewer/` beside a symlink of `project-config.ts` and `lib/`, because the door reads the declaration from its parent.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/no-project-names.test.ts`

Measured: 6 pass, 0 fail (run from the worktree root). With `AGENT_ORG_HOST` unset the guard refuses to run (`ProjectDeclarationRefusal`), the same as every test in this repository.

Mutation (done with a backup in the scratchpad and restored with `cp`, verified with `cmp`): a planted `const MUTANT_1607 = "a11ign/a11ign#1";` code line in `src/worker-profile.ts` fails the new test; the same name on a comment line passes it.

Measured: `pnpm run typecheck` exits 0. This repository has no `lint` or `verify` script (only `typecheck` and `test`). `pnpm test` refuses to run from a clone, so the narrow form was used: `AGENT_ORG_HOST=<host.json> pnpm exec rstest run --config scripts/rstest/rstest.config.ts <files>` over 37 test files that cover the changed modules, the door, and the guard. Result: 6 of 1225 tests fail; the same 6 fail on HEAD (`6a72dc4f`) run in a scratch worktree: 4 in `src/packaging/org-health.test.ts` (#2956 x2, the #2880 POSITIVE CONTROL, and redPrFacts consumes orders) and 2 in `src/packaging/live-tree-independence.test.ts` (`Cannot find module 'tsx/package.json'`, an environment fault). The full suite was not run to completion, so no full-suite result is claimed.

Remaining occurrences, outside the Region: test files, and `src/packaging/fixtures/`, which hold the host declarations the tests load.
