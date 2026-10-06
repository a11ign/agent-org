// no-token: gh -- `gh` is never reached: every read is handed a fake `run` and a fake `batch`.
/**
 * a11ign/a11ign#3566, slice 3: THE ANSWER-GIVEN LANE'S TIMELINE READS WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * `answerGivenOrders` read one `issues/{n}/timeline` per touched claimed row, each through the synchronous `defaultRun`, so the lane cost the SUM of the
 * reads. The fix moves WHEN they wait (`readWithFirstWaveTogether`, the batch slice 2 built) and nothing else, so what is pinned is:
 *   - the control: a `run` handed in (a test's stand-in for `gh`) is NOT batched, and reads its timelines one at a time, as before;
 *   - the touched, live rows' timelines arrive in ONE batch, and the orders are exactly what the one-at-a-time read returned;
 *   - a refusal on one row's timeline is that row's silence and nobody else's (#1286: "could not ask" is never "nothing there");
 *   - THE CAP CHOICE: every touched live row is read, even when `MAX_ROW_ORDERS_PER_TICK` would have stopped the loop early, because a row's order count
 *     is only known after its timeline is read, so no smaller set is provably enough. The orders returned are still the first `MAX_ROW_ORDERS_PER_TICK`;
 *   - a claimant herdr says is not live, and a row not touched inside the window, are never read, and herdr is asked once, not once per pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROW_ORDERS_PER_TICK, answerGivenOrders } from "./work-gate.mjs";
import { ANSWER_GIVEN_WINDOW_MS } from "./waiting-condition.mjs";

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };
type Order = { session: string, cause: string, subject: string };

const T0 = Date.parse("2026-10-05T07:14:32Z");
const NOW = T0 + 60_000;
const ANSWERER = "a11ign-ai-leads";
const FIRST_ROW = 3600;
const claimantOf = (n: number) => `worker-${n}`;
const claimedRow = (n: number, updatedAt = "2026-10-05T07:14:32Z") => ({ number: n, updatedAt, labels: [{ name: `session:${claimantOf(n)}` }, { name: "in-progress" }] });
const rows = (count: number) => Array.from({ length: count }, (_, i) => claimedRow(FIRST_ROW + i));
const liveAll = (count: number) => () => rows(count).map((row) => claimantOf(row.number));

/** An answered question on row `n`: asked 06:32, answered by a comment at 07:14:20 and the label off at 07:14:32 (#3566's own shape). */
const answeredTimeline = (n: number) => [
  { event: "labeled", label: { name: `session:${claimantOf(n)}` }, actor: "a11ign-ai-workers", created_at: "2026-10-05T06:00:00Z" },
  { event: "labeled", label: { name: "answer:product-manager" }, actor: "a11ign-ai-workers", created_at: "2026-10-05T06:32:28Z" },
  { event: "commented", actor: ANSWERER, id: n, created_at: "2026-10-05T07:14:20Z" },
  { event: "unlabeled", label: { name: "answer:product-manager" }, actor: ANSWERER, created_at: "2026-10-05T07:14:32Z" },
];
const silentTimeline = (n: number) => answeredTimeline(n).filter((event) => event.event === "labeled");
const ndjson = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const rowOf = (args: string[]) => Number(/issues\/(\d+)\/timeline/.exec(args[1])?.[1]);

/** What `gh` answers per call; `silent` names the rows whose question was never answered. */
const answerOf = (silent: number[] = []) => ({ args }: Call) => ndjson((silent.includes(rowOf(args)) ? silentTimeline : answeredTimeline)(rowOf(args)));
const refused = (): never => { throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" }); };

/** The `run` a test hands the gate: one call at a time, noted, refusing the rows `refuse` names the way `execFileSync` throws. */
function sequentialRun(seen: Call[], refuse: number[] = [], silent: number[] = []) {
  return (args: string[], repo?: string) => {
    seen.push({ args, repo });
    return refuse.includes(rowOf(args)) ? refused() : answerOf(silent)({ args, repo });
  };
}

/** A batch that answers as `answerOf` does and notes every call it was handed, one entry per BATCH. */
function fakeBatch(batches: Call[][], refuse: number[] = [], silent: number[] = []) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => (refuse.includes(rowOf(call.args))
      ? { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 }
      : { stdout: answerOf(silent)(call) }));
  };
}

const subjects = (orders: Order[]) => orders.map((order) => order.subject);

test("POSITIVE CONTROL: the one-at-a-time read of three answered rows orders all three, so the assertions below compare something", () => {
  const seen: Call[] = [];
  const orders = answerGivenOrders(rows(3), sequentialRun(seen) as never, NOW, liveAll(3)) as Order[];
  assert.deepEqual(subjects(orders), [3600, 3601, 3602].map((n) => `row-${n}`));
  assert.equal(seen.length, 3, "one timeline read per row");
  assert.ok(orders.every((order) => order.cause === "answer-given"));
});

