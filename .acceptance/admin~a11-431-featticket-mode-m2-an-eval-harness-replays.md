The worker eval (A11-431, step 1 of 2): `node scripts/run-eval.ts --set <set>` reads a checked-in set of at most 10 merged tickets, works each one with a headless worker in a throwaway clone at its base sha with the current `briefText`, model and effort, and prints a table of tests passing, the reviewer's verdict, similarity to the merged diff, files touched outside it, tokens and wall time. Nothing leaves the machine: the clone's only remote is a local bare repository, git is limited to local paths, and `gh`, `agent-org` and the brief's worktree and pull-request commands are local stand-ins.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/run-eval.test.ts src/run-eval/ src/review-eval.test.ts
```

Mutation: drop `GIT_ALLOW_PROTOCOL` from `offlineEnv` (`src/run-eval/sandbox.ts`), and "a push to a URL that is not a local path is refused" fails. Have `cloneAt` fetch the source's `main` instead of the base sha, and "neither it nor its origin holds the merged answer" fails. Remove the `pr create` branch of the `gh` stand-in, and "`gh pr create` is recorded, never sent" fails. Drop `AGENT_ORG_HOST: noHost` from `offlineEnv`, and the offline-environment test and "the worker's environment names a host file that does not exist" fail. Count an unknown similarity as 0 in `totals`, and the table test fails on its mean.

Consumer-declaration: none -- no host file key or contract changes. The eval reads the host file's `clones`, `tickets.brief`, `plugins`, `drafts`, `prReview` and `binDir` as they are.
