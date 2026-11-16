## What it is

A check red on main gets a fix ticket that the board files and queues, and the pull requests held on it run again once the fix merges (A11-428).

A pull request can be held as "red on main / not this run's" (A11-179) on a check that no `Blocked-by:` line or refusal names an owner for. Its hold now records the check's last error lines (`unowned`). The board's dependency sweep asks the ticket writer for one fix ticket for each repository and check, keyed `main-red:<owner/name>:<check>` in `dependency-tickets.json`. The request is built from checked fields only, with the error lines quoted as data. The sweep queues the one ticket the writer made on the saved choice, and asks again later after a run that made none. Each held card names the fix: "a fix ticket is being filed", then "owned by <ticket>". When the fix's pull request merges, each held pull request is brought up to date with main, so its checks run again with the fix in them. This works whether or not main runs CI. Red again after that is the pull request's own: the A11-300 rerun, then a round. `tickets.fixRedMain` (default true) turns all of this off.

## Acceptance

`src/ticket-mode/main-red/held-checks.test.ts` covers the hold, the cards, the request, the owner precedence, the update on merge, red again after it, a fix that does not land, stale records and the off switch. `src/ticket-mode/main-red/sweep.test.ts` covers the writer request, the queueing with the saved choice, the retry after a run that made nothing, and the off switch through the board's own sweep. The existing A11-179, A11-215 and A11-300 suites (`pool-checks*.test.ts`) still pass.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint src/ticket-mode/main-red src/ticket-mode/pool-checks.ts src/ticket-mode/pool-context.ts src/ticket-mode/settings.ts src/ticket-mode/config-schema.ts src/ticket-mode/dependency-updates --quiet
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/main-red/ src/ticket-mode/pool-checks.test.ts src/ticket-mode/pool-checks-rerun.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/dependency-updates/'
```

Mutation: in `src/ticket-mode/pool-checks.ts`, make `updateOnFix` return null at its start. The tests in `held-checks.test.ts` that bring the held pull requests up to date when the fix merges then fail.

Consumer-declaration: none. This is ticket mode's own watch, sweep and host setting. `ticket:serve` is the only consumer, and the queue record only gains optional fields.
