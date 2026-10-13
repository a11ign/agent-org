---
"agent-org": patch
---

No test reaches the real `gh`. Traced on 2026-10-13 with a logging `gh` first on `PATH` and a stack hook in the test workers: six test files made 18 real calls, which CI's token-less `gh` refused and a laptop's answered with the engineer's account. Three wake files built `spawnClaimer` without `readRow`, so the tier check read the row's labels from GitHub. They pass an ordinary row now. `spec-lint.test.ts` left three of `readAll`'s readers at their defaults. `row-file.test.ts` left `createIssue`'s `run` at its default. `work-gate.test.ts` ran `rowsOffBoardOrSay` against the real `gh` on purpose and accepted either answer. Two readers had no seam, so each gains one with the same default: `rowsOffBoardOrSay` takes a `run`, and `retroClasses` takes `readOpenPrs`. Its test now pins both branches, a refused read said on stderr and an answered one silent. No change to what the tool does.