test("CONTROL: a run handed in is not batched -- its calls arrive one at a time, as before", () => {
  const seen: Call[] = [];
  answerGivenOrders(rows(3), sequentialRun(seen) as never, NOW, liveAll(3));
  assert.deepEqual(seen.map(({ args }) => rowOf(args)), [3600, 3601, 3602], "each row once, in the order the rows came, and no rehearsal pass");
});

test("the timelines of the touched rows arrive in ONE batch, and the orders are what the one-at-a-time read returned", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = answerGivenOrders(rows(3), sequentialRun(seen) as never, NOW, liveAll(3), fakeBatch(batches));
  assert.equal(batches.length, 1, "one batch, not one per row");
  assert.deepEqual(batches[0].map(({ args }) => rowOf(args)), [3600, 3601, 3602]);
  assert.deepEqual(seen, [], "nothing left over to read one at a time: the real pass takes every answer from the batch");
  assert.deepEqual(together, answerGivenOrders(rows(3), sequentialRun([]) as never, NOW, liveAll(3)), "the same orders, in the same order");
});

test("a refusal on one row's timeline is that row's silence, beside the other rows' orders", () => {
  const batches: Call[][] = [];
  const orders = answerGivenOrders(rows(3), sequentialRun([]) as never, NOW, liveAll(3), fakeBatch(batches, [3601])) as Order[];
  assert.deepEqual(subjects(orders), ["row-3600", "row-3602"], "3601 is refused and has no order; 3600 and 3602 keep theirs");
  assert.deepEqual(orders, answerGivenOrders(rows(3), sequentialRun([], [3601]) as never, NOW, liveAll(3)), "the one-at-a-time read says the same");
});

test("a row whose timeline holds no answer orders nobody, in the same batch as the rows that do", () => {
  const batches: Call[][] = [];
  const orders = answerGivenOrders(rows(3), sequentialRun([]) as never, NOW, liveAll(3), fakeBatch(batches, [], [3600, 3602])) as Order[];
  assert.deepEqual(subjects(orders), ["row-3601"]);
  assert.equal(batches[0].length, 3, "its timeline was still asked for: only the read, never the verdict, moved");
});

test("THE CAP CHOICE: every touched live row is read, and the orders are still the first MAX_ROW_ORDERS_PER_TICK", () => {
  const count = MAX_ROW_ORDERS_PER_TICK + 3;
  const batches: Call[][] = [];
  const together = answerGivenOrders(rows(count), sequentialRun([]) as never, NOW, liveAll(count), fakeBatch(batches)) as Order[];
  const seen: Call[] = [];
  const oneByOne = answerGivenOrders(rows(count), sequentialRun(seen) as never, NOW, liveAll(count)) as Order[];
  assert.equal(together.length, MAX_ROW_ORDERS_PER_TICK);
  assert.deepEqual(together, oneByOne, "the cap cuts the same orders");
  assert.equal(seen.length, MAX_ROW_ORDERS_PER_TICK, "today's loop stops early: it read only 8 of the 11");
  assert.equal(batches[0].length, count, "the batch reads all 11, the price of not knowing in advance which rows will order");
});

test("a claimant herdr says is not live, and a row outside the window, are never read; herdr is asked once", () => {
  const batches: Call[][] = [];
  let asked = 0;
  const agents = () => { asked += 1; return [claimantOf(3600), claimantOf(3601), claimantOf(3603)]; };
  const stale = claimedRow(3603, new Date(NOW - ANSWER_GIVEN_WINDOW_MS - 60_000).toISOString());
  const orders = answerGivenOrders([claimedRow(3600), claimedRow(3601), claimedRow(3602), stale], sequentialRun([]) as never, NOW, agents, fakeBatch(batches)) as Order[];
  assert.deepEqual(subjects(orders), ["row-3600", "row-3601"], "3602 is not live and 3603 was not touched");
  assert.deepEqual(batches.flat().map(({ args }) => rowOf(args)), [3600, 3601]);
  assert.equal(asked, 1, "the rehearsal pass does not ask herdr a second time");
});

test("one live row is read on its own, with no batch: a batch of one saves nothing and costs a spawn", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const orders = answerGivenOrders(rows(1), sequentialRun(seen) as never, NOW, liveAll(1), fakeBatch(batches)) as Order[];
  assert.equal(orders.length, 1);
  assert.deepEqual(batches, []);
  assert.equal(seen.length, 1);
});
