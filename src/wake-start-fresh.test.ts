// no-token: gh -- every `herdr` and `git` call here is an injected seam; nothing imported reaches the real one
/**
 * `wake.ts`, #4524: A CHAIRMAN ROW'S ORDER (`startFresh: true`) STARTS A FRESH ENGINEER ABOVE THE PILOT'S PACE LIMITS.
 *
 * Measured 2026-10-09: #4588 carried `priority:chairman` from the chairman, the gate put `startFresh: true` on its order, and `wake.ts` read
 * the field nowhere -- five ticks of `UNDELIVERED ... no engineer is idle and allowed to claim`. This drives the production entry (`deliver`)
 * with an EMPTY idle pool, as `wake-spawn-load-gate.test.ts` does, and the controls come first: the same order WITHOUT the flag is refused
 * for each pace limit, so a start with the flag is the flag's doing and not what the fixture always does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver as settlingDeliver, parseOrders, startsFresh } from "./wake.ts";
import { startedPanes } from "./packaging/started-pane.ts";

const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: () => {} });
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const overLoaded = () => ({ load: 98, cores: 16 });

const orderFor = (row: number, extra: Record<string, unknown> = {}) => ({
  session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`,
  prompt: `Ready row #${row} is unclaimed.`, ...extra,
});
const plain = orderFor(4588);
const chairman = orderFor(4588, { startFresh: true });

function recordingHerdr() {
  const calls: string[] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.includes("workspace") && args.includes("create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { run, started: () => calls.filter((c) => c.includes("agent start")) };
}
const BUSY = agents({ ceo: "working" });

test("#4524 CONTROL: a plain order at load 98 starts nothing", () => {
  const herdr = recordingHerdr();
  const got = deliver([plain], BUSY, [], { run: herdr.run, hostLoad: overLoaded });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /host load 98 is over its 16 cores/);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: a chairman order at load 98 with no engineer idle starts a fresh one for its row", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], BUSY, [], { run: herdr.run, hostLoad: overLoaded });

  assert.deepEqual(got.refused, []);
  assert.match(got.sent[0], /^worker-4588 <- engineers\/ready-row-unclaimed\/4588 \(STARTED /);
  assert.equal(herdr.started().length, 1);
});

test("#4524: a chairman order is started after the tick's allowance is spent; a plain one behind it is not", () => {
  const herdr = recordingHerdr();
  const got = deliver([orderFor(100), chairman, orderFor(101)], BUSY, [], { run: herdr.run });

  assert.deepEqual(got.sent.map((line) => line.split(" ")[0]), ["worker-100", "worker-4588"]);
  assert.equal(got.refused.length, 1);
  assert.match(got.refused[0], /^engineers\/ready-row-unclaimed\/101: .*MAX_SPAWNS_PER_TICK/);
});

test("#4524: it is at most ONE per row -- an address already holding a process refuses the second start", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], agents({ ceo: "working", "worker-4588": "working" }), [], { run: herdr.run });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /"worker-4588" is the address row #4588 would be named/);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: the safety checks still bind -- the memory floor refuses a chairman start", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], BUSY, [], { run: herdr.run, memory: () => "free memory is under the floor" });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /free memory is under the floor/);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: the claim's own eligibility still binds -- a row the claim would refuse is not started", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], BUSY, [], { run: herdr.run, claimable: () => "overlaps #1 in a11ign/agent-org" });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /overlaps #1 in a11ign\/agent-org/);
});

test("#4524: an idle engineer still takes the chairman order, and nothing new is started", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], agents({ ceo: "working", "worker-1": "idle" }), ["worker-1"], { run: herdr.run, hostLoad: overLoaded });

  assert.match(got.sent.join("\n"), /^worker-1 <- /);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: the flag lifts nothing for an order the pilot would not take", () => {
  assert.equal(startsFresh({ session: "engineers", cause: "ready-row-unclaimed", startFresh: true }), true);
  assert.equal(startsFresh({ session: "engineers", cause: "ready-row-unclaimed" }), false, "no flag");
  assert.equal(startsFresh({ session: "engineers", cause: "draft-awaiting-verdict", startFresh: true }), false, "not a pilot cause");
  assert.equal(startsFresh({ session: "ceo", cause: "ready-row-unclaimed", startFresh: true }), false, "not the engineer pool");
});

test("#4524: the field survives the gate-to-wake hand-off (`parseOrders`)", () => {
  const [parsed] = parseOrders(`${JSON.stringify(chairman)}\n`);
  assert.equal((parsed as { startFresh?: boolean }).startFresh, true);
});
