The retrospective's hand-filed pin-or-bump count reads the home repository's issues created in the last 7 days, through a connection read newest first and stopped at the window's boundary (`readRowsSince`), in place of `gh issue list --state all --limit 1000`. That list is at its ceiling in a repository of 5,500 issues, so the count was `unknown` every day. A window whose rows run past the pages the read may walk is still `null`, which the line reads as `unknown`, never 0.

Acceptance: `node --test src/org-retro-pin-bump.test.ts`

Mutation (on the new `readIssuesInPinBumpWindow` in `src/org-retro.ts`; the file restored byte-identical after each, checked by `diff`):
- the catch returns `[]` instead of `null` (a cut or refused window reads 0): fails the refused-list test and the cut-window test (`pinRows` is 0, not `null`).
- the window's start set to now (an empty window): fails the pin-read test (0, not 1), the 3,000-issue test (0, not 2) and the cut-window test (0, not `null`).

Positive control: the 3,000-issue test (two pins in the window, 2,998 older issues) fails on `origin/main`, where the plain list is at its 1,000 ceiling and `pinRows` is `null`. The pin-read test fails there too, on its fixture's shape.

Measured here: `node --test src/org-retro-pin-bump.test.ts` → `ℹ tests 10`, `ℹ pass 10`, `ℹ fail 0`. `pnpm run typecheck`: exit 0. `pnpm exec rstest run src/org-retro` (the eight org-retro test files): `VERDICT pass: 67 tests in 8 files`. The affected set (`rstest run --changed=origin/main`): `VERDICT fail: 107 of 7173 tests failed in 427 files`, none in an org-retro file. Five of the failing files (65 tests) fail the same set with `origin/main`'s `src/org-retro.ts` in place, so those failures predate this change; the sandbox has no reachable `gh`.
