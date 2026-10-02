// @ts-check
// THE STALL SOURCES, AGAINST FIXTURES (a11ign/a11ign#2904 done-whens 2, 3 and 4). Every case runs the real core and the in-memory
// provider on a clock the test owns, so "sent" means what the chairman would have received.
//
// POSITIVE CONTROLS, because "no event" is also what a source that never fires reports: the all-idle-with-an-empty-queue and the
// just-merged fixtures are asserted to produce NO message, and each sits beside the fixture that differs from it in ONE field and
// DOES. A source that always fires fails the first; one that never fires fails the second.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "../core.mjs";
import { createFakeProvider } from "../fake-provider.mjs";
import { createLedger } from "../ledger.mjs";
import { DEFAULT_STALL_CONFIG, TICK_INTERVAL_MS, allIdleEvents, noMergeEvents, observeStalls } from "./stall.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-02T12:00:00Z");

const scratch = mkdtempSync(join(tmpdir(), "messaging-stall-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let ledgers = 0;

/** A messenger on a test-owned clock, over a real ledger file. */
function messenger() {
  let at = NOW;
  const provider = createFakeProvider();
  const ledger = createLedger({ path: join(scratch, `ledger-${ledgers += 1}.jsonl`), now: () => at });
  const core = createMessenger({ provider, ledger, now: () => at });
  return { provider, tick: (/** @type {unknown[]} */ events) => core.tick(events), set: (/** @type {number} */ ms) => { at = ms; } };
}

const seats = (/** @type {string[]} */ ...states) => states.map((state, index) => ({ session: `seat-${index}`, state }));
const rows = (/** @type {number} */ count) => Array.from({ length: count }, (_, index) => ({ cause: "ready-row-unclaimed", row: 100 + index }));

/** Tick records newest first, one every tick interval, the newest at `NOW`. */
function history(/** @type {number} */ count, /** @type {{ seats: any[], orders: any[] }} */ shape) {
  return Array.from({ length: count }, (_, index) => ({ at: NOW - index * TICK_INTERVAL_MS, ...shape }));
}

const IDLE_FOR_THIRTY_MINUTES = Math.ceil(30 * MINUTE / TICK_INTERVAL_MS);

describe("all seats idle while rows wait (done-when 2)", () => {
  test("every seat idle with 4 rows waiting IS a stall event, and the core sends it once", async () => {
    const events = allIdleEvents(history(IDLE_FOR_THIRTY_MINUTES, { seats: seats("idle", "idle", "done"), orders: rows(4) }), NOW, DEFAULT_STALL_CONFIG);
    assert.equal(events.length, 1);
    assert.equal(events[0].key, "stall:all-idle");
    assert.equal(events[0].resolved, false);
    assert.match(String(events[0].text), /4 rows waiting/);
    const run = messenger();
    await run.tick(events);
    await run.tick(events);
    assert.equal(run.provider.sent.length, 1, "the same stall observed twice is ONE message");
  });

  test("POSITIVE CONTROL: every seat idle with an EMPTY queue is not a stall, and nothing is sent", async () => {
    const events = allIdleEvents(history(IDLE_FOR_THIRTY_MINUTES, { seats: seats("idle", "idle", "idle"), orders: [] }), NOW, DEFAULT_STALL_CONFIG);
    assert.deepEqual(events.map((event) => event.resolved), [true], "the only reading is the resolved one");
    const run = messenger();
    await run.tick(events);
    assert.equal(run.provider.sent.length, 0);
  });

  test("one busy seat is not a stall, however many rows wait", () => {
    const [event] = allIdleEvents(history(IDLE_FOR_THIRTY_MINUTES, { seats: seats("idle", "working", "idle"), orders: rows(4) }), NOW, DEFAULT_STALL_CONFIG);
    assert.equal(event.resolved, true);
  });

  test("a tick that records idle seats and orders is the normal moment before delivery: ONE record is no event", () => {
    assert.deepEqual(allIdleEvents(history(1, { seats: seats("idle", "idle"), orders: rows(4) }), NOW, DEFAULT_STALL_CONFIG), []);
  });

  test("the streak is dated from its FIRST tick, so firstSeenAt is the same on every observation", () => {
    const shape = { seats: seats("idle", "idle"), orders: rows(2) };
    const [early] = allIdleEvents(history(IDLE_FOR_THIRTY_MINUTES, shape), NOW, DEFAULT_STALL_CONFIG);
    const [later] = allIdleEvents([{ at: NOW + TICK_INTERVAL_MS, ...shape }, ...history(IDLE_FOR_THIRTY_MINUTES, shape)], NOW + TICK_INTERVAL_MS, DEFAULT_STALL_CONFIG);
    assert.equal(early.firstSeenAt, later.firstSeenAt);
  });

  test("a seat that works breaks the streak: only the ticks since count", () => {
    const stalled = { seats: seats("idle", "idle"), orders: rows(2) };
    const recent = history(3, stalled);
    const before = { at: NOW - 3 * TICK_INTERVAL_MS, seats: seats("working", "idle"), orders: rows(2) };
    assert.deepEqual(allIdleEvents([...recent, before], NOW, DEFAULT_STALL_CONFIG), [], "3 ticks is 6 minutes, under the 10");
  });

  test("the stall clears: idle then a busy seat gives ONE cleared message", async () => {
    const run = messenger();
    await run.tick(allIdleEvents(history(IDLE_FOR_THIRTY_MINUTES, { seats: seats("idle"), orders: rows(1) }), NOW, DEFAULT_STALL_CONFIG));
    run.set(NOW + MINUTE);
    const busy = history(IDLE_FOR_THIRTY_MINUTES, { seats: seats("working"), orders: rows(1) }).map((tick) => ({ ...tick, at: tick.at + MINUTE }));
    await run.tick(allIdleEvents(busy, NOW + MINUTE, DEFAULT_STALL_CONFIG));
    await run.tick(allIdleEvents(busy, NOW + MINUTE, DEFAULT_STALL_CONFIG));
    assert.equal(run.provider.sent.length, 2);
    assert.match(run.provider.sent[1].text, /^Cleared: /);
  });

  test("a stale or malformed tick record cannot be read, which is not 'fine'", () => {
    const old = [{ at: NOW - HOUR, seats: seats("idle"), orders: rows(1) }];
    assert.throws(() => allIdleEvents(old, NOW, DEFAULT_STALL_CONFIG), /old/);
    assert.throws(() => allIdleEvents([], NOW, DEFAULT_STALL_CONFIG), /no tick/);
    assert.throws(() => allIdleEvents([{ at: NOW, seats: "idle" }], NOW, DEFAULT_STALL_CONFIG), /ticks\[0\]/);
  });
});

describe("no merge on main for N hours (done-when 3)", () => {
  const lastMergeAgo = (/** @type {number} */ ms) => noMergeEvents(NOW - ms, NOW, DEFAULT_STALL_CONFIG);

  test("5 h 59 m is NO event and sends nothing; 6 h 01 m is ONE event and sends one message", async () => {
    const quiet = messenger();
    assert.deepEqual(lastMergeAgo(5 * HOUR + 59 * MINUTE).map((event) => event.resolved), [true], "the reading itself is 'no stall', not an event the core happens to hold");
    await quiet.tick(lastMergeAgo(5 * HOUR + 59 * MINUTE));
    assert.equal(quiet.provider.sent.length, 0, "positive control: just under the threshold");
    const [fired] = lastMergeAgo(6 * HOUR + MINUTE);
    assert.equal(fired.resolved, false);
    assert.equal(fired.key, "stall:no-merge");
    const loud = messenger();
    await loud.tick([fired]);
    await loud.tick(lastMergeAgo(6 * HOUR + 2 * MINUTE));
    assert.equal(loud.provider.sent.length, 1, "observed again a minute later it is still one message");
    assert.match(loud.provider.sent[0].text, /6h 01m/);
  });

  test("firstSeenAt is when the threshold was crossed, the same on every tick", () => {
    const [a] = lastMergeAgo(7 * HOUR);
    const [b] = noMergeEvents(NOW - 7 * HOUR, NOW + 10 * MINUTE, DEFAULT_STALL_CONFIG);
    assert.equal(a.firstSeenAt, NOW - 7 * HOUR + 6 * HOUR);
    assert.equal(a.firstSeenAt, b.firstSeenAt);
  });

  test("a merge after the stall gives ONE cleared message and no more", async () => {
    const run = messenger();
    await run.tick(lastMergeAgo(8 * HOUR));
    run.set(NOW + MINUTE);
    const merged = noMergeEvents(NOW, NOW + MINUTE, DEFAULT_STALL_CONFIG);
    await run.tick(merged);
    await run.tick(merged);
    assert.deepEqual(run.provider.sent.map((message) => message.text.slice(0, 8)), ["Nothing ", "Cleared:"]);
  });

  test("the threshold is config", () => {
    const [event] = noMergeEvents(NOW - 2 * HOUR - MINUTE, NOW, { ...DEFAULT_STALL_CONFIG, noMergeHours: 2 });
    assert.equal(event.resolved, false);
  });

  test("a last-merge time that is not a time cannot be read", () => {
    assert.throws(() => noMergeEvents(/** @type {any} */ (null), NOW, DEFAULT_STALL_CONFIG), /lastMergeAt/);
  });
});

describe("a reader that cannot read yields cannot-ask and NO event (done-when 4)", () => {
  const good = { readTicks: () => history(IDLE_FOR_THIRTY_MINUTES, { seats: seats("idle"), orders: rows(2) }), readLastMerge: () => NOW - 7 * HOUR };

  test("POSITIVE CONTROL: with both reads working both events come back", async () => {
    const lines = /** @type {string[]} */ ([]);
    const seen = await observeStalls({ now: () => NOW, log: (line) => lines.push(line), readers: good });
    assert.deepEqual(seen.events.map((event) => event.key).sort(), ["stall:all-idle", "stall:no-merge"]);
    assert.deepEqual(seen.cannotAsk, []);
    assert.deepEqual(lines, []);
  });

  test("an API error on the merge read: no merge event, a logged cannot-ask, and the other source still answers", async () => {
    const lines = /** @type {string[]} */ ([]);
    const readers = { ...good, readLastMerge: () => { throw new Error("gh: HTTP 502"); } };
    const seen = await observeStalls({ now: () => NOW, log: (line) => lines.push(line), readers });
    assert.deepEqual(seen.events.map((event) => event.key), ["stall:all-idle"]);
    assert.equal(seen.cannotAsk[0].source, "stall:no-merge");
    assert.match(lines[0], /^cannot-ask stall:no-merge: .*HTTP 502/);
    assert.ok(!seen.events.some((event) => event.resolved === true && event.key === "stall:no-merge"), "never a false all-clear");
  });

  test("a rejected (async) read is the same, and so is a reader that is not wired", async () => {
    const seen = await observeStalls({ now: () => NOW, log: () => {}, readers: { readTicks: async () => { throw new Error("no file"); } } });
    assert.deepEqual(seen.events, []);
    assert.deepEqual(seen.cannotAsk.map((entry) => entry.source), ["stall:all-idle", "stall:no-merge"]);
    assert.match(seen.cannotAsk[1].reason, /readLastMerge/);
  });

  test("the logged reason has a token redacted, because a failed `gh` quotes its URL", async () => {
    const lines = /** @type {string[]} */ ([]);
    const secret = "bot123456:ABCdefGhIjKlMnOpQrStUvWxYz0123456789";
    await observeStalls({ now: () => NOW, log: (line) => lines.push(line), readers: { ...good, readLastMerge: () => { throw new Error(`fetch https://api.telegram.org/${secret}/x failed`); } } });
    assert.ok(!lines.join("\n").includes(secret));
  });
});
