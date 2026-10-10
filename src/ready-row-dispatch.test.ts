// no-token: gh -- every `herdr`, `git` and `gh` call here is an injected seam; nothing imported reaches the real one
/**
 * `wake.ts`, agent-org#459 (epic a11ign/a11ign#4437, class `claimed-worker-stalled`): WHO A READY ROW IS OFFERED TO.
 *
 * Measured 2026-10-09 from `journalctl --user -u a11ign-work-tick`: `worker-4466` was started at 08:52 for its own row, never claimed anything, and was
 * then PROMPTED five times for five other rows (4475, 4408, 4275, agent-org#449, 4275) -- each `(no clear)` -- until the spare teardown ended it at 09:47.
 * Its idle address was the first the pool router found, and `engineerEligibility` refuses a spare only once it HAS held a row, so a spare that had held
 * none was eligible for every row and the spawn path (a fresh worker) was never reached. Every row it was offered was a cause key spent on a session
 * that was not going to claim it.
 *
 * Every case drives `deliver`, the production entry, as `wake-start-fresh.test.ts` does, with the pool's real eligibility composition
 * (`engineerEligibility` through `poolEngineerReason`) and a recording `herdr`. The controls come first in each group so a pass is the rule's doing
 * and not what the fixture always does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver as settlingDeliver, engineerEligibility, poolEngineerReason, splitRefusals, spareLabelForRow } from "./wake.ts";
import { startedPanes } from "./packaging/started-pane.ts";

const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: () => {} });
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));

const orderFor = (row: number, extra: Record<string, unknown> = {}) => ({
  session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`,
  prompt: `Ready row #${row} is unclaimed.`, ...extra,
});

/** A `herdr` that records every call and answers a pane start; `prompted` is the sessions a prompt was typed into. */
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
  return { run, calls: () => calls, started: () => calls.filter((c) => c.includes("agent start")) };
}

const HAIKU = { kind: "claude" as const, model: "claude-haiku-5-5", effort: "low", why: "the `tier:haiku` label", autocompactWindow: 100_000 };

/** The claim a spawn makes: always lands, names the worktree for the row, and reads the tier off `haikuRows`. */
const claimer = (haikuRows: number[] = []) => ({
  claim: (order: { causeKey: string }, role: string) => {
    const row = Number(/\/(\d+)$/.exec(order.causeKey)?.[1]);
    return { row, branch: `agent/row-${row}`, worktree: `/wt/${role}`, launchDir: `/wt/${role}` };
  },
  release: () => "",
  tier: (claimed: { row: number }) => (haikuRows.includes(claimed.row) ? HAIKU : null),
});

const isSpare = (label: string) => /^worker-\d+$/.test(label);

/**
 * The pool's eligibility as the tick composes it (`poolEligibility` + `poolEngineerReason`). `held` is what the registry says each spare has held, which
 * is how the production teardown records a row a spare was seen holding; a spare absent from it has held none.
 */
function pool(held: Record<string, number[]> = {}) {
  const instances = Object.fromEntries(Object.entries(held).map(([label, rows]) => [label, { spawnedAt: 0, rows }]));
  const eligibility = engineerEligibility({ spare: isSpare, instances, lookup: () => [], warn: () => {} });
  return poolEngineerReason(eligibility, () => null);
}

const BUSY = { ceo: "working" };

test("#459 CONTROL: a spare's OWN row still goes to that spare when it is idle -- the refused-first-prompt case `withSpareInstances` exists for", () => {
  const herdr = recordingHerdr();
  const got = deliver([orderFor(4466)], agents({ ...BUSY, "worker-4466": "idle" }), [],
    { run: herdr.run, ineligibleReason: pool(), claimer: claimer() });

  assert.deepEqual(got.refused, []);
  assert.match(got.sent[0], /^worker-4466 <- engineers\/ready-row-unclaimed\/4466/);
  assert.deepEqual(herdr.started(), []);
});

test("#459: an idle spare that never claimed is NOT prompted for another row; a fresh worker is started for it (the worker-4466 path)", () => {
  const herdr = recordingHerdr();
  const got = deliver([orderFor(4475)], agents({ ...BUSY, "worker-4466": "idle" }), [],
    { run: herdr.run, ineligibleReason: pool(), claimer: claimer() });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 1);
  assert.match(got.sent[0], /^worker-4475 <- engineers\/ready-row-unclaimed\/4475 \(STARTED /);
  assert.equal(herdr.started().length, 1);
  assert.ok(!herdr.calls().some((c) => c.includes("worker-4466")), "nothing was sent to the idle spare");
});

