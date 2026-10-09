// no-token: gh -- nothing here reaches `gh`: the signal is a pure reading, the waker's record is a file in a temp directory, and every clock is passed in
/**
 * #3448: AN ORDER THAT WAITS ON A BUSY SESSION FOR OVER A QUARTER OF AN HOUR IS A STALL, AND `ceo` IS TOLD.
 *
 * #3406 held a green, approved draft for forty minutes behind a busy `orchestrator`, `prompt:session` to `ceo` reported a queue three deep with the oldest
 * 28 minutes old, and the only thing that said so was the chairman reading the pull request. The bound was an hour. THE BOUND IS WRITTEN OUT AS 15 MINUTES
 * IN THIS FILE, never as the constant, for `wake-busy-seat-deferral.test.ts`'s reason: a test built from the constant moves with it.
 *
 * Every "no signal" has its "signal" twin one minute apart (14 and 16), and each negative that is not about age differs from the positive in one field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORDER_STALL_MINUTES, SIGNALS, orderStallReading } from "../org-health.ts";
import { BUSY_SEAT_DEFERRAL_MS, CAPACITY_WAIT_LIMIT_MS, refusalReport, deferralAges, handoffBacklog, stalledOrdersOf, orderStallOrdersNow } from "../wake.ts";

const MINUTE = 60_000;
const T0 = 1_000_000_000_000;
const KEY = "orchestrator/draft-convinced-not-ready/pr-3406/caf5b440";
const BUSY = (key: string, seat = "orchestrator") => `${key}: "${seat}" is working`;
const at = (minutes: number) => (keys: string[]) => new Map(keys.map((k) => [k, minutes * MINUTE]));

type Stalled = Parameters<typeof orderStallReading>[0]["stalled"];

test("#3448: the bound is ONE named constant, fifteen minutes, and the waker's deferral limit is that constant", () => {
  assert.equal(ORDER_STALL_MINUTES, 15);
  assert.equal(BUSY_SEAT_DEFERRAL_MS, 15 * MINUTE, "the deferred order is raised at the same bound, not a second number");
  assert.equal(CAPACITY_WAIT_LIMIT_MS, 30 * MINUTE, "and the capacity wait keeps its own, measured, longer one (#3266)");
});

test("#3448 (2): a deferral aged 16 minutes is raised, and one aged 14 is not -- in the report and as a health signal", () => {
  const sixteen = refusalReport([BUSY(KEY)], at(16));
  assert.equal(sixteen.undelivered.length, 1, "POSITIVE CONTROL: over the bound it is `nowhere to go` after all");
  assert.match(sixteen.undelivered[0], /deferred 16 min, over the 15-minute limit for a seat mid-turn/);
  const fourteen = refusalReport([BUSY(KEY)], at(14));
  assert.deepEqual(fourteen.undelivered, []);
  assert.equal(fourteen.summary, null);
  assert.equal(fourteen.deferred.length, 1, "under the bound it is only DEFERRED, with its age");
  assert.equal(refusalReport([BUSY(KEY)], at(15)).undelivered.length, 0, "exactly 15 minutes is not yet over, as 60 was not");

  const over = orderStallReading({ now: T0 + 16 * MINUTE, stalled: [{ kind: "deferred", name: KEY, since: T0 }] });
  assert.equal(over.status, "tripped");
  assert.match(over.detail, new RegExp(KEY.replace(/[/]/g, "\\/")), "the signal names the order");
  assert.equal(orderStallReading({ now: T0 + 14 * MINUTE, stalled: [{ kind: "deferred", name: KEY, since: T0 }] }).status, "clear");
  assert.equal(orderStallReading({ now: T0 + 15 * MINUTE, stalled: [{ kind: "deferred", name: KEY, since: T0 }] }).status, "clear", "strictly over, as the report is");
});

test("#3448 (2): a standing seat's queue whose oldest entry is 16 minutes old is raised, and one at 14 is not", () => {
  const queue = (minutes: number): Stalled => stalledOrdersOf({ deferredSince: new Map(), emitted: new Set(),
    backlog: handoffBacklog([{ session: "ceo", queuedAt: T0 - minutes * MINUTE }, { session: "ceo", queuedAt: T0 - MINUTE }], T0), standing: new Set(["ceo"]), now: T0 });
  const sixteen = orderStallReading({ now: T0, stalled: queue(16) });
  assert.equal(sixteen.status, "tripped", "POSITIVE CONTROL");
  assert.match(sixteen.detail, /the queue of ceo \(16 min\)/, "it is the OLDEST entry that is read, not the newest one beside it");
  assert.equal(orderStallReading({ now: T0, stalled: queue(14) }).status, "clear");
});

test("#3448: what is NOT a stall -- a key the gate no longer emits, an `org-health` key, a capacity wait, and a queue of a seat that is not standing", () => {
  const deferredSince = new Map([[KEY, T0], ["ceo/org-health/order-deferred-too-long@x", T0], ["engineers/ready-row-unclaimed/3448", T0], ["reviewer-1/gone/1", T0]]);
  const facts = { deferredSince, emitted: new Set([KEY, "ceo/org-health/order-deferred-too-long@x", "engineers/ready-row-unclaimed/3448"]),
    backlog: handoffBacklog([{ session: "worker-9", queuedAt: T0 - 60 * MINUTE }], T0), standing: new Set(["ceo"]), now: T0 + 60 * MINUTE };
  assert.deepEqual(stalledOrdersOf(facts), [{ kind: "deferred", name: KEY, since: T0 }],
    "POSITIVE CONTROL: of five old things exactly the one the gate still emits and that is not about health or capacity stands");
  assert.deepEqual(stalledOrdersOf({ ...facts, emitted: new Set() }), [], "an order delivered since is not still waiting on the strength of an old file");
});

test("#3448: the tick builds ONE org-health order for `ceo` from the waker's own record, and says so when the record cannot be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "order-stall-"));
  try {
    const ledgerPath = join(dir, "wake-ledger");
    deferralAges(join(dir, "wake-deferred"), [KEY], T0);
    const lines: string[] = [];
    const tick = (minutes: number, over: Record<string, unknown> = {}) => orderStallOrdersNow({ ledgerPath, emitted: new Set([KEY]), backlog: [], now: T0 + minutes * MINUTE,
      log: (line: string) => lines.push(line), standingSeats: () => ["ceo"], ...over });
    const [order] = tick(16);
    assert.equal(order.session, "ceo");
    assert.equal(order.cause, "org-health");
    assert.equal(order.subject, SIGNALS.ORDER_STALLED);
    assert.match(order.prompt, /order-deferred-too-long/);
    assert.deepEqual(tick(14), [], "the same record 2 minutes younger raises nothing");
    assert.deepEqual(tick(16), tick(16), "byte-identical across ticks, so the waker's ledger delivers it once");

    assert.deepEqual(tick(16, { standingSeats: () => { throw new Error("sessions.json: unreadable"); } }), [], "an unreadable roster raises nothing...");
    assert.match(lines.join(""), /order-deferred-too-long UNKNOWN -- sessions\.json: unreadable; it is not read as clear/, "...and says so");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
