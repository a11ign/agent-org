Every test that makes a git sandbox now goes through `src/lib/git-sandbox.ts`: the toolchain's `withGitSandbox`, over a repository with `maintenance.auto=false` and `gc.auto=0`, whose removal is run again, whole, while a late writer keeps putting files into the tree, and counts as done only when the directory has stayed gone for 25 ms. A directory that outlives 20 removals is described on stderr and then refused by the toolchain's own `SandboxNotRemovedError`; a refusal that is not transient (`EACCES`) is thrown on the first try. `src/lib/git-sandbox.test.ts` starts a child that writes into the sandbox in a tight loop for 600 ms and sees the directory removed, with the toolchain's helper as the control that the writer defeats one removal. The cause of the two CI failures was NOT established (it did not reproduce in 80 runs of the file); the pull request body says what was and was not shown.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/lib/git-sandbox.test.ts src/packaging/region-paths-checkout.test.ts
```

Consumer-declaration: none -- a test helper and the test files that import it; no module the tool runs imports them.
