// @ts-check
// THE WATCHED SOURCE, AGAINST THE REAL CORE AND THE REAL WATCHER (a11ign/a11ign#3418, acceptance 1 to 3). The ledger is a real file, the provider is the fake one, and the
// world is a table the test moves between ticks, so "the next tick" is the ledger's own memory.
//
// POSITIVE CONTROLS: (1) is the non-empty control for (2): the same watch, the same ticks, one state moved. (3) is run with the end-on-terminal derivation in place and the
// second tick asserted EMPTY, and the unit watch (which has no final state) is asserted to keep being asked after the same number of ticks, so a derivation that ends everything
// breaks a case here and one that ends nothing breaks another.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { normalizeEvent } from "../event.mjs";
import { createFakeProvider } from "../fake-provider.ts";
import { createLedger } from "../ledger.mjs";
import { WATCHED, runWatch } from "../watch.mjs";
import { activeWatches, createWatchList } from "../watch-list.mjs";
import { observeWatched } from "./watched.mjs";

// THE FIXTURE (the same in `sources/watched.test.mjs`, kept in each file so neither imports a test file nor widens this row's Region): a world whose things the test moves
// between ticks, answering as the placeholder vocabulary's `Readers`, and a ledger that already holds the chairman's message.
const TRACKER = "a11ign/a11ign";
/** The ref of a message the ledger took in from the chairman. */
const MESSAGE = "45";

