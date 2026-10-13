The canary's `blind-ticks` counts only the lanes the gate REFUSED. A repository the gate skipped by design (paced below the pool's reserve, or not named by an event) is still reported on the PARTIAL line, but it no longer samples as one blind tick, so switching pacing on no longer raises the counter that says the org is blind. Part 2 of agent-org#1329 (a `CANNOT_ASK` tick records its sample) is NOT in this change: it needs `machineryCanaryTick` in `org-health.ts` to keep the held-order clocks when no suppressions are passed, which is outside this row's Region.

Acceptance:
```bash
node --test src/work-gate.test.ts src/packaging/machinery-canary.test.ts
```

Consumer-declaration: none -- the canary's inputs change for paced and event-gated ticks only; no flag, option or output shape changes.
