The pool's herdr calls go through the one outside client (A11-436, step 3 of 3), and `/api/health` serves one failure figure. A herdr call that never answers fails as transient when its time passes and counts once as a failed herdr call; a run whose `agent start` or `workspace create` herdr never answered ends crashed with the board's own retry scheduled and is started again after the back-off, with no person's retry; a herdr refusal (`agent_not_found`) is herdr answering, not a failed call; ten failed herdr calls in a row open herdr's breaker, which refuses the next call at once with "herdr is unavailable"; the probe of whether herdr's server is up is asked outside the breaker; `outsideCalls` (`src/ticket-mode/health-figures.ts`, a path the plan's `## Paths` names) is every service's calls summed and is worked out again when the page's calls are added; the health flags name herdr like the other services. Steps 1 and 2 (Linear, `gh`) are unchanged.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-herdr.test.ts src/ticket-mode/outside-client.test.ts src/ticket-mode/call-outcomes.test.ts src/ticket-mode/health-route.test.ts src/ticket-mode/health-flags.test.ts plugins/github/gh.test.ts plugins/linear/linear.test.ts
```

Mutation: in `src/ticket-mode/pool-start.ts`, drop `{ cause: err }` from the "herdr could not start Claude" error, and the agent-start test fails (`crashRetry` is undefined: the crash reads as a refusal). Drop `exit` from `herdrAnswer`'s failure in `src/herdr-agents.ts`, and the cut-at-its-bound test fails (`isTransient` is false). In `src/ticket-mode/health-figures.ts`, drop `outsideCalls`, and the snapshot test in `health-route.test.ts` fails.

Consumer-declaration: none -- no host file key changes. `/api/health`'s `figures.calls` gains a `herdr` entry, and `figures` gains `outsideCalls`; the board's header is bundled with the instance and moves with it.
