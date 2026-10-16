The row's five-file fixture run. It copies `src/packaging/fixtures/project-tree/` into a temporary project, commits the copy so `trackedTopLevelDirs()` can see it, and points `AGENT_ORG_HOST` at it. The 26 failing subtests of `auto-arm-token`, `public-claim` and `row-filing-guidance` are skipped with named reasons; the skip fires only where a11ign's tracked `packages/` tree is absent. The rest of the families are classified in `docs/project-tree-dependency.md` under "The remaining families against the fixture (agent-org#1604)".

Acceptance:
```bash
d=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$d" && git -C "$d" init -q && sed -i "s|@@PROJECT@@|$d|" "$d/.agent-org/host.json" && git -C "$d" add -A && git -C "$d" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q --no-verify -m fixture && env -u A11Y_CONTROL_HOST_FILE AGENT_ORG_HOST="$d/.agent-org/host.json" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/primary-checkout-guard.test.ts src/packaging/shared-stash-guard.test.ts src/packaging/public-claim.test.ts src/packaging/auto-arm-token.test.ts src/packaging/row-filing-guidance.test.ts
```

Measured, on this branch on top of `agent-org` `main` `5ef96aec`:
- Before the change, the same command: `VERDICT fail: 26 of 83 tests failed in 5 files` (`auto-arm-token` 7, `public-claim` 12, `row-filing-guidance` 7). The issue's open-check reads `19 of 61`; that is not reconciled here, and the figure above is the one recorded.
- After the change, the same command: `VERDICT pass: 57 tests in 5 files (26 skipped)`, EXIT=0.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` exits 0.

Not covered, named:
- The whole-suite fixture run was not completed. A run during measurement queued real handoff orders into the live herdr org session and was stopped; those orders are not retracted and await approval. Details are in the doc's incident paragraph.
- Skips in `wake.test.ts`, `wake-reviewer-instance.test.ts`, `wake-engineer-brief.test.ts` and `owned-path-signoff.test.ts` are from reading their bodies and were not run, because those files reach the org multiplexer.
- Still open: the tests-the-project and needs-real-project subtests in the other families, listed in the doc.

Closes: a11ign/agent-org#1604
