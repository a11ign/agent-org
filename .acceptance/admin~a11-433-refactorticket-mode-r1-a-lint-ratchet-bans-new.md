## What it is

A new synchronous `gh`, `git` or `herdr` call in the board fails lint (A11-433, step 1 of 5). `eslint.config.ts` refuses `spawnSync`, `execFileSync` and `execSync` (as a named import, a renamed import, a call through the module object or a destructured name) and herdr's synchronous runners (`herdrRun`, `readAgents`, `readAgentSessions`, `openPane`, `closedNote`, imported, called by name or as a member, and any `.herdr(...)`) in `src/ticket-mode/` and `plugins/`. It skips test files, fixtures and the files `blocking-calls.baseline.json` lists. That file has two lists. `files` holds the 9 files that still make such a call, and it only shrinks. `commands` names the CLI entry points a person runs, each with its reason. The lint cache key and `check:changed`'s lint fallback now include the baseline, so a file dropped from it is linted again.

## Acceptance

`src/packaging/blocking-calls-ratchet.test.ts` checks the following:
- The real config, run by the real ESLint, fails `src/ticket-mode/pool-start.ts` when it gains an `execFileSync`, and the output names the file.
- Each form is refused in both folders. None is refused in a test file, outside the folders, in a baselined file or in a named command.
- Every listed file still makes such a call.
- The baseline lists no file that its base or the first baseline did not. Git sandbox controls show that an addition is refused by name and a drop passes.

`src/packaging/blocking-calls-commands.test.ts` checks that a named command is a program of `src/commands.ts` that no module imports.

`src/packaging/check-changed-lint-and-typecheck.test.ts` checks that the cache key moves with the baseline. `src/packaging/check-changed-selection.test.ts` checks that a baseline change lints the whole tree.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint eslint.config.ts scripts/lint-cache.ts src/packaging/blocking-calls-ratchet.test.ts src/packaging/blocking-calls-commands.test.ts scripts/rstest/select-tests.ts src/ticket-mode plugins --quiet
AGENT_ORG_HOST= npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/blocking-calls-ratchet.test.ts src/packaging/blocking-calls-commands.test.ts src/packaging/check-changed-lint-and-typecheck.test.ts src/packaging/check-changed-selection.test.ts src/ticket-mode/board-thread-sync-guard.test.ts'
```

Mutation: add `"src/ticket-mode/pool-start.ts"` to `files` in `blocking-calls.baseline.json`. The ACCEPTANCE test "the baseline only shrinks" then fails and names the file. Separately, delete `blockingCallBan,` from the end of `eslint.config.ts`'s export. The pool-start test and the forms test then fail.

Consumer-declaration: none. This is the repository's own lint and test, and no published surface changes.
