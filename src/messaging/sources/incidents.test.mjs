// @ts-check
// THE INCIDENT SOURCES, AGAINST FIXTURES (a11ign/a11ign#2904 done-whens 1, 4 and 5). Each runs the real core and the in-memory provider
// on a clock the test owns, so the 30-minute hold-down is the CORE's and the `firstSeenAt` each source derives is what is on trial.
//
// POSITIVE CONTROLS, because "nothing was sent" is also what a source that never fires reports: every kind below has a fixture that
// produces its event and one, differing in a single field, that does not; the green-main fixture is asserted to send NOTHING, and the
// red one to send exactly once.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "../core.mjs";
import { createFakeProvider } from "../fake-provider.mjs";
import { createLedger } from "../ledger.mjs";
import { DEFAULT_INCIDENT_CONFIG, ciPermissionEvents, fleetDownEvents, gateCrashEvents, observeIncidents, trunkRedEvents } from "./incidents.mjs";
import { TICK_INTERVAL_MS } from "./stall.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

const scratch = mkdtempSync(join(tmpdir(), "messaging-incidents-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let ledgers = 0;

function messenger() {
  let at = NOW;
  const provider = createFakeProvider();
  const ledger = createLedger({ path: join(scratch, `ledger-${ledgers += 1}.jsonl`), now: () => at });
  const core = createMessenger({ provider, ledger, now: () => at });
  return { provider, set: (/** @type {number} */ ms) => { at = ms; }, tick: (/** @type {unknown[]} */ events) => core.tick(events) };
}

/** @param {string} conclusion @param {number} concluded @param {Record<string, unknown>} [more] */
const trunkRun = (conclusion, concluded, more = {}) => ({
  status: "completed", conclusion, head_sha: "abcdef0123456789", html_url: `https://example.test/runs/${concluded}`,
  created_at: iso(concluded - 20 * MINUTE), updated_at: iso(concluded), ...more,
});

describe("trunk red, held down for 30 minutes (done-when 1)", () => {
  /** A messenger over `main` that went red at `NOW`, observed `minutes` later. */
  async function observedAfter(/** @type {number} */ ...minutes) {
    const run = messenger();
    const red = [trunkRun("failure", NOW), trunkRun("success", NOW - HOUR)];
    for (const m of minutes) {
      run.set(NOW + m * MINUTE);
      await run.tick(trunkRedEvents(red, NOW + m * MINUTE));
    }
    return run;
  }

  test("red for 29 minutes sends NOTHING", async () => {
    assert.equal((await observedAfter(0, 10, 20, 29)).provider.sent.length, 0);
  });

  test("red for 31 minutes sends ONE message, however many ticks see it", async () => {
    const run = await observedAfter(0, 29, 31, 33, 35);
    assert.equal(run.provider.sent.length, 1);
    assert.match(run.provider.sent[0].text, /main is red: trunk\.yml failed at abcdef0/);
    assert.match(run.provider.sent[0].text, /https:\/\/example\.test\/runs\//);
  });

  test("going green sends ONE cleared and no more", async () => {
    const run = await observedAfter(31);
    run.set(NOW + 40 * MINUTE);
    const green = trunkRedEvents([trunkRun("success", NOW + 39 * MINUTE), trunkRun("failure", NOW), trunkRun("success", NOW - HOUR)], NOW + 40 * MINUTE);
    await run.tick(green);
    await run.tick(green);
    assert.equal(run.provider.sent.length, 2);
    assert.match(run.provider.sent[1].text, /^Cleared: /);
  });

  test("POSITIVE CONTROL: a green main sends nothing at all, and red-then-green inside the hold-down sends nothing either", async () => {
    const run = messenger();
    await run.tick(trunkRedEvents([trunkRun("success", NOW - MINUTE)], NOW));
    await run.tick(trunkRedEvents([trunkRun("failure", NOW - 10 * MINUTE)], NOW));
    run.set(NOW + 5 * MINUTE);
    await run.tick(trunkRedEvents([trunkRun("success", NOW + 4 * MINUTE), trunkRun("failure", NOW - 10 * MINUTE)], NOW + 5 * MINUTE));
    assert.equal(run.provider.sent.length, 0);
  });

  test("the streak starts at the FIRST red of the run of reds, so a second red does not restart the 30 minutes", () => {
    const [event] = trunkRedEvents([trunkRun("failure", NOW), trunkRun("failure", NOW - 25 * MINUTE), trunkRun("success", NOW - HOUR)], NOW);
    assert.equal(event.firstSeenAt, NOW - 25 * MINUTE);
  });

  test("a cancelled or running run says nothing about main: it is looked through, in both directions", () => {
    const cancelled = { ...trunkRun("cancelled", NOW), conclusion: "cancelled" };
    const running = { status: "in_progress", conclusion: null, created_at: iso(NOW), updated_at: iso(NOW) };
    const [stillRed] = trunkRedEvents([cancelled, running, trunkRun("failure", NOW - 40 * MINUTE)], NOW);
    assert.equal(stillRed.resolved, false);
    const [stillGreen] = trunkRedEvents([cancelled, trunkRun("success", NOW - 40 * MINUTE)], NOW);
    assert.equal(stillGreen.resolved, true);
    assert.deepEqual(trunkRedEvents([cancelled, running], NOW), [], "no verdict at all is no event, not a clear");
  });
});

describe("the gate crashing (done-when 5)", () => {
  const config = DEFAULT_INCIDENT_CONFIG;
  const fresh = NOW - MINUTE;

  test("a failed unit produces the event, dated from its failure", () => {
    const [event] = gateCrashEvents({ failed: true, failedAt: NOW - 45 * MINUTE, lastRecordAt: fresh }, NOW, config);
    assert.equal(event.key, "incident:gate-crash");
    assert.equal(event.resolved, false);
    assert.equal(event.firstSeenAt, NOW - 45 * MINUTE);
  });

  test("a last record older than 3 intervals produces it too, dated from when the third interval passed", () => {
    const last = NOW - 10 * MINUTE;
    const [event] = gateCrashEvents({ failed: false, lastRecordAt: last }, NOW, config);
    assert.equal(event.resolved, false);
    assert.equal(event.firstSeenAt, last + 3 * TICK_INTERVAL_MS);
  });

  test("a healthy unit with a recent record does NOT, and a record just inside 3 intervals does not either", () => {
    assert.equal(gateCrashEvents({ failed: false, lastRecordAt: fresh }, NOW, config)[0].resolved, true);
    assert.equal(gateCrashEvents({ failed: false, lastRecordAt: NOW - 3 * TICK_INTERVAL_MS }, NOW, config)[0].resolved, true);
    assert.equal(gateCrashEvents({ failed: false, lastRecordAt: NOW - 3 * TICK_INTERVAL_MS - 1 }, NOW, config)[0].resolved, false);
  });

  test("a failed unit with no failure time, or a missing record time, cannot be read", () => {
    assert.throws(() => gateCrashEvents({ failed: true, lastRecordAt: fresh }, NOW, config), /failedAt/);
    assert.throws(() => gateCrashEvents(/** @type {any} */ ({ failed: false }), NOW, config), /lastRecordAt/);
    assert.throws(() => gateCrashEvents(/** @type {any} */ ({ lastRecordAt: fresh }), NOW, config), /failed/);
  });

  test("held down 30 minutes by the core: sends at 31, not at 29", async () => {
    const down = { failed: true, failedAt: NOW, lastRecordAt: NOW - MINUTE };
    const run = messenger();
    run.set(NOW + 29 * MINUTE);
    await run.tick(gateCrashEvents({ ...down, lastRecordAt: NOW + 28 * MINUTE }, NOW + 29 * MINUTE, DEFAULT_INCIDENT_CONFIG));
    assert.equal(run.provider.sent.length, 0);
    run.set(NOW + 31 * MINUTE);
    await run.tick(gateCrashEvents({ ...down, lastRecordAt: NOW + 30 * MINUTE }, NOW + 31 * MINUTE, DEFAULT_INCIDENT_CONFIG));
    assert.equal(run.provider.sent.length, 1);
  });
});

describe("the fleet down, from the state fleet-watch writes (done-when 5)", () => {
  const config = DEFAULT_INCIDENT_CONFIG;

  test("workers non-ready past fleet-watch's threshold produce the event, naming them, oldest first", () => {
    const [event] = fleetDownEvents({ state: { "worker-b": NOW - 15 * MINUTE, "worker-a": NOW - 40 * MINUTE } }, NOW, config);
    assert.equal(event.key, "incident:fleet-down");
    assert.equal(event.resolved, false);
    assert.match(String(event.text), /2 workers.*worker-a, worker-b/);
    assert.equal(event.firstSeenAt, NOW - 40 * MINUTE + 10 * MINUTE);
  });

  test("an empty state, and a worker that has only just gone non-ready, do NOT", () => {
    assert.equal(fleetDownEvents({ state: {} }, NOW, config)[0].resolved, true);
    assert.equal(fleetDownEvents({ state: { "worker-a": NOW - 9 * MINUTE } }, NOW, config)[0].resolved, true);
  });

  test("a state file that stopped being written is not a reading of the fleet", () => {
    assert.throws(() => fleetDownEvents({ state: {}, writtenAt: NOW - 2 * HOUR }, NOW, config), /written/);
    assert.equal(fleetDownEvents({ state: {}, writtenAt: NOW - MINUTE }, NOW, config)[0].resolved, true);
  });

  test("a state that is not name-to-time cannot be read", () => {
    assert.throws(() => fleetDownEvents({ state: /** @type {any} */ ([1]) }, NOW, config), /object/);
    assert.throws(() => fleetDownEvents({ state: { "worker-a": "soon" } }, NOW, config), /state\.worker-a/);
    assert.throws(() => fleetDownEvents(/** @type {any} */ (null), NOW, config), /object/);
  });

  test("a list of more than five workers says how many more rather than naming them all", () => {
    const state = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`worker-${index}`, NOW - HOUR]));
    assert.match(String(fleetDownEvents({ state }, NOW, config)[0].text), /8 workers.*and 3 more/);
  });
});

