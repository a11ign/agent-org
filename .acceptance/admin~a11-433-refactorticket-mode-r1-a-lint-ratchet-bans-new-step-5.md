## What it is

`plugins/github/command-exec.ts` no longer makes a synchronous call (A11-433, step 5 of 5), and it leaves `blocking-calls.baseline.json`. Its `commandExec` (`spawnSync`) is now `commandExecAsync`, an async `spawn` that fills `deps.execAsync`. It answers as before: the status, stdout and stderr; no status and the reason when the program cannot start, runs past `timeoutMs` or prints more than 64 MiB; no status when a signal ends it; no stdin. The reason now reads `spawn …` where it read `spawnSync …`.

Its two users are CLI commands. `merge-flow-command.ts` and `stack-live-check-command.ts` now use `asyncGhRunner`. `runLiveCheck` (`stack-live-check.ts`) is async and drives `sweepRetargetsAsync`, the sweep the board runs.

## Acceptance

- `plugins/github/command-exec.test.ts`:
  - the loop turns while the program runs, and the status and output come back (fails on base: 0 ticks);
  - the env is laid over this process's;
  - stdin is closed at once;
  - ENOENT, ETIMEDOUT, ENOBUFS and a signal each answer a null status.
- `plugins/github/stack-live-check.test.ts`: the A11-106 cases pass over an async fake `gh`, with the same assertions.
- The baseline lost `command-exec.ts`, so the real ESLint refuses a synchronous call there. The ratchet test passes because the baseline only shrank. `board-thread-sync-guard.test.ts` and `sync-gh-guard.test.ts` no longer list it.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint plugins/github/command-exec.ts plugins/github/command-exec.test.ts plugins/github/merge-flow-command.ts plugins/github/stack-live-check.ts plugins/github/stack-live-check-command.ts --quiet
! grep -n "command-exec" blocking-calls.baseline.json
! grep -nE "\b(spawnSync|execFileSync|execSync)\b" plugins/github/command-exec.ts
AGENT_ORG_HOST= npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/command-exec.test.ts plugins/github/stack-live-check.test.ts plugins/github/stack-live-check-command.test.ts plugins/github/sync-gh-guard.test.ts src/packaging/blocking-calls-ratchet.test.ts src/packaging/blocking-calls-commands.test.ts src/ticket-mode/board-thread-sync-guard.test.ts'
```

Mutations:
- Put `main`'s `spawnSync` body behind `commandExecAsync`. The event-loop test then fails with "the loop turned while the program ran (0 ticks of 10 ms in 300 ms)". The ENOENT, ETIMEDOUT and ENOBUFS tests fail only on the `spawnSync` prefix. `npx eslint plugins/github/command-exec.ts` fails with the A11-433 ban at the import and the call.

Consumer-declaration: none. `commandExec` was used only by the two commands in this repository.
