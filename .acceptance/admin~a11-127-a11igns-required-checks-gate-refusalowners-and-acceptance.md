CI's `closes` report passes a ticket-mode pull request's declaration (`Closes A11-127`, or `Refs A11-127` with a `Partial:` line) with the grammar `pr:open` already uses, and keeps every GitHub-row declaration as it was. The cross-repo refusal is cleared by a `Cross-repo-red: <ticket key>` line, read by its shape, and no longer by an open GitHub row. This is step 1 of 3 of A11-127: a11ign's `acceptance` job runs the newest agent-org release tag, so it passes a ticket-mode body once this releases.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/ci-closes-report-reads-a-ticket.test.ts src/packaging/closes-declaration.test.ts src/packaging/cross-repo-red-refusal.test.ts src/packaging/cross-repo-red-disarms.test.ts
```

Mutation: `ciClosesReport` was made to return the row report alone, and 7 of the 12 tests in the new file went red; `cross-repo-red.ts` was put back to its base and 10 of 28 in the two cross-repo files went red. Both were restored and the suites passed again.

Consumer-declaration: none -- `extractClosesDeclaration` and `closesDeclarationReport` are unchanged, so `closes-mismatch-check`, `close-rows-for-merged-pr`, `merged-row-open-incident` and the work gate read what they did; the only callers of `declaredRows` and `stateOfRow` were in `cross-repo-red.ts`.
