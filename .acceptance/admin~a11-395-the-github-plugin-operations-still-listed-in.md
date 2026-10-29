## What it is

A11-395, step 2 of 2 (this completes the ticket). The GitHub plugin's `gh` operations that the board makes on an event (a merge queue removal, a red check, a branch that fell behind, a stack to merge, a pull request to close or comment on) ran `gh` through the synchronous `deps.exec` and held the board's loop while they ran. Code host contract 4.0 makes each of them answer a promise; the plugin runs them over `deps.execAsync`, and the board awaits each one where it called it. `armMerge` stays synchronous, with its reason in `STILL_SYNCHRONOUS`: nothing on the board's loop calls it.

## Change

- `src/plugins/contracts/code-host.ts`, `src/plugins/version.ts`, `plugins/github/package.json`: contract 4.0, `READ_MAJORS.codeHost` is `[4]`, and `sweepRetargetsAsync` (2.2) is folded into `sweepRetargets`.
- `plugins/github/code-host.ts`: each operation goes through `ghAsync`, and the writes through `writingAsync`, which drops what was read of the repositories they touched however they end.
- `src/plugins/fakes/code-host.ts` and `src/plugins/conformance/code-host.ts`: the fake answers promises, and the suite awaits them (`throws` is a check of a rejected promise).
- `src/ticket-mode/*`: every caller awaits (`pool-merge-queue`, `pool-checks`, `pool-foreign-checks`, `pool-watch`, `pool-closed-work`, `opened-pulls`, `pool-actions`, `server`, `pool-tracker`, `pool-restack-close`, `pool-base-merge`, `pool-cancelled-gate`, `pool-standoff`, `after-merge/sweep`, `wait-on/wait-read`, `dependency-updates`, `board-view/not-merging`), in the order and with the short-circuits they had.
- `plugins/github/sync-gh-guard.test.ts`: `STILL_SYNCHRONOUS` is `armMerge` alone; `ASYNCHRONOUS_EVENT_OPERATIONS` names every other operation and asserts it reaches `deps.execAsync` and never `deps.exec`; a new synchronous `gh` in `code-host.ts` still fails the guard.
- `docs/adr/0017-the-code-hosts-event-operations-answer-a-promise.md`, `docs/adr/0015-...`, `plugins/README.md`.

## What it proves

Every operation of the contract that ran `gh` synchronously answers a promise and runs `gh` over `execAsync` (the guard), the fake and the GitHub plugin pass the same conformance suite, typecheck passes, and a synchronous `gh` added to `code-host.ts` fails the guard.

Acceptance:
```bash
npm run typecheck
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/sync-gh-guard.test.ts plugins/github/conformance.test.ts plugins/github/code-host.test.ts src/plugins/fakes/code-host.test.ts src/ticket-mode/pool-merge-queue.test.ts src/ticket-mode/pool-checks.test.ts src/ticket-mode/pool-stack-merge.test.ts src/ticket-mode/pool-restack.test.ts src/ticket-mode/opened-pulls.test.ts src/ticket-mode/board-view/not-merging.test.ts
```

Consumer-declaration: the code host contract major changes from 3 to 4 (`plugins/github/package.json` `contract`, `READ_MAJORS.codeHost`); no command, flag or file a host declares changes.
