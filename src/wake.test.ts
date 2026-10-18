// no-token: gh -- every `herdr` and `git` call here is an injected seam; nothing imported reaches the real one
/**
 * `wake.ts`, agent-org#1520: A RED DEPENDENCY PULL REQUEST WITH NO ROW GETS AN ENGINEER.
 *
 * a11ign#5528 was red for eight hours with its `pr-checks-failing` order UNDELIVERED: every engineer had held a row (`one instance, one row`,
 * #2407), so `route` refused them all, and the spawn path refused the order for naming no row. Nothing started a process for a pull request.
 *
 * DRIVEN THROUGH `deliver`, the production entry, with each host reading as an injected seam (as `run` is). THE CONTROL IS FIRST: the same pool
 * and order, with the pool's engineers holding rows, starts one process; the refusal on main is what the other cases below change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver as settlingDeliver } from "./wake/clear-settle-ms.ts";
import { MAX_SPAWNS_PER_TICK } from "./wake/is-pull-request-spawn-order.ts";
import { withOneShotLanes } from "./wake/is-release-line.ts";
import { startedPanes } from "./packaging/started-pane.ts";

/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
const deliver: typeof settlingDeliver = (orders, agents, roster, deps) =>
  settlingDeliver(orders, agents, roster, { ...deps, sleep: noSettle });

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const reading = (load: number, cores = 16) => () => ({ load, cores });

/** Every engineer in the pool has held a row, so none of them may take a row-less order (#2407). */
const everyoneHeldARow = () => "has held #2131: one instance, one row (#2407)";

const POOL = ["worker-1", "worker-2"];
const IDLE_POOL = agents({ "worker-1": "idle", "worker-2": "idle", ceo: "working" });

/** a11ign#5528, red: the pull request is the unit, and it names no row. */
const redPullRequest = {
  session: "engineers", cause: "pr-checks-failing", causeKey: "engineers/pr-checks-failing/pr-5528/abcdef12",
  prompt: "Pull request #5528 has red checks on its head.",
};
const otherRedPullRequest = {
  session: "engineers", cause: "pr-checks-failing", causeKey: "engineers/pr-checks-failing/pr-5529/12345678",
  prompt: "Pull request #5529 has red checks on its head.",
};

/** A herdr that opens a workspace and starts whatever it is asked to, recording every call. */
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

test("#1520 CONTROL: a red pull request with no row starts one engineer, named for the pull request", () => {
  const herdr = recordingHerdr();
  const got = deliver([redPullRequest], IDLE_POOL, POOL, { run: herdr.run, hostLoad: reading(4), ineligibleReason: everyoneHeldARow });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 1, got.refused.join("\n"));
  assert.match(got.sent[0], /^worker-5528 <- engineers\/pr-checks-failing\/pr-5528\/abcdef12 \(STARTED /, got.sent[0]);
  assert.equal(herdr.started().length, 1, "a process was started");
});

test("#1520: the same pull request on the next tick, its engineer already running, starts nothing", () => {
  const herdr = recordingHerdr();
  const next = agents({ "worker-1": "idle", "worker-2": "idle", ceo: "working", "worker-5528": "working" });
  const got = deliver([redPullRequest], next, POOL, { run: herdr.run, hostLoad: reading(4), ineligibleReason: everyoneHeldARow });

  assert.deepEqual(herdr.started(), [], "no second process under the same address");
  assert.deepEqual(got.sent.filter((s) => s.includes("STARTED")), []);
});

test("#1520: two red pull requests in one tick start one process, the pace limit holding the other", () => {
  const herdr = recordingHerdr();
  const got = deliver([redPullRequest, otherRedPullRequest], IDLE_POOL, POOL, { run: herdr.run, hostLoad: reading(4), ineligibleReason: everyoneHeldARow });

  assert.equal(herdr.started().length, MAX_SPAWNS_PER_TICK);
  assert.equal(got.sent.length, 1);
  assert.equal(got.refused.length, 1);
  assert.ok(got.refused[0].includes(`this tick has already started ${MAX_SPAWNS_PER_TICK}`), got.refused[0]);
});

test("#1520: a red pull request over the host's load starts nothing, naming the load", () => {
  const herdr = recordingHerdr();
  const got = deliver([redPullRequest], IDLE_POOL, POOL, { run: herdr.run, hostLoad: reading(98), ineligibleReason: everyoneHeldARow });

  assert.deepEqual(herdr.started(), []);
  assert.deepEqual(got.sent, []);
  assert.ok(got.refused[0].includes("host load 98 is over its 16 cores"), got.refused[0]);
});

test("#1520: a row-less pull request is never asked about a claim, since it has no row to claim", () => {
  const herdr = recordingHerdr();
  let asked = 0;
  const claimable = () => { asked += 1; return "cannot tell which row this is about"; };
  const got = deliver([redPullRequest], IDLE_POOL, POOL, { run: herdr.run, hostLoad: reading(4), ineligibleReason: everyoneHeldARow, claimable });

  assert.equal(asked, 0, "claimable was not consulted");
  assert.equal(got.sent.length, 1, got.refused.join("\n"));
  assert.equal(herdr.started().length, 1);
});

/**
 * #1533: the tick hands the orchestrator's one-shot lane its row readers, as it does the ceo's. With them a plain ready `lane:orchestrator` PATH row becomes an order to
 * `engineers` with `briefRole: "orchestrator"`; a `fleet-gated` row keeps the gate's order. Before the readers were passed, every row kept the gate's order.
 * A row is a path row only when its Region declares a file (agent-org#1714), so the plain fixture declares one.
 */
const ORCHESTRATOR_ORDER = (row: number) => ({
  session: "orchestrator", cause: "ready-row-unclaimed", causeKey: `orchestrator/ready-row-unclaimed/agent-org#${row}`,
  prompt: `Ready row agent-org#${row} is unclaimed. Claim it as \`<you>\`.\n`,
});
const PLAIN_ROW = { body: "## Region\n\nREADME.md\n\n## Acceptance\n\n```bash\nnpx rstest run src/x.test.ts\n```\n", labels: [] as string[] };
const GATED_ROW = { ...PLAIN_ROW, labels: ["fleet-gated"] };

test("#1533 CONTROL: with the flag OFF, the tick's ready orders come back as the very array they were", () => {
  const orders = [ORCHESTRATOR_ORDER(832), ORCHESTRATOR_ORDER(833)];
  assert.equal(withOneShotLanes(orders, { enabled: () => false, readRow: () => PLAIN_ROW }), orders);
});

test("#1533: with the flag ON, a plain ready orchestrator row is converted, and a fleet-gated one keeps the gate's order", () => {
  const readRow = (row: number) => (row === 833 ? GATED_ROW : PLAIN_ROW);
  const [plain, gated] = withOneShotLanes([ORCHESTRATOR_ORDER(832), ORCHESTRATOR_ORDER(833)], { enabled: () => true, readRow });

  assert.equal(plain.session, "engineers");
  assert.equal((plain as { briefRole?: string }).briefRole, "orchestrator");
  assert.equal(plain.causeKey, ORCHESTRATOR_ORDER(832).causeKey, "the row the claim reads is the gate's own");
  assert.deepEqual(gated, ORCHESTRATOR_ORDER(833), "the gate's order stands");
});
