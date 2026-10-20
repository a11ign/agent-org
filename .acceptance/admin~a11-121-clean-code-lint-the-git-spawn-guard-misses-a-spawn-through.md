The git-spawn guard in `src/packaging/git-spawn-classification.test.ts` now classifies the first argument of every spawn call. A spawn whose command is not a literal is flagged unless its file scrubs `GIT_*` through a canonical helper or it is listed with a reason. Each failure says whether the command `resolves to git` or `cannot be shown not to be git`. A variable bound to `"git"` (followed through two bindings), a template string naming git, and a parameter the file does not bind are each covered by a test. `process.execPath` and a variable bound to a non-git literal are not flagged.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/packaging/git-spawn-classification.test.ts
```

Mutation: the variable case was broken to return `not-git` for every name, and the test file was run. Five tests went red, including `MUTATION: a spawn whose command is a variable bound to git is flagged, and says it resolves to git`. The line was restored and the file passes 23 of 23.

Consumer-declaration: none -- the guard is a test in this repository and reads only its own `src/`.
