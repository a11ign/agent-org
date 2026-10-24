## What it is

Step 1 of 2 of A11-219: the data the Atomaut Run detail draws for "What it will do" and the Worker row. A queue entry now carries `plannedSteps: [{ n, title }]`, read from the plan files already downloaded for the run (`planStepList`, `src/ticket-mode/plan-step-sections.ts`; `plannedStepsOf`, `src/ticket-mode/pool-plan-steps.ts`) when the run starts, and `currentStep`: the board's own step for a multi-pull-request plan at start, then the number the worker writes as `currentStep` in its outcome file (`checkOutcome` accepts it on every kind and refuses anything but a whole number of 1 or more; the pool reads it while the agent works and again when the outcome settles, `recordWrittenStep` in `src/ticket-mode/pool-settle.ts`). The brief tells a worker whose plan has numbered steps to write it. `worker: { instance, host }` is recorded when any run starts. `/api/queue` carries all three with no `server.ts` edit (`queueView` spreads the entries), and `ui/src/api/types.ts` exports `PlannedStep` and `RunWorker`. The event log is step 2.

## Acceptance

Acceptance:
```bash
bash -c 'set -euo pipefail
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/plan-step-sections.test.ts src/ticket-mode/outcome.test.ts src/ticket-mode/run-detail.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts
npm run typecheck
pnpm ui:typecheck'
```

Proof of each line of the ticket's step 1: steps read from a plan, in both shapes the plans use, a fenced heading skipped, none for a plan with no numbered steps (`plan-step-sections.test.ts`, the "A11-219" tests); the current step from an outcome, as written, while the run works and when it ends, and refused when it is 0, "2" or 1.5 (`outcome.test.ts`, `run-detail.test.ts`); the worker recorded at start with and without a plan (`run-detail.test.ts`, "a work run's plan steps are read" and "a run with no plan file"); the brief's `currentStep` line only for a plan with steps (`worker-files.test.ts`); a run with no plan carries no steps (`run-detail.test.ts`). The event log (the ticket's third section) is step 2 of the plan. Nothing in the ticket can only be proven after merge.

Consumer-declaration: none -- no option is added to a project declaration. `markStarting` gains an optional `worker` parameter, and the outcome file's `currentStep` is an optional key.
