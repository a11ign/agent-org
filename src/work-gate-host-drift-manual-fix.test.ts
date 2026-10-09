// no-token: gh -- pure: `hostDriftOrders` over in-memory findings; nothing reaches `gh`, `git`, `herdr` or the network
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostDriftOrders } from "./work-gate.ts";

/**
 * #3703: A HOST DRIFT SET WHOSE FINDINGS ARE ALL `manualFix` IS NOT OFFERED TO `orchestrator`. The order's only remedy is `host:install`, which
 * writes no line of a person's login, so `orchestrator` declined it on every tick and the stuck breaker could not escalate a subject that is
 * `host-units` and not a row (30 consecutive ticks, 63 minutes, 2026-10-05).
 *
 * THE POSITIVE CONTROL FOR THE EMPTINESS ASSERTIONS is the second test: a mixed set still orders, so `hostDriftOrders` is not simply `[]`.
 *
 * WHERE "THE DETECTOR IS NOT WEAKENED" IS PINNED, because it cannot be here: `host:check` still reports every `manualFix` finding, and
 * `host-units.test.ts` (`#3643`, `humanLoginOnHost` and `hostUnitDrift` asserting `manualFix: true` on the real finding) holds that. This
 * file may not import `host-units.ts`: the acceptance job has no git history and that module reaches it (`addedOnSomeRef`). So the two
 * `manualFix` fixtures below COPY the detector's shape; if it ever drops the field, `host-units.test.ts` is where it goes red.
 */
const STALE = { unit: "a11ign-board-report.service", problem: "STALE", detail: "the installed copy differs from the one in the repository." };
const MANUAL_LOGIN = { unit: "/home/agent/.config/gh", problem: "HUMAN LOGIN ON THE HOST", manualFix: true, detail: "it is logged in as `DanBeckDev`." };
const MANUAL_CODEX = { unit: "/home/agent/repos/a11ign", problem: "CLONE NOT TRUSTED BY CODEX", manualFix: true, detail: "a trust grant is a ruling." };

test("#3703: a drift set of only manualFix findings is not delivered to orchestrator, on this tick or the next", () => {
  for (const set of [[MANUAL_LOGIN], [MANUAL_LOGIN, MANUAL_CODEX]]) {
    assert.deepEqual(hostDriftOrders(set), [], `${set.length} manual finding(s): nothing orchestrator can run clears them`);
    assert.deepEqual(hostDriftOrders(set), [], "and the same set a tick later mints no order under the same key either");
  }
});

test("#3703 CONTROL: a set holding one finding host:install CAN clear still orders orchestrator, with the full procedure, unchanged", () => {
  const [order, ...rest] = hostDriftOrders([MANUAL_LOGIN, STALE]);
  assert.deepEqual(rest, [], "one order for the whole set");
  assert.equal(order.session, "orchestrator");
  assert.equal(order.cause, "host-units-stale");
  // The key is the pre-#3703 one: every finding, manual included, sorted -- so an order already in the ledger is not re-minted by this change.
  assert.equal(order.causeKey, `orchestrator/host-units-stale/${[MANUAL_LOGIN, STALE].map((f) => `${f.unit}:${f.problem}`).sort().join(".")}`);
  assert.match(order.prompt, /2 finding\(s\)/, "the manual finding is still listed beside the one the remedy clears");
  assert.match(order.prompt, /THIS IS A DETECTOR, NOT AN INSTALLER/);
  assert.match(order.prompt, /SO READ BEFORE YOU RUN/, "the second-reading procedure is intact");
  assert.match(order.prompt, /pnpm run host:install/);
  assert.match(order.prompt, /REMOVED/);
  // CONTROL: the same finding on its own orders too, so the drop above is the manualFix and not the unit.
  assert.equal(hostDriftOrders([STALE]).length, 1);
});

test("#3703: the order ends by itself once the remedy has run and only the manual finding remains", () => {
  assert.equal(hostDriftOrders([MANUAL_LOGIN, STALE]).length, 1, "before host:install");
  assert.deepEqual(hostDriftOrders([MANUAL_LOGIN]), [], "after it: the STALE finding is gone, the person's login is not, and nobody is ordered");
});
