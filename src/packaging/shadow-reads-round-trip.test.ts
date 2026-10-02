// Row #2849, constraint 4: the tapped `args` must survive a JSON round trip, so a `Map` or a `Date` added to `decide`'s arguments
// later fails HERE and not in a 48-hour shadow window. Its own file because it CALLS `decide` (see `shadow-reads.test.ts`'s header).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../work-gate.mjs";
import { SHADOW_READS_DIR, SHADOW_WINDOW_MARKER, parseShadowRecord, tapShadowReads } from "../shadow-reads.mjs";

const FIRST_TICK = 1_790_000_000_000;

/** A tick shaped like the gate's: plain arrays and objects, one open draft PR and one Ready row. */
const FIXTURE_ARGS = () => ({
  primaryDrift: null,
  prs: [{ number: 7, isDraft: true, headRefOid: "abc12345deadbeefcafe000011112222",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    author: { login: "worker-judge" }, comments: [{ body: "a comment" }], labels: [{ name: "lane:any" }] }],
  readyRows: [{ number: 9001, title: "a ready row", labels: [] }],
  promotableRows: [], chairmanBlocked: [], prFiles: [], drain: false,
});

// CONSTRAINT 4. `decide` is handed plain arrays and objects today, and also reads `Date.now()` itself, so the clock is pinned for
// the two calls: what is compared is the arguments' survival of JSON, not the time between two reads.
const survives = (args: unknown) => {
  const now = Date.now;
  Date.now = () => FIRST_TICK;
  try {
    const clone = JSON.parse(JSON.stringify(args));
    assert.deepEqual(clone, args, "the structure survives the round trip");
    assert.deepEqual(decide(clone as Parameters<typeof decide>[0]), decide(args as Parameters<typeof decide>[0]), "and so does what `decide` says about it");
  } finally {
    Date.now = now;
  }
};

test("the JSON round trip of `args` leaves `decide`'s answer unchanged on a fixture tick -- and that check can fail (positive control)", () => {
  const args = FIXTURE_ARGS();
  const before = JSON.stringify(args);
  survives(args);
  assert.equal(JSON.stringify(args), before, "and `decide` did not mutate its arguments, which the tap records AFTER the call");
  assert.ok(decide(args as Parameters<typeof decide>[0]).length > 0, "the fixture makes `decide` say something, so equal-and-empty is not the whole test");

  // A `Map` in the arguments serialises to `{}`, which is what a later change would do to a window nobody is watching.
  const withMap = { ...FIXTURE_ARGS(), prFiles: new Map([[7, ["a.ts"]]]) as unknown as never[] };
  assert.throws(() => survives(withMap), "a Map in `args` FAILS the round-trip check");
  const withDate = { ...FIXTURE_ARGS(), when: new Date(FIRST_TICK) };
  assert.throws(() => survives(withDate), "and so does a Date");
});

// --- #2858: the tap must write what `decide` NEEDS, and not only something that parses ---------------------------------------------
// `decide`'s `closings` is a `Map`, and `blockerClearedOrders` backs off on its CONTENT. Reviving only the type (an empty Map) replays 1 order against 2,
// so the equality below is made on a fixture in which a blocker is clearing and the order depends on what is in the map.
const CLOSED_AN_HOUR_AGO = FIRST_TICK - 3_600_000;

/** A tick in which row 2900, held by `worker-2900`, has its last blocker (#2846) closed an hour ago: a `blocker-cleared` order, staged by `closings`. */
const CLEARING_ARGS = () => ({
  ...FIXTURE_ARGS(),
  openRows: [{ number: 2900, labels: [{ name: "in-progress" }, { name: "session:worker-2900" }], blockedBy: { nodes: [{ number: 2846, state: "CLOSED" }] } }],
  closings: new Map([[2846, CLOSED_AN_HOUR_AGO]]),
});

const decideAt = (args: unknown) => {
  const now = Date.now;
  Date.now = () => FIRST_TICK;
  try {
    return decide(args as Parameters<typeof decide>[0]);
  } finally {
    Date.now = now;
  }
};
const blockerCleared = (orders: { cause: string }[]) => orders.filter((order) => order.cause === "blocker-cleared");

/** Write `args` with the real tap into a scratch open window and read the file back the way the runner does. */
function viaTheTap(args: unknown): { args: { closings?: Map<number, number> }; text: string; diagnostic?: string } {
  const dir = mkdtempSync(join(tmpdir(), "shadow-reads-rt-"));
  try {
    writeFileSync(join(dir, SHADOW_WINDOW_MARKER), "");
    const result = tapShadowReads({ args, orders: [], tick: FIRST_TICK, stateDir: dir, log: () => undefined });
    const text = readFileSync(join(dir, SHADOW_READS_DIR, `${FIRST_TICK}.json`), "utf8");
    return { args: parseShadowRecord(text).args, text, diagnostic: result.diagnostic };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("`decide` over the REVIVED arguments returns the same orders as over the original, with a blocker clearing (#2858)", () => {
  const original = CLEARING_ARGS();
  const expected = decideAt(original);
  assert.equal(blockerCleared(expected).length, 1, "the fixture makes a `blocker-cleared` order, so a revived-empty map has something to drop");
  const { args, diagnostic } = viaTheTap(original);
  assert.equal(diagnostic, undefined);
  assert.ok(args.closings instanceof Map && args.closings.get(2846) === CLOSED_AN_HOUR_AGO);
  assert.deepEqual(decideAt(args), expected, "the same orders, in the same order");
});

test("POSITIVE CONTROLS: a bare JSON.stringify of that fixture FAILS the equality, and so does a Map revived EMPTY", () => {
  const original = CLEARING_ARGS();
  const expected = decideAt(original);
  const bare = JSON.parse(JSON.stringify(original));
  assert.throws(() => decideAt(bare), /closings\.get is not a function/, "a Map written as {} makes `decide` throw, which is what #2846 measured on the live tick");
  const emptied = { ...original, closings: new Map<number, number>() };
  assert.notDeepEqual(decideAt(emptied), expected, "the TYPE alone is not enough: the order is computed FROM the map's content, so the check can fail on the shape that mattered");
});
