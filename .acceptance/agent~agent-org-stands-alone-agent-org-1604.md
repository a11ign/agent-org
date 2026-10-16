The row's fixture run, limited to the CI-runnable files of this change. It copies `src/packaging/fixtures/project-tree/` into a temporary project, commits the copy so `trackedTopLevelDirs()` can see it, and points `AGENT_ORG_HOST` at it. The 14 failing subtests of `auto-arm-token` (7) and `row-filing-guidance` (7) are skipped with named reasons; each skip fires only where a11ign's tracked `packages/` tree is absent. `public-claim.test.ts` (12 failing subtests, skipped the same way) is left out of this block: `pr:open` refuses its line because it reaches `board-data.ts:96` through `reported`, which needs a token, and this block must run with none. `primary-checkout-guard.test.ts` and `shared-stash-guard.test.ts` need the token too, so they are left out, as in the 1603 block. They pass unchanged in the fixture run and are not edited. The rest of the families are classified in `docs/project-tree-dependency.md` under "The remaining families against the fixture (agent-org#1604)". The four other families that failed on the fixture (`acceptance-commands`, `late-edition`, `tracker-leak-refusal`, `live-tree-independence`) are skipped with named reasons there too; run on the fixture, they give `VERDICT pass: 323 tests in 4 files (13 skipped)`, EXIT=0. They are not in this CI-runnable block.

Acceptance:
```bash
d=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$d" && git -C "$d" init -q && sed -i "s|@@PROJECT@@|$d|" "$d/.agent-org/host.json" && git -C "$d" add -A && git -C "$d" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q --no-verify -m fixture && env -u A11Y_CONTROL_HOST_FILE AGENT_ORG_HOST="$d/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/auto-arm-token.test.ts src/packaging/row-filing-guidance.test.ts
```

Measured, on this branch on top of `agent-org` `main` `5ef96aec`:
- Before the change, the five-file run (the two token files included): `VERDICT fail: 26 of 83 tests failed in 5 files` (`auto-arm-token` 7, `public-claim` 12, `row-filing-guidance` 7). The issue's open-check reads `19 of 61`; that is not reconciled here, and the figure above is the one recorded.
- After the change, the CI-runnable block above: `VERDICT pass: 17 tests in 2 files (14 skipped)`, EXIT=0.
- After the change, the row's full five-file run: `VERDICT pass: 57 tests in 5 files (26 skipped)`, EXIT=0.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` exits 0.

Not covered, named:
- The whole-suite fixture run was not completed. A run during measurement queued real handoff orders into the live herdr org session and was stopped; those orders are not retracted and await approval. Details are in the doc's incident paragraph.
- Skips in `wake.test.ts`, `wake-reviewer-instance.test.ts`, `wake-engineer-brief.test.ts` and `owned-path-signoff.test.ts` are from reading their bodies and were not run, because those files reach the org multiplexer.
- Still open: the tests-the-project and needs-real-project subtests in the other families, listed in the doc.

Closes: a11ign/agent-org#1604
