// no-token: gh -- pure: `withWaitingEdges` and `perPullRequestOrders` over in-memory pull requests and rows, the memory in a temp directory; nothing reaches `gh`, `git` or herdr
/**
 * #4606: THE GATE STOPS ORDERING A WORKER TO FIX A RED PULL REQUEST WHOSE ROW WAITS ON AN OPEN NATIVE `blockedBy` EDGE, UNTIL THE HEAD CHANGES OR THE EDGE CLOSES.
 *
 * THE READING, 2026-10-09: lab#48 (`f48145a4`, edges a11ign#4569 and agent-org#505), lab#52 (`ca8f40a4`, the same edges) and lab#49 (`a5b63eaf`, edge a11ign#4525) sat
 * red at unchanged heads, their rows waiting as data, and were ordered 5 to 9 times each against a cap of 3; `STUCK worker-4278/pr-checks-failing/pr-lab#49/a5b63eaf:
 * delivered 6 times and the cause is still true` then repeated for 63 minutes. THE ORDER THAT IS NEVER EMITTED CANNOT ESCALATE (`escalateStuck` reads only what `deliver`
 * sees), so "no STUCK line" is asserted as "no order", which is where the fix is.
 *
 * THE POSITIVE CONTROLS ARE THE POINT: every silence below has a twin that is NOT silent (the edge closed, a new head, no edge at all), so "emits nothing" is never a
 * function that returns `[]`. MUTATION, run by hand and recorded on the PR: `isWaitingRed` ALWAYS TRUE fails the closed-edge, new-head and no-edge cases; ALWAYS FALSE
 * fails the open-edge case and the replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perPullRequestOrders } from "./work-gate/pr-orders.ts";
import { withWaitingEdges, PR_WAITS_FILE } from "./work-gate/pr-waits.ts";
import { isWaitingRed } from "./red-pr.ts";
import { endedRuns } from "./wake.ts";

const HOME_REPO = "a11ign/a11ign";
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-09T16:00:00Z" }];
const ORDERED = "pr-checks-failing";

type Pr = Record<string, unknown>;
type Order = { cause: string; causeKey: string; session: string };

/** A lab pull request, as `codeReadings` stamps it: its own `repoKey` and `repo`, and the row it closes named in `closingIssuesReferences`. */
const labPr = (number: number, head: string, row: number, over: Pr = {}): Pr => ({
  number, repoKey: "lab", repo: "a11ign/lab", headRefOid: head, isDraft: false, statusCheckRollup: RED, headRefName: `agent/some-slug-${row}`,
  labels: [{ name: `session:worker-${row}` }], closingIssuesReferences: [{ number: row, repository: { nameWithOwner: HOME_REPO } }], ...over,
});
const row = (number: number, blockers: { number: number; state?: string }[]) => ({
  number, labels: [{ name: "in-progress" }, { name: `session:worker-${number}` }], blockedBy: { nodes: blockers, totalCount: blockers.length },
});

const HEAD_A = "a5b63eaf00000000000000000000000000000000";
const HEAD_B = "b6c74fb000000000000000000000000000000000";
const OPEN_EDGE = row(4278, [{ number: 4525, state: "OPEN" }]);
const CLOSED_EDGE = row(4278, [{ number: 4525, state: "CLOSED" }]);
const NO_EDGE = row(4278, []);

/** One tick of the gate over `prs`: the stamp (its memory in `dir`), then the orders. */
const ordersOf = (dir: string, prs: Pr[], rows: unknown[]): Order[] =>
  (perPullRequestOrders(withWaitingEdges(prs, rows as never, { dir, rowsRepo: HOME_REPO }), null, null) as Order[]).filter((o) => o.cause === ORDERED);

function inTemp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pr-waits-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a red PR whose owning row has an open edge emits no pr-checks-failing order, so no delivery count can reach a STUCK line", () => {
  inTemp((dir) => {
    for (let tick = 0; tick < 3; tick += 1) assert.deepEqual(ordersOf(dir, [labPr(49, HEAD_A, 4278)], [OPEN_EDGE]), [], `tick ${tick}`);
  });
});

test("the SAME PR with the edge closed emits it", () => {
  inTemp((dir) => {
    assert.deepEqual(ordersOf(dir, [labPr(49, HEAD_A, 4278)], [OPEN_EDGE]), [], "waiting first, so the memory holds the head");
    const [order] = ordersOf(dir, [labPr(49, HEAD_A, 4278)], [CLOSED_EDGE]);
    assert.ok(order, "a closed edge is a wait that has cleared");
    assert.equal(order.causeKey, "worker-4278/pr-checks-failing/pr-lab#49/a5b63eaf");
  });
});

test("the SAME PR with an open edge and a NEW head sha emits it", () => {
  inTemp((dir) => {
    assert.deepEqual(ordersOf(dir, [labPr(49, HEAD_A, 4278)], [OPEN_EDGE]), [], "the wait is recorded at HEAD_A");
    const [order] = ordersOf(dir, [labPr(49, HEAD_B, 4278)], [OPEN_EDGE]);
    assert.ok(order, "a push is new work, and a real defect on it still reaches its owner");
    assert.equal(order.causeKey, "worker-4278/pr-checks-failing/pr-lab#49/b6c74fb0");
    assert.ok(ordersOf(dir, [labPr(49, HEAD_B, 4278)], [OPEN_EDGE]).length === 1, "and it stays emitted at that head: the exemption does not move to the pushed head");
  });
});

