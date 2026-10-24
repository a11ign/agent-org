## What it is

A planning run's plan that fails to attach on a network error (`fetch failed`, a timeout, a reset) or a 5xx from the tracker is tried again by the board itself, from the files already on disk and without waking the planner. `isTransient` (`src/ticket-mode/attach-retry.ts`) tells such a failure from a refusal by the error's type, its `code` and a numeric `status`, never by its message. `attachFailed` (`src/ticket-mode/pool-settle.ts`) records the failure in the pool's `attachRetries`, puts "attaching the plan (retry N)" on the card of every ticket in the run, and the next tick after the wait (5 s, 30 s, 2 min) attaches again; the fourth failure ends the run Needs you, and a refusal ends it at once, naming it. A batch is tried again as a whole. The Linear plugin puts the HTTP `status` on the errors it throws, and the tracker contract is 1.7 for that.

## Acceptance

Acceptance:
```bash
bash -c 'set -euo pipefail
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/attach-retry.test.ts src/ticket-mode/pool-attach-retry.test.ts plugins/linear/linear.test.ts src/ticket-mode/pool.test.ts src/plugins src/install/doctor.test.ts
npm run typecheck
npx eslint src/ticket-mode plugins/linear --quiet'
```

Proof of each line of the ticket: a network error then success attaches with no person, the card text and the same files on the retry (`pool-attach-retry.test.ts`, "a network error then success attaches with no person"); four network failures, or four 503s, end Needs you ("four network failures end Needs you"); a 4xx ends Needs you at once ("a 4xx ends Needs you at once"); a batch retries whole ("a batch whose attach fails once with fetch failed is planned whole"); each error kind `isTransient` names (`attach-retry.test.ts`); the `status` on Linear's errors (`linear.test.ts`, "attachPlan() rejects with the status Linear answered with"). Nothing in the ticket can only be proven after merge.

Consumer-declaration: none -- no option is added to a project declaration. The tracker contract goes to 1.7 as an addition (an optional `status` on a thrown error), so a 1.6 tracker still passes and its 5xx reads as a refusal, as before.
