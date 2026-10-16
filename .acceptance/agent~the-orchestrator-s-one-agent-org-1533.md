The tick hands `withOrchestratorOneShot` the row readers it already hands `withCeoOneShot`, through `withOneShotLanes` in `src/wake.ts`. With `workers.orchestratorOneShot` ON, a plain ready `lane:orchestrator` row is converted to a one-shot order to `engineers` with `briefRole: "orchestrator"`; a `fleet-gated` row keeps the gate's `orchestrator` order. With the flag OFF the very array comes back.

Acceptance: `node --test src/wake.test.ts src/orchestrator-one-shot.test.ts`

Mutation: the orchestrator's reader dropped from `withOneShotLanes` (`withOrchestratorOneShot(orders, { enabled, rowOf: rowRefOfOrder })`) failed `#1533: with the flag ON, a plain ready orchestrator row is converted, and a fleet-gated one keeps the gate's order` and passed the flag-OFF control. `src/wake.ts` was restored byte-identical (copied to a scratchpad backup, then `diff`).

Measured: `node --test src/wake.test.ts src/orchestrator-one-shot.test.ts` gives `pass 20, fail 0`; `pnpm run typecheck` exits 0 with no output. `pnpm test` (rstest, the whole suite) gives `113 of 11867 tests failed in 715 files`; the same 26 files that fail carry `113 of 760` with and without this change (the files import the tick or the work gate and fail on GitHub reads: rate limits and non-JSON answers), so none is from this change.

Closes a11ign/agent-org#1533