test("a PR red with no edge emits it", () => {
  inTemp((dir) => {
    assert.equal(ordersOf(dir, [labPr(49, HEAD_A, 4278)], [NO_EDGE]).length, 1);
    assert.equal(ordersOf(dir, [labPr(49, HEAD_A, 4278)], []).length, 1, "and a row that was not read is not an edge either");
  });
});

test("a PR with no memory to consult is not stamped, so nothing here changes for a caller that names no directory", () => {
  const prs = [labPr(49, HEAD_A, 4278)];
  assert.deepEqual(withWaitingEdges(prs, [OPEN_EDGE], { rowsRepo: HOME_REPO }), prs);
  assert.equal((perPullRequestOrders(prs, null, null) as Order[]).filter((o) => o.cause === ORDERED).length, 1);
});

test("the first three keys write RESET when they stop being emitted", () => {
  inTemp((dir) => {
    const emittedFile = join(dir, "emitted");
    const tick = (pr: Pr, rows: unknown[]) => {
      const keys = ordersOf(dir, [pr], rows).map((o) => o.causeKey);
      return { keys, reset: endedRuns(keys, emittedFile) };
    };
    const A = "worker-4278/pr-checks-failing/pr-lab#49/a5b63eaf";
    const B = "worker-4278/pr-checks-failing/pr-lab#49/b6c74fb0";
    // 1. red and ordered, then the worker adds the edge: the key stops being emitted
    assert.deepEqual(tick(labPr(49, HEAD_A, 4278), [NO_EDGE]), { keys: [A], reset: [] });
    assert.deepEqual(tick(labPr(49, HEAD_A, 4278), [OPEN_EDGE]), { keys: [], reset: [A] });
    // 2. the edge closes at the same head: the key is emitted again, from nothing (the RESET above made its count start over)
    assert.deepEqual(tick(labPr(49, HEAD_A, 4278), [CLOSED_EDGE]), { keys: [A], reset: [] });
    // 3. waiting again, then a push: the old head's key stops, the new head's starts
    assert.deepEqual(tick(labPr(49, HEAD_A, 4278), [OPEN_EDGE]), { keys: [], reset: [A] });
    assert.deepEqual(tick(labPr(49, HEAD_B, 4278), [OPEN_EDGE]), { keys: [B], reset: [] });
    assert.deepEqual(tick(labPr(49, HEAD_B, 4278), [CLOSED_EDGE]), { keys: [B], reset: [] });
  });
});

test("replayed against 2026-10-09 (lab#48, #49, #52 with their edges open) the gate emits no pr-checks-failing order for them", () => {
  inTemp((dir) => {
    const rows = [row(4525, [{ number: 4569, state: "OPEN" }, { number: 505, state: "OPEN" }]), row(4567, [{ number: 4569, state: "OPEN" }, { number: 505, state: "OPEN" }]), OPEN_EDGE];
    const prs = [labPr(48, "f48145a400000000000000000000000000000000", 4525), labPr(52, "ca8f40a400000000000000000000000000000000", 4567), labPr(49, HEAD_A, 4278)];
    for (let tick = 0; tick < 30; tick += 1) assert.deepEqual(ordersOf(dir, prs, rows), [], `tick ${tick}`);
    // THE CONTROL: the same three, the edges gone, are three orders -- the replay is silent because of the edges and for no other reason.
    const cleared = rows.map((r) => ({ ...r, blockedBy: { nodes: [], totalCount: 0 } }));
    assert.deepEqual(ordersOf(dir, prs, cleared).map((o) => o.session).sort(), ["worker-4278", "worker-4525", "worker-4567"]);
  });
});

test("the memory is forgotten the tick the edge is gone, so a later wait begins at the head it meets", () => {
  inTemp((dir) => {
    const remembered = () => JSON.parse(readFileSync(join(dir, PR_WAITS_FILE), "utf8"));
    ordersOf(dir, [labPr(49, HEAD_A, 4278)], [OPEN_EDGE]);
    assert.deepEqual(remembered(), { "lab#49": HEAD_A });
    ordersOf(dir, [labPr(49, HEAD_B, 4278)], [CLOSED_EDGE]);
    assert.deepEqual(remembered(), {});
    assert.deepEqual(ordersOf(dir, [labPr(49, HEAD_B, 4278)], [OPEN_EDGE]), [], "the new wait is in force at HEAD_B");
  });
});

test("isWaitingRed: absent is not equal -- no stamp, no edges, no remembered head, or a different head excuses nothing", () => {
  const stamp = { edges: [4525], head: HEAD_A };
  assert.equal(isWaitingRed({ headRefOid: HEAD_A, waitingOn: stamp }), true);
  assert.equal(isWaitingRed({ headRefOid: HEAD_A }), false);
  assert.equal(isWaitingRed({ headRefOid: HEAD_A, waitingOn: { ...stamp, edges: [] } }), false);
  assert.equal(isWaitingRed({ headRefOid: HEAD_A, waitingOn: { edges: [4525] } }), false);
  assert.equal(isWaitingRed({ headRefOid: HEAD_B, waitingOn: stamp }), false);
  assert.equal(isWaitingRed({ waitingOn: { edges: [4525], head: "" } }), false, "two empty heads are not the same head");
});

test("an unwritable memory costs one stderr line and no order: the wait still holds for the tick that made it", () => {
  inTemp((tmp) => {
    const file = join(tmp, "file");
    writeFileSync(file, "x");
    const stamped = withWaitingEdges([labPr(49, HEAD_A, 4278)], [OPEN_EDGE] as never, { dir: join(file, "under-a-file"), rowsRepo: HOME_REPO });
    assert.equal(isWaitingRed(stamped[0] as never), true);
  });
});
