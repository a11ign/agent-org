The six test files that reached the real `gh` inject their reads: `spawnClaimer`'s `readRow` in the three wake files, `readAll`'s `readSharedRows`, `pinBumpOn` and the new `readOpenPrs` in `spec-lint.test.ts`, `createIssue`'s `run` in `row-file.test.ts`, and the new `run` of `rowsOffBoardOrSay` in `work-gate.test.ts`, which now pins both of its branches.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/wake-spawn-worktree.test.ts src/wake-worktree-toolchain.test.ts src/wake-spawn-brief-absent.test.ts src/spec-lint.test.ts src/packaging/work-gate.test.ts src/packaging/row-file.test.ts
```

Consumer-declaration: none -- two optional parameters whose defaults are the calls they replace (`rowsOffBoardOrSay`'s `run`, `retroClasses`'s `readOpenPrs`), and test changes.