const scratch = mkdtempSync(join(tmpdir(), "messaging-watch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextFile = 0;

/**
 * A ledger file of its own, holding the chairman's accepted message `MESSAGE` as the listener writes it. The clock is the test's, so a tick is a number.
 * @param {() => number} now @param {{ holdsMessage?: boolean }} [options]
 */
function freshLedger(now, { holdsMessage = true } = {}) {
  const ledger = createLedger({ path: join(scratch, `ledger-${nextFile += 1}.jsonl`), now });
  if (holdsMessage) ledger.append({ direction: "in", origin: "converse", messageRef: MESSAGE, updateId: 1 });
  return ledger;
}

/**
 * The vocabulary's readers over a table of states, keyed `row:<n>`, `pr:<n>`, `run:<n>`, `unit:<name>`. A thing not in the table THROWS, as a reader that cannot
 * answer does, and `asked` says what was read so an empty result is shown to have come from a source that looked.
 * @param {Record<string, string>} states
 */
function world(states) {
  const asked = /** @type {string[]} */ ([]);
  /** @param {string} thing @returns {string} */
  const read = (thing) => {
    asked.push(thing);
    if (states[thing] === undefined) throw new Error(`HTTP 404: no ${thing}`);
    return states[thing];
  };
  const unused = async () => { throw new Error("not a read this test makes"); };
  const readers = {
    issue: async (/** @type {number} */ number) => ({ number, state: read(`row:${number}`), labels: /** @type {string[]} */ ([]) }),
    pr: async (/** @type {number} */ number) => ({ number, state: read(`pr:${number}`), review: "none" }),
    run: async (/** @type {number} */ id) => ({ status: "completed", conclusion: read(`run:${id}`) }),
    unit: async (/** @type {string} */ name) => ({ state: read(`unit:${name}`) }),
    ready: unused, lastMerge: unused, comment: unused, fleet: unused, gate: unused, release: unused,
  };
  return { states, asked, readers };
}

let clock = Date.parse("2026-10-04T12:00:00Z");
const MINUTE = 60_000;
const now = () => clock;
/** A tick is two minutes of the clock, as the unit runs. */
const advance = () => { clock += 2 * MINUTE; };

/** @param {Record<string, string>} states a world with a ledger, a provider and a watch list over them */
function setup(states) {
  const fixture = world(states);
  const ledger = freshLedger(now);
  const provider = createFakeProvider();
  const watches = createWatchList({ ledger, readers: fixture.readers, now });
  const tick = async () => {
    advance();
    return runWatch({ github: {}, provider, ledger, now, repo: TRACKER, summary: null, watchReaders: fixture.readers, sources: [WATCHED] });
  };
  return { fixture, ledger, provider, watches, tick };
}

describe("(1) a watched pull request changing state yields ONE event", () => {
  test("add a PR, move it, and the next tick sends one line carrying the new state and a link", async () => {
    const { fixture, provider, watches, tick } = setup({ "pr:3333": "open" });
    assert.equal((await watches.add({ kind: "pr", id: "3333", ref: MESSAGE })).outcome, "done");
    fixture.states["pr:3333"] = "closed";
    const result = await tick();
    assert.deepEqual(result.decisions, [{ key: "watch:pr:3333", action: "sent" }]);
    assert.equal(provider.sent.length, 1, "the non-empty control for (2)");
    assert.equal(provider.sent[0].text, `PR #3333: now closed\nhttps://github.com/${TRACKER}/pull/3333`);
    assert.equal(provider.sent[0].silent, false, "it is news");
  });

  test("the event the source offers is a valid `watch` event, keyed by the thing and declaring the state", async () => {
    const { fixture, ledger, watches } = setup({ "row:3418": "open" });
    await watches.add({ kind: "row", id: "3418", ref: MESSAGE });
    fixture.states["row:3418"] = "closed";
    const { events, cannotAsk } = await observeWatched({ lines: ledger.read(), readers: fixture.readers, now, repo: TRACKER });
    assert.deepEqual(cannotAsk, []);
    const event = normalizeEvent(events[0]);
    assert.deepEqual([event.key, event.kind, event.state, event.text, event.resolved, event.firstSeenAt], ["watch:row:3418", "watch", "closed", "Row #3418: now closed", false, clock]);
  });

  test("each further change is its own line: open, then closed, then merged would be three, here a unit going active, failed, active is three", async () => {
    const { fixture, provider, watches, tick } = setup({ "unit:fleet-watch.service": "active" });
    await watches.add({ kind: "unit", id: "fleet-watch.service", ref: MESSAGE });
    for (const next of ["failed", "active"]) {
      fixture.states["unit:fleet-watch.service"] = next;
      await tick();
    }
    assert.deepEqual(provider.sent.map(({ text }) => text), ["Unit fleet-watch.service: now failed", "Unit fleet-watch.service: now active"]);
  });
});

describe("(2) no change yields none", () => {
  test("many ticks over an unchanged PR send nothing, and the PR WAS read each time", async () => {
    const { fixture, provider, watches, tick } = setup({ "pr:3333": "open" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    fixture.asked.length = 0;
    for (let i = 0; i < 3; i += 1) assert.deepEqual((await tick()).decisions, []);
    assert.equal(provider.sent.length, 0);
    assert.deepEqual(fixture.asked, ["pr:3333", "pr:3333", "pr:3333"], "an empty answer from a source that never asked would pass; this one asked");
  });

  test("a change that is undone before a tick is not told: the state is compared, not the fact that it moved", async () => {
    const { fixture, provider, watches, tick } = setup({ "pr:3333": "open" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    fixture.states["pr:3333"] = "closed";
    fixture.states["pr:3333"] = "open";
    await tick();
    assert.equal(provider.sent.length, 0);
  });

  test("no watches means no reads at all", async () => {
    const { fixture, provider, tick } = setup({ "pr:3333": "open" });
    await tick();
    assert.deepEqual([fixture.asked, provider.sent], [[], []]);
  });
});

describe("(3) reaching a final state yields one final event, and the watch is gone from `list`", () => {
  test("a PR that merges is told once, leaves the list, and the next ticks tell nothing and read nothing", async () => {
    const { fixture, provider, watches, tick } = setup({ "pr:3333": "open" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    assert.equal(watches.list().length, 1, "listed while it is open");
    fixture.states["pr:3333"] = "merged";
    await tick();
    assert.deepEqual(provider.sent.map(({ text }) => text.split("\n")[0]), ["PR #3333: now merged"]);
    assert.deepEqual(watches.list(), [], "gone from list once its final state was told");
    fixture.asked.length = 0;
    await tick();
    await tick();
    assert.equal(provider.sent.length, 1, "the second tick would tell again if removal on a final state were deleted");
    assert.deepEqual(fixture.asked, [], "and it is no longer even read");
  });

  test("the watch stays listed until the final state was TOLD: a send that failed is offered again, then ends", async () => {
    const { fixture, provider, watches, tick } = setup({ "row:3418": "open" });
    await watches.add({ kind: "row", id: "3418", ref: MESSAGE });
    fixture.states["row:3418"] = "closed";
    provider.failNext(new Error("telegram is down"));
    await tick();
    assert.equal(provider.sent.length, 0);
    assert.equal(watches.list().length, 1, "observed but not told: still watched");
    await tick();
    assert.deepEqual(provider.sent.map(({ text }) => text.split("\n")[0]), ["Row #3418: now closed"]);
    assert.deepEqual(watches.list(), []);
  });

  test("a PR closed without merging is final too; a unit has no final state and is still asked after the same ticks", async () => {
    const { fixture, provider, watches, tick } = setup({ "pr:1": "open", "unit:u.service": "active" });
    await watches.add({ kind: "pr", id: "1", ref: MESSAGE });
    await watches.add({ kind: "unit", id: "u.service", ref: MESSAGE });
    fixture.states["pr:1"] = "closed";
    fixture.states["unit:u.service"] = "inactive";
    await tick();
    await tick();
    assert.equal(provider.sent.length, 2);
    assert.deepEqual(watches.list().map(({ thing }) => thing), ["unit:u.service"]);
  });

  test("a thing added again after it ended is watched again only if it is not still in its final state", async () => {
    const { fixture, watches, tick } = setup({ "pr:1": "open" });
    await watches.add({ kind: "pr", id: "1", ref: MESSAGE });
    fixture.states["pr:1"] = "merged";
    await tick();
    assert.equal((await watches.add({ kind: "pr", id: "1", ref: MESSAGE })).outcome, "refused");
  });
});

describe("a thing that cannot be read is cannot-ask: it stays watched and the others are read", () => {
  test("a thrown read is named and tells nothing, and the readable watch beside it still reports", async () => {
    const { fixture, ledger, watches } = setup({ "pr:1": "open", "pr:2": "open" });
    await watches.add({ kind: "pr", id: "1", ref: MESSAGE });
    await watches.add({ kind: "pr", id: "2", ref: MESSAGE });
    delete fixture.states["pr:1"];
    fixture.states["pr:2"] = "closed";
    const logged = /** @type {string[]} */ ([]);
    const { events, cannotAsk } = await observeWatched({ lines: ledger.read(), readers: fixture.readers, now, repo: TRACKER, log: (line) => logged.push(line) });
    assert.deepEqual(events.map(({ key }) => key), ["watch:pr:2"], "the control: the readable one is told");
    assert.deepEqual(cannotAsk.map(({ source }) => source), ["watch:pr:1"]);
    assert.match(cannotAsk[0].reason, /404/);
    assert.match(logged[0], /cannot-ask watch:pr:1/);
    assert.deepEqual(activeWatches(ledger.read()).map(({ thing }) => thing).sort(), ["pr:1", "pr:2"], "neither was dropped");
  });
});

describe("the watcher constructs the source only when it is handed readers", () => {
  test("without `watchReaders` the source reads nothing, even with a watch in the ledger", async () => {
    const { fixture, ledger, provider, watches } = setup({ "pr:3333": "open" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    fixture.states["pr:3333"] = "merged";
    fixture.asked.length = 0;
    await runWatch({ github: {}, provider, ledger, now, repo: TRACKER, summary: null, sources: [WATCHED] });
    assert.deepEqual([fixture.asked, provider.sent], [[], []]);
  });
});
