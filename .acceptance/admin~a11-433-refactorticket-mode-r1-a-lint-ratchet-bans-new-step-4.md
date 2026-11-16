## What it is

`src/ticket-mode/pair-command.ts` no longer makes a synchronous call (A11-433, step 4 of 5), and it leaves `blocking-calls.baseline.json`. `ticket:pair` used `spawnSync` to run the herdr web UI plugin's `pair` program. Now it runs it through `runOnThisTerminal`, an async `spawn` with the same stdio (inherited), working directory, environment and exit status. A program that cannot start still exits 1 with a message, which now names the call as `spawn` where it named `spawnSync` (`ticket:pair: spawn <bun> ENOENT`). `PairDeps.run` now returns a `Promise<number>`, and `runPair` awaits it.

The plan allowed this file to be excluded by name as a CLI entry point, but that option is not open. `capture-command.ts` imports `pairingCode` from this file, and `blocking-calls-commands.test.ts` refuses a named command that another module imports. So the file is converted instead.

## Acceptance

- `pair-command.ts` is no longer in the baseline, so the real ESLint config refuses a synchronous call there. `src/packaging/blocking-calls-ratchet.test.ts` still passes because the baseline only shrank.
- `src/ticket-mode/board-thread-sync-guard.test.ts` no longer allows `pair-command.ts`'s `spawnSync`.
- `src/ticket-mode/pair-command.test.ts` checks each behaviour below:
  - "runOnThisTerminal runs the plugin without holding the event loop…": the loop turns while the plugin runs, and the plugin's own exit status (3) is returned.
  - "…runs the program in its working directory, under its environment over this process's": the program gets its own cwd and env, and still inherits `PATH`.
  - "…answers 1 and says why when the program cannot start": the result is 1, and stderr gets `ticket:pair: spawn /nonexistent/bun ENOENT`.
  - "…answers 1 when a signal ends the program": the result is 1.
- The existing `runPair` tests pass with their fakes made async.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint src/ticket-mode/pair-command.ts src/ticket-mode/pair-command.test.ts --quiet
! grep -n "pair-command" blocking-calls.baseline.json
! grep -nE "\b(spawnSync|execFileSync|execSync)\b" src/ticket-mode/pair-command.ts
AGENT_ORG_HOST= npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pair-command.test.ts src/packaging/blocking-calls-ratchet.test.ts src/packaging/blocking-calls-commands.test.ts src/ticket-mode/board-thread-sync-guard.test.ts'
```

Mutations:
- Make `runOnThisTerminal` call `spawnSync`. The event-loop test then fails with "the loop turned while the plugin ran (0 ticks of 10 ms in 300 ms)". The ENOENT test also fails, because the message reads `spawnSync`. `npx eslint src/ticket-mode/pair-command.ts` then fails with the A11-433 ban at the import.

Consumer-declaration: none. `PairDeps.run` is used only inside this repository.