test("#459: an offer never targets a session that is not a fresh worker -- five rows over five ticks, one idle spare, none of them typed into it", () => {
  const rows = [4475, 4408, 4275, 449, 4275];
  const sent: string[] = [];
  const calls: string[] = [];
  for (const row of rows) {
    // ONE `herdr` PER TICK, as in production: the second 4275 is a later tick, in which the first start has not been listed.
    const herdr = recordingHerdr();
    const got = deliver([orderFor(row)], agents({ ...BUSY, "worker-4466": "idle" }), [], { run: herdr.run, ineligibleReason: pool(), claimer: claimer() });
    sent.push(...got.sent);
    calls.push(...herdr.calls());
  }

  assert.equal(sent.length, rows.length);
  for (const line of sent) assert.doesNotMatch(line, /^worker-4466 /);
  assert.ok(!calls.some((c) => c.includes("worker-4466")));
});

test("#459: when no fresh worker can start either, the refusal names the row, the reason and the holders -- the spare is named for ITS row", () => {
  const herdr = recordingHerdr();
  const claimsNothing = { ...claimer(), claim: () => ({ refusal: "B4: overlaps an open pull request" }) };
  const got = deliver([orderFor(4475)], agents({ ...BUSY, "worker-4466": "idle", "worker-4202": "working" }), [],
    { run: herdr.run, ineligibleReason: pool({ "worker-4202": [4202] }), claimer: claimsNothing });

  assert.deepEqual(got.sent, []);
  assert.equal(got.refused.length, 1);
  const line = got.refused[0];
  assert.match(line, /^engineers\/ready-row-unclaimed\/4475: /);
  assert.match(line, /worker-4466=[^,)]*#4466/, "the idle spare is named with the row it is for");
  assert.match(line, /worker-4202=working/);
  assert.match(line, /no spawn: /);
});

