## What it is

A fault-injection command that rehearses the board's known failure modes on a fixture instance (A11-439, step 1 of 2): `node scripts/fault-injection.ts [--scenario <name>]...`.

The fixture instance starts from ticket:capture's throwaway host file (`captureHost`, read back through `readTicketSettings`) in a throwaway directory, and runs the board's own pool (`createPool`) over in-memory fakes: the tracker contract's fake behind `faultyTracker` (Linear's 5xx, as the plugin throws it, while a fault is on), the code host contract's fake, the pool tests' herdr behind `faultyHerdr` (its server killed, then restored with every pane interrupted and its environment gone), an update drain in memory, a herdr service that only records, and git that refuses. Two scenarios run in this step: `linear-5xx` and `herdr-killed`. Each queues two runs, injects its fault on a schedule, lets scripted workers finish, and reads every run as its card shows it (`runStatus`, and the note lines the Runs page builds from the `board-view` builders). The report lists each run's status and reason, and the run log and the board's journal lines of every run left stuck with no reason shown. The command exits 0 when none is stuck, 1 when one is, 2 for an unknown scenario.

`fakeHerdr` moves from `pool-fixture.ts` to `fake-herdr.ts` unchanged (re-exported from the fixture), because `pool-fixture.ts` imports `node:test`'s hooks, which a command must not load.

## Acceptance

`src/ticket-mode/fault-injection/scenarios.test.ts` runs both scenarios through the command and checks that each fault reached the board, that every run ends on its worker's outcome, that the command reports no stuck runs and exits 0, and that no network call is made. A wedged agent after herdr's restart is listed as stuck with its run log, and the command exits 1. `stuck-runs.test.ts` holds what counts as stuck to the lines the Runs card draws (a stalled run is not stuck). `fault-tracker.test.ts` runs the tracker contract suite on the faulty tracker with its fault off, and checks the 5xx it throws with the fault on. `fault-herdr.test.ts`, `stuck-runs.test.ts` and `fixture-instance.test.ts` cover the herdr faults, what counts as stuck, the report, and the throwaway host file. `script.test.ts` runs the script itself.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint src/ticket-mode/fault-injection src/ticket-mode/fake-herdr.ts src/ticket-mode/pool-fixture.ts scripts/fault-injection.ts --quiet
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/fault-injection/ src/ticket-mode/pool-resume.test.ts src/ticket-mode/pool-watch-herdr-listing.test.ts
node scripts/fault-injection.ts'
```

Mutation: in `src/ticket-mode/fault-injection/stuck-runs.ts`, make `isStuck` return false. The wedged-agent test in `scenarios.test.ts` then fails, because the command exits 0 and lists no run log.

Consumer-declaration: none. The command is a development script under `scripts/`, which the package does not ship. Nothing an installed agent-org runs imports `src/ticket-mode/fault-injection/`, and `fakeHerdr` keeps its export from `pool-fixture.ts`.