describe("CI permission failures (done-when 5)", () => {
  /** @param {string} name @param {number} concluded @param {string[]} messages */
  const ciRun = (name, concluded, messages) => ({
    name, status: "completed", conclusion: "failure", html_url: `https://example.test/${name}/${concluded}`,
    created_at: iso(concluded - 5 * MINUTE), updated_at: iso(concluded), annotations: messages.map((message) => ({ message })),
  });
  const REFUSED = ["Resource not accessible by integration"];

  test("a run whose annotation reads `Resource not accessible` produces the event, dated from the first such run", () => {
    const [event] = ciPermissionEvents([ciRun("pr-labels", NOW, REFUSED), ciRun("pr-labels", NOW - 50 * MINUTE, REFUSED), ciRun("pr-labels", NOW - 2 * HOUR, [])], NOW);
    assert.equal(event.key, "incident:ci-permission");
    assert.equal(event.resolved, false);
    assert.match(String(event.text), /pr-labels/);
    assert.equal(event.firstSeenAt, NOW - 50 * MINUTE);
  });

  test("a failing run with some OTHER annotation does NOT", () => {
    const [event] = ciPermissionEvents([ciRun("gate", NOW, ["Process completed with exit code 1."])], NOW);
    assert.equal(event.resolved, true);
  });

  test("a workflow that has been fixed stops counting while a still-broken one keeps the incident open", () => {
    const runs = [ciRun("fixed", NOW, []), ciRun("fixed", NOW - HOUR, REFUSED), ciRun("broken", NOW - 10 * MINUTE, REFUSED)];
    const [event] = ciPermissionEvents(runs, NOW);
    assert.equal(event.resolved, false);
    assert.match(String(event.text), /broken/);
    assert.doesNotMatch(String(event.text), /fixed/);
  });

  test("no completed runs at all is no event: nothing to say and nothing to clear", () => {
    assert.deepEqual(ciPermissionEvents([{ name: "gate", status: "in_progress", created_at: iso(NOW), updated_at: iso(NOW) }], NOW), []);
  });

  test("held down 30 minutes by the core, and cleared once", async () => {
    const runs = [ciRun("pr-labels", NOW, REFUSED)];
    const run = messenger();
    run.set(NOW + 29 * MINUTE);
    await run.tick(ciPermissionEvents(runs, NOW + 29 * MINUTE));
    assert.equal(run.provider.sent.length, 0);
    run.set(NOW + 31 * MINUTE);
    await run.tick(ciPermissionEvents(runs, NOW + 31 * MINUTE));
    run.set(NOW + 50 * MINUTE);
    const fixed = ciPermissionEvents([ciRun("pr-labels", NOW + 45 * MINUTE, []), ...runs], NOW + 50 * MINUTE);
    await run.tick(fixed);
    await run.tick(fixed);
    assert.equal(run.provider.sent.length, 2);
  });
});

