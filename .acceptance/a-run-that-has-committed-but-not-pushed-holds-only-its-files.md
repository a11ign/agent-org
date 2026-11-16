A run at work whose worktree has commits holds the files its worktree's diff names (`committedFiles`, read by `readCommittedFiles`), plus its plan's paths, and not its whole repository (A11-452). A queued run whose paths do not overlap them starts and its wait note no longer says "files not known"; a run with no commit, or whose worktree cannot be read, still holds the whole repository.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/overlap-hold.test.ts src/ticket-mode/pool-committed-files.test.ts
```

Mutation: make `holderClaimOf` ignore `committedFiles` and the three A11-452 cases in `overlap-hold.test.ts` and the recorded-files case in `pool-committed-files.test.ts` fail.

Consumer-declaration: none -- no host file key or contract changes.
