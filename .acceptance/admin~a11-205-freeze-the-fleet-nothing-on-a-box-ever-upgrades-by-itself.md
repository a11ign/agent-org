A fleet box that differs from control's pins manifest is announced: `incident:fleet-drift` is open while the hourly drift record (as `fleet-watch` mirrors it to `runs/fleet-drift-mirror.json`) lists a difference, names each box and field and no address, starts from the record's own `firstSeenAt`, and resolves when the record lists none. A missing, malformed or over-two-hours-old mirror or record is `cannot-ask`, never a clear. The four existing incidents are unchanged.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/sources/incidents.test.ts src/messaging/sources/readers.test.ts
```

Mutation: the source files (`incidents.ts`, `readers.ts`, `stall.ts`, `watch.ts`) were put back to `main` with the tests kept; 35 tests went red (every `fleetDriftEvents` and `readFleetDrift` case, and the five-incident counts), and the suite passed again with the change restored.

Consumer-declaration: `createReaders` gains a required `fleetDriftPath`; its only callers are `hostReaders` in `src/messaging/watch.ts` (updated) and `readersFor` in `readers.test.ts` (updated). `observeIncidents` now asks a fifth reader, `readFleetDrift`: a caller that wires none reads `cannot-ask incident:fleet-drift` and the other four are unchanged.