describe("a reader that cannot read yields cannot-ask and NO event (done-when 4)", () => {
  const good = {
    readTrunkRuns: () => [trunkRun("failure", NOW - HOUR)],
    readGateUnit: () => ({ failed: true, failedAt: NOW - HOUR, lastRecordAt: NOW - MINUTE }),
    readFleetState: () => ({ state: { "worker-a": NOW - HOUR } }),
    readCiRuns: () => [{ name: "pr-labels", status: "completed", created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), annotations: [{ message: "Resource not accessible by integration" }] }],
  };

  test("POSITIVE CONTROL: with every read working all four incidents come back, unresolved", async () => {
    const lines = /** @type {string[]} */ ([]);
    const seen = await observeIncidents({ now: () => NOW, log: (line) => lines.push(line), readers: good });
    assert.deepEqual(seen.events.map((event) => event.key).sort(), ["incident:ci-permission", "incident:fleet-down", "incident:gate-crash", "incident:trunk-red"]);
    assert.ok(seen.events.every((event) => event.resolved === false));
    assert.deepEqual([seen.cannotAsk, lines], [[], []]);
  });

  for (const name of Object.keys(good)) {
    test(`${name} throwing: that kind has no event (not even a resolved one), one cannot-ask line, and the others still answer`, async () => {
      const lines = /** @type {string[]} */ ([]);
      const readers = { ...good, [name]: () => { throw new Error("gh: HTTP 502"); } };
      const seen = await observeIncidents({ now: () => NOW, log: (line) => lines.push(line), readers });
      assert.equal(seen.events.length, 3);
      assert.equal(seen.cannotAsk.length, 1);
      assert.match(lines[0], /^cannot-ask incident:[a-z-]+: .*HTTP 502/);
      const run = messenger();
      await run.tick(seen.events);
      assert.ok(run.provider.sent.every((message) => !/^Cleared/.test(message.text)), "a failed read is never a clear");
    });
  }

  test("a payload of the wrong shape is a failed read, not an empty one", async () => {
    const seen = await observeIncidents({ now: () => NOW, log: () => {}, readers: { ...good, readTrunkRuns: () => ({ workflow_runs: [] }) } });
    assert.equal(seen.cannotAsk[0].source, "incident:trunk-red");
    assert.equal(seen.events.some((event) => event.key === "incident:trunk-red"), false);
  });

  test("a reader that is not wired is named", async () => {
    const seen = await observeIncidents({ now: () => NOW, log: () => {}, readers: {} });
    assert.equal(seen.cannotAsk.length, 4);
    assert.match(seen.cannotAsk[0].reason, /readTrunkRuns/);
  });
});
