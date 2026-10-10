A red main wakes only the order that names it, not every manager order (a11ign#4887; carried from agent-org#726, item 2 of a11ign#4627).

Closes a11ign#4887

## What changes, and why

- **`triageOrder` no longer wakes unasked on `mainRed`.** The line was `order.mainRed === true || order.chairmanDirection === true`, and `mainRed` is the TRUNK's state, which the tick sets on every gate order (`wake.ts`: `withStalls.some(namesRedMain)`). So while any main was red the provider was never asked about any order. Measured by worker-4878 on a11ign#4878: 200 of 200 `via: none` orders on 2026-10-10 sit inside the 12:35:51Z to 16:51:41Z window a red `lab` main was red, none outside it.
- **It now reads `order.cause === RED_MAIN_CAUSE || order.chairmanDirection === true`:** the red main's OWN order (`trunk-red`) and a chairman direction wake before anything is asked. Every other order is asked, is still told `mainRed`, and `names-red-main` is the question that wakes it.
- **`RED_MAIN_CAUSE` moves from `triage-route.ts` to `triage-provider.ts`** (exported; the route already imports from the provider, so no cycle) and the route imports it back. One definition, not two.
- The provider test and the route case that pinned "a red main always wakes, and asks nobody" are rewritten to say what is now true, each with the negative control: main red plus another cause is asked and digests on a confident `asks-this-seat=no`.

## How you verified it

Run with `AGENT_ORG_HOST` set to a checkout holding `.agent-org/project.json` (an agent-org worktree has none); I used `/home/agent/repos/a11y-witness/.agent-org/host.json`. The row's literal `npx rstest run --config scripts/rstest/rstest.config.ts src/triage-provider.test.ts src/triage-route.test.ts` printed `VERDICT pass: 46 tests in 2 files`, and the command below prints `pass 46, fail 0`.

Done-when 1: an order with `mainRed: true` and another cause is asked and digests (provider test and route test); the red main's own order wakes with 0 asks, with and without `mainRed` in its state; a chairman direction still wakes with 0 asks.

Acceptance: `node --import tsx --test src/triage-provider.test.ts src/triage-route.test.ts`

Mutation: three single-line mutants of `triageOrder`'s early wake, each killing one test in each of the two files and no other: (1) the own-order wake never firing (`order.cause === RED_MAIN_CAUSE ||` removed), (2) the old always-wake restored (`order.mainRed === true ||`), (3) the chairman-direction wake never firing. Source restored with `cp` and `diff`ed byte-identical.

## Anything a reviewer should be sceptical of

- **`names-red-main`'s instruction text is unchanged and now matters more.** Every order sent during a red main carries `mainRed: true` and reaches the provider. If the model answers that question off the field and not off the event, every such order wakes at P >= 0.2 and the digest share stays collapsed inside a red window by a different route. This is NOT measured here (it cannot be offline); the digest share after this lands, read by agent-org#720, is the reading. I did not reword a calibrated question unmeasured.
- **A `trunk-red` order wakes even when its state carries no `mainRed`.** The order is itself the evidence main is red; waking costs a turn and never an order.
- **The rest of the suite has 20 failures that are not this change:** the same 20 fail on a clean `origin/main` (`src/packaging/*` and the milestone-clock tests; this host's installed `@a11ign/toolchain` predates the 0.7.1 the CI installs, so `@a11ign/toolchain/mjs-ratchet` does not resolve). Measured by diffing the two failure lists, not inferred.
- **The other half of agent-org#726 (per-question `readings`, the labelled sheet's options) is deliberately not carried**, as the row says.