test("#459: a deferral behind a spare that waits for its own row is a CAPACITY wait, named with the row, reason and holders -- not a fault", () => {
  const herdr = recordingHerdr();
  // Two orders, one tick: the first takes the tick's one start, so the second is refused for the pace limit with the seats it saw in its line.
  const got = deliver([orderFor(4475), orderFor(4408)], agents({ ...BUSY, "worker-4466": "idle", "worker-4202": "working" }), [],
    { run: herdr.run, ineligibleReason: pool(), claimer: claimer() });
  const split = splitRefusals(got.refused);

  assert.equal(got.sent.length, 1);
  assert.equal(got.refused.length, 1);
  assert.match(got.refused[0], /^engineers\/ready-row-unclaimed\/4408: no engineer is idle and allowed to claim \(/);
  assert.match(got.refused[0], /worker-4466=is for #4466 only: one instance, one row \(#2407\)/);
  assert.match(got.refused[0], /worker-4202=working/);
  assert.deepEqual(split.faults, []);
  assert.equal(split.busy.length, 1);
  assert.equal(split.busy[0].key, "engineers/ready-row-unclaimed/4408");
});

test("#459 CONTROL (change 2): a holder does not occupy the slot a fresh start needs -- idle, done or working, the same row is started on a fresh worker", () => {
  // THE ROW'S PREMISE, TESTED AT A HOLDER THAT IS NOT AT THE ROW'S ADDRESS. `idle` and `done` are the statuses `idle-claimant.ts` reads as a stalled
  // holder (`IDLE_STATUSES`); `working` is the negative control the row asked for ("deferred while a holder is working"), and it is NOT deferred:
  // nothing in `route`, `spawnableRole` or `spawnWorker` counts a holder toward a slot, so the start does not depend on whether it is stalled.
  // The journal's 45 `ready-row-unclaimed` deferral lines, 2026-10-09 08:40-10:40 (`grep` of the unit's journal; classified by the `no spawn:` /
  // `MAX_SPAWNS_PER_TICK` / `host load` text): 36 the pace limit, 2 host load, 1 B4, and 6 an address held (#2469) -- tested in the next case.
  const results = ["idle", "done", "working"].map((status) => {
    const herdr = recordingHerdr();
    const got = deliver([orderFor(4475)], agents({ ...BUSY, "worker-4202": status }), [],
      { run: herdr.run, ineligibleReason: pool({ "worker-4202": [4202] }), claimer: claimer() });
    return { status, sent: got.sent, refused: got.refused };
  });

  for (const { status, sent, refused } of results) {
    assert.deepEqual(refused, [], `holder ${status}`);
    assert.match(sent[0], /^worker-4475 <- engineers\/ready-row-unclaimed\/4475 \(STARTED /, `holder ${status}`);
  }
});

test("#459 (change 2) THE ADDRESS: a holder at the address the row would be named for -- idle and done are offered the row, working is deferred", () => {
  // THE ONE PLACE A HOLDER OCCUPIES A SLOT THE ROW NEEDS. Elsewhere a fresh worker starts under the row's own name whatever the others do (the control
  // above); `spawnableRole` refuses only when the row's OWN ADDRESS holds a process (#2469). The journal's six such lines (2026-10-09 08:40-10:40) are all
  // row 4082, whose address `worker-4082` had been prompted for #4415 at 07:24 -- the change-1 path -- and held it until 08:36.
  const seat = (status: string, held: Record<string, number[]> = {}) => {
    const herdr = recordingHerdr();
    const got = deliver([orderFor(4475)], agents({ ...BUSY, "worker-4475": status }), [],
      { run: herdr.run, ineligibleReason: pool(held), claimer: claimer() });
    return { ...got, started: herdr.started(), prompted: herdr.calls().filter((c) => c.includes("worker-4475")) };
  };

  const idle = seat("idle");
  const working = seat("working");

  assert.deepEqual(idle.refused, [], "its own address, idle, never claimed: typed its own row again, not deferred");
  assert.match(idle.sent[0], /^worker-4475 <- engineers\/ready-row-unclaimed\/4475/);
  assert.deepEqual(idle.started, [], "and no second process was started under the address");
  assert.equal(working.sent.length, 0, "NEGATIVE CONTROL: the same holder working is not typed into and nothing is started over it");
  assert.equal(working.refused.length, 1);
  assert.match(working.refused[0], /^engineers\/ready-row-unclaimed\/4475: /);
  assert.match(working.refused[0], /worker-4475=working/, "the deferral names the holder and its status");
  assert.match(working.refused[0], /already holds a process \(working\)/, "and the reason");
});

test("#459 (change 2) THE ADDRESS, `done`: a spare that finished its turn without claiming its row is offered that row, not deferred behind itself", () => {
  const herdr = recordingHerdr();
  const got = deliver([orderFor(4475)], agents({ ...BUSY, "worker-4475": "done" }), [],
    { run: herdr.run, ineligibleReason: pool(), claimer: claimer() });

  assert.deepEqual(got.refused, []);
  assert.match(got.sent[0], /^worker-4475 <- engineers\/ready-row-unclaimed\/4475/);
});

test("#459 (change 3): a ready `tier:haiku` row is offered in the same circumstances as a Sonnet row, and starts on the Haiku profile", () => {
  // The circumstances that deferred rows in the journal, applied to both: the pool is full of holders and an idle spare that is not for this row.
  const seats = agents({ ...BUSY, "worker-4202": "working", "worker-4372": "idle", "worker-4466": "idle" });
  const eligibility = pool({ "worker-4202": [4202], "worker-4372": [4372] });
  const start = (row: number) => deliver([orderFor(row)], seats, [], { run: recordingHerdr().run, ineligibleReason: eligibility, claimer: claimer([4442]) });

  const sonnet = start(4475);
  const haiku = start(4442);

  assert.deepEqual([sonnet.refused, haiku.refused], [[], []]);
  assert.match(sonnet.sent[0], /^worker-4475 <- engineers\/ready-row-unclaimed\/4475 \(STARTED sonnet\/high\)$/);
  assert.match(haiku.sent[0], /^worker-4442 <- engineers\/ready-row-unclaimed\/4442 \(STARTED claude-haiku-5-5\/low\)$/);
});

test("#459: spareLabelForRow is what 'its own row' means: the family's prefix and the row's number", () => {
  assert.equal(spareLabelForRow({ row: 4466 }), "worker-4466");
  assert.equal(spareLabelForRow({ row: 481, key: "agent-org" }), "worker-agent-org-481");
});
