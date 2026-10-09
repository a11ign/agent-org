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

import { createMessenger } from "../core.ts";
import { createFakeProvider } from "../fake-provider.ts";
import { createLedger } from "../ledger.ts";
import { DEFAULT_INCIDENT_CONFIG, ciPermissionEvents, fleetDownEvents, gateCrashEvents, observeIncidents, trunkRedEvents } from "./incidents.ts";
import { TICK_INTERVAL_MS } from "./stall.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (/** @type {number} */ ms: number) => new Date(ms).toISOString();

const scratch = mkdtempSync(join(tmpdir(), "messaging-incidents-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let ledgers = 0;

function messenger() {
  let at = NOW;
  const provider = createFakeProvider();
  const ledger = createLedger({ path: join(scratch, `ledger-${ledgers += 1}.jsonl`), now: () => at });
  const core = createMessenger({ provider, ledger, now: () => at });
  return { provider, set: (/** @type {number} */ ms: number) => { at = ms; }, tick: (/** @type {unknown[]} */ events: unknown[]) => core.tick(events) };
}

/** @param {string} conclusion @param {number} concluded @param {Record<string, unknown>} [more] */
const trunkRun = (conclusion: string, concluded: number, more: Record<string, unknown> = {}) => ({
  status: "completed", conclusion, head_sha: "abcdef0123456789", html_url: `https://example.test/runs/${concluded}`,
  created_at: iso(concluded - 20 * MINUTE), updated_at: iso(concluded), ...more,
});

describe("trunk red, held down for 30 minutes (done-when 1)", () => {
  /** A messenger over `main` that went red at `NOW`, observed `minutes` later. @param {number[]} minutes */
  async function observedAfter(...minutes: number[]) {
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
  const reading = (/** @type {Record<string, unknown>} */ more: Record<string, unknown>) => /** @type {any} */ ({ failed: false, lastRunAt: fresh, lastRecordAt: fresh, ...more });

  test("a failed unit produces the event, dated from its failure", () => {
    const [event] = gateCrashEvents(reading({ failed: true, failedAt: NOW - 45 * MINUTE }), NOW, config);
    assert.equal(event.key, "incident:gate-crash");
    assert.equal(event.resolved, false);
    assert.equal(event.firstSeenAt, NOW - 45 * MINUTE);
  });

  test("a last COMPLETED tick older than 3 intervals produces it too, dated from when the third interval passed", () => {
    const last = NOW - 10 * MINUTE;
    const [event] = gateCrashEvents(reading({ lastRecordAt: last }), NOW, config);
    assert.equal(event.resolved, false);
    assert.equal(event.firstSeenAt, last + 3 * TICK_INTERVAL_MS);
  });

  test("a healthy unit with a recent completion does NOT, and a completion just inside 3 intervals does not either", () => {
    assert.equal(gateCrashEvents(reading({}), NOW, config)[0].resolved, true);
    assert.equal(gateCrashEvents(reading({ lastRecordAt: NOW - 3 * TICK_INTERVAL_MS }), NOW, config)[0].resolved, true);
    assert.equal(gateCrashEvents(reading({ lastRecordAt: NOW - 3 * TICK_INTERVAL_MS - 1 }), NOW, config)[0].resolved, false);
  });

  test("a failed unit with no failure time, or a missing completion or run time, cannot be read", () => {
    assert.throws(() => gateCrashEvents(reading({ failed: true }), NOW, config), /failedAt/);
    assert.throws(() => gateCrashEvents(reading({ lastRecordAt: undefined }), NOW, config), /lastRecordAt/);
    assert.throws(() => gateCrashEvents(reading({ lastRunAt: undefined }), NOW, config), /lastRunAt/);
    assert.throws(() => gateCrashEvents(/** @type {any} */ ({ lastRunAt: fresh, lastRecordAt: fresh }), NOW, config), /failed/);
  });

  // THE 2026-10-02 OUTAGE (#3040): 63 ticks, each started and each died at import. The unit's own timestamp advanced on every one, so `lastRunAt` is
  // always fresh, and nothing ever wrote a completion record, so `lastRecordAt` stays at the last good tick.
  const TICKS = 63;
  const CRASH_START_MS = 1000;
  const OBSERVE_MS = 2000;

  test("63 consecutive ticks that start and crash: the unit reads inactive and moving after each, and the incident fires within 3 intervals", () => {
    const lastCompleted = NOW;
    const outcomes = Array.from({ length: TICKS }, (_, index) => {
      const started = lastCompleted + (index + 1) * TICK_INTERVAL_MS;
      const [event] = gateCrashEvents(reading({ lastRunAt: started + CRASH_START_MS, lastRecordAt: lastCompleted }), started + OBSERVE_MS, config);
      return { interval: index + 1, event };
    });
    const firstDown = outcomes.find(({ event }) => event.resolved === false);
    assert.equal(firstDown?.interval, config.gateStaleTicks, "the third crashed tick is past three intervals of silence");
    assert.ok(outcomes.slice(0, config.gateStaleTicks - 1).every(({ event }) => event.resolved === true), "two crashed ticks are still inside the allowance");
    assert.ok(outcomes.slice(config.gateStaleTicks - 1).every(({ event }) => event.resolved === false), "and it stays open for every later tick");
    assert.equal(outcomes[TICKS - 1].event.firstSeenAt, lastCompleted + config.gateStaleTicks * TICK_INTERVAL_MS, "dated from when the silence began, not from each look");
  });

  test("the text names the last COMPLETED tick and says ticks are still starting, not that the unit failed", () => {
    const lastCompleted = Date.parse("2026-10-02T15:22:41Z");
    const now = lastCompleted + 63 * TICK_INTERVAL_MS + OBSERVE_MS;
    const [event] = gateCrashEvents(reading({ lastRunAt: now - OBSERVE_MS, lastRecordAt: lastCompleted }), now, config);
    assert.equal(event.text, "The gate is down: the last tick that COMPLETED was at 2026-10-02T15:22:41.000Z (2h 12m ago), and ticks are still starting "
      + "(the unit last ran 0m ago) and not finishing, so they are crashing.");
    assert.doesNotMatch(String(event.text), /has failed/);
  });

  test("a unit that has not run either says the timer is not firing, and a failed one still says so", () => {
    const last = NOW - HOUR;
    const [silent] = gateCrashEvents(reading({ lastRunAt: last, lastRecordAt: last }), NOW, config);
    assert.match(String(silent.text), /the unit has not run since either \(it last ran 1h 00m ago\), so the timer is not firing/);
    const [failed] = gateCrashEvents(reading({ failed: true, failedAt: NOW - 45 * MINUTE, lastRecordAt: last, lastRunAt: fresh }), NOW, config);
    assert.match(String(failed.text), /the work-tick unit has failed and the last tick that COMPLETED/);
  });

  test("POSITIVE CONTROL: 63 ticks that COMPLETE (the record moving with the unit) are never an incident", () => {
    for (let index = 1; index <= TICKS; index += 1) {
      const started = NOW + index * TICK_INTERVAL_MS;
      const [event] = gateCrashEvents(reading({ lastRunAt: started + CRASH_START_MS, lastRecordAt: started + CRASH_START_MS }), started + OBSERVE_MS, config);
      assert.equal(event.resolved, true, `interval ${index}`);
    }
  });

  test("going green after the outage returns the same key resolved: the first completed tick closes it", () => {
    const [down] = gateCrashEvents(reading({ lastRecordAt: NOW - HOUR }), NOW, config);
    const [up] = gateCrashEvents(reading({ lastRecordAt: NOW }), NOW + 1000, config);
    assert.equal(up.key, down.key);
    assert.equal(up.resolved, true);
  });

  test("held down 30 minutes by the core: sends at 31, not at 29", async () => {
    const failedFromNow = (/** @type {number} */ at: number) => reading({ failed: true, failedAt: NOW, lastRunAt: at - MINUTE, lastRecordAt: at - MINUTE });
    const run = messenger();
    run.set(NOW + 29 * MINUTE);
    await run.tick(gateCrashEvents(failedFromNow(NOW + 29 * MINUTE), NOW + 29 * MINUTE, DEFAULT_INCIDENT_CONFIG));
    assert.equal(run.provider.sent.length, 0);
    run.set(NOW + 31 * MINUTE);
    await run.tick(gateCrashEvents(failedFromNow(NOW + 31 * MINUTE), NOW + 31 * MINUTE, DEFAULT_INCIDENT_CONFIG));
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
  const ciRun = (name: string, concluded: number, messages: string[]) => ({
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
    readGateUnit: () => ({ failed: true, failedAt: NOW - HOUR, lastRunAt: NOW - MINUTE, lastRecordAt: NOW - MINUTE }),
    readFleetState: () => ({ state: { "worker-a": NOW - HOUR } }),
    readCiRuns: () => [{ name: "pr-labels", status: "completed", created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), annotations: [{ message: "Resource not accessible by integration" }] }],
  };

  test("POSITIVE CONTROL: with every read working all four incidents come back, unresolved", async () => {
    const lines: string[] = /** @type {string[]} */ ([]);
    const seen = await observeIncidents({ now: () => NOW, log: (line) => lines.push(line), readers: good });
    assert.deepEqual(seen.events.map((event) => event.key).sort(), ["incident:ci-permission", "incident:fleet-down", "incident:gate-crash", "incident:trunk-red"]);
    assert.ok(seen.events.every((event) => event.resolved === false));
    assert.deepEqual([seen.cannotAsk, lines], [[], []]);
  });

  for (const name of Object.keys(good)) {
    test(`${name} throwing: that kind has no event (not even a resolved one), one cannot-ask line, and the others still answer`, async () => {
      const lines: string[] = /** @type {string[]} */ ([]);
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

describe("a sent incident says what it MEANS and what is being DONE (a11ign/a11ign#3424, #3419)", () => {
  const unresolved = {
    readTrunkRuns: () => [trunkRun("failure", NOW - HOUR)],
    readGateUnit: () => ({ failed: true, failedAt: NOW - HOUR, lastRunAt: NOW - MINUTE, lastRecordAt: NOW - MINUTE }),
    readFleetState: () => ({ state: { "worker-a": NOW - HOUR } }),
    readCiRuns: () => [{ name: "pr-labels", status: "completed", created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), annotations: [{ message: "Resource not accessible by integration" }] }],
  };
  const green = { readTrunkRuns: () => [trunkRun("success", NOW)], readGateUnit: () => ({ failed: false, lastRunAt: NOW, lastRecordAt: NOW }),
    readFleetState: () => ({ state: {} }), readCiRuns: () => [{ name: "pr-labels", status: "completed", created_at: iso(NOW), updated_at: iso(NOW), annotations: [] }] };
  const IMPACTS = {
    "incident:trunk-red": "Impact: Nothing can merge.",
    "incident:gate-crash": "Impact: No worker can be woken.",
    "incident:fleet-down": "Impact: Captures are paused.",
    "incident:ci-permission": "Impact: Pull requests waiting on the named workflows cannot get a passing check.",
  };
  const comment = (/** @type {string} */ text: string, /** @type {number} */ at: number = NOW - 25 * MINUTE) => ({ author: "a11ign-ai-workers", at, text });
  const observeWith = (/** @type {Record<string, unknown>} */ more: Record<string, unknown>) => observeIncidents({ now: () => NOW, log: () => {}, readers: { ...unresolved, ...more } });
  const lineOf = (/** @type {Record<string, unknown>} */ event: Record<string, unknown>, /** @type {string} */ name: string) => String(event.text).split("\n").find((line) => line.startsWith(`${name}:`));

  test("(1) each of the four kinds carries its Impact line from the table", async () => {
    const { events } = await observeWith({ readFixRow: () => null });
    assert.equal(events.length, 4);
    for (const event of events) assert.equal(lineOf(event, "Impact"), IMPACTS[/** @type {keyof typeof IMPACTS} */ (String(event.key))], String(event.key));
  });

  test("(2) with an open row and an org comment, Being done quotes the comment with its age, asked once per kind by the event's own key", async () => {
    const asked: string[] = /** @type {string[]} */ ([]);
    const { events } = await observeWith({ readFixRow: (/** @type {string} */ key: string) => { asked.push(key); return { number: 3500, comment: comment("re-running trunk on a fix") }; } });
    for (const event of events) assert.equal(lineOf(event, "Being done"), 'Being done: row #3500, a11ign-ai-workers 25m ago: "re-running trunk on a fix".');
    assert.deepEqual(asked.sort(), Object.keys(IMPACTS).sort());
  });

  test("(2) the quote is the comment itself: a different comment and a different age give a different line, and a long one is cut", async () => {
    const [older] = (await observeWith({ readFixRow: () => ({ number: 3501, comment: comment("fix is in review", NOW - 3 * HOUR) }) })).events;
    assert.equal(lineOf(older, "Being done"), 'Being done: row #3501, a11ign-ai-workers 3h 00m ago: "fix is in review".');
    const [long] = (await observeWith({ readFixRow: () => ({ number: 3502, comment: comment(`first line\n\n${"x".repeat(500)}`) }) })).events;
    const line = String(lineOf(long, "Being done"));
    assert.match(line, /"first line x+\u2026"\.$/, "one line, cut with an ellipsis");
    assert.ok(line.length < 300);
  });

  test("(2) an open row the org has not commented on says so, and is not `nobody`", async () => {
    const { events } = await observeWith({ readFixRow: () => ({ number: 3503 }) });
    assert.equal(lineOf(events[0], "Being done"), "Being done: row #3503 is open for this and the org has not commented on it yet.");
  });

  test("(3) with no row open, Being done says `nobody has picked this up yet`", async () => {
    const { events } = await observeWith({ readFixRow: () => null });
    for (const event of events) assert.equal(lineOf(event, "Being done"), "Being done: nobody has picked this up yet.");
  });

  test("(4) the cleared message carries how long it lasted, read from when the chairman was told, and asked for by key", async () => {
    const asked: string[] = /** @type {string[]} */ ([]);
    const { events } = await observeIncidents({ now: () => NOW, log: () => {}, readers: { ...green, readEpisodeStart: (/** @type {string} */ key: string) => { asked.push(key); return NOW - 90 * MINUTE; } } });
    assert.ok(events.every((event) => event.resolved === true), "positive control: all four are resolved events");
    for (const event of events) assert.match(String(event.text), /\nLasted: at least 1h 30m \(counted from the message that told you\)\.$/);
    assert.deepEqual(asked.sort(), Object.keys(IMPACTS).sort());
  });

  test("(4) a cleared message through the core says `Cleared:`, what cleared, and the duration; a started one has no Lasted line", async () => {
    const run = messenger();
    run.set(NOW + 31 * MINUTE);
    const [red] = (await observeWith({ readTrunkRuns: () => [trunkRun("failure", NOW)], readFixRow: () => null })).events.filter((event) => event.key === "incident:trunk-red");
    await run.tick([red]);
    assert.doesNotMatch(run.provider.sent[0].text, /Lasted/);
    run.set(NOW + 2 * HOUR);
    const [cleared] = (await observeIncidents({ now: () => NOW + 2 * HOUR, log: () => {}, readers: { ...green, readEpisodeStart: () => NOW + 31 * MINUTE } })).events.filter((event) => event.key === "incident:trunk-red");
    await run.tick([cleared]);
    assert.match(run.provider.sent[1].text, /^Cleared: main is green again\.\nLasted: at least 1h 29m /);
  });

  test("(4) a duration nobody could read is `not known`, never a short one, and the cleared message is still sent", async () => {
    const lines: string[] = /** @type {string[]} */ ([]);
    for (const readers of [{}, { readEpisodeStart: () => null }, { readEpisodeStart: () => { throw new Error("ledger: EACCES"); } }]) {
      const { events } = await observeIncidents({ now: () => NOW, log: (line) => lines.push(line), readers: { ...green, ...readers } });
      assert.equal(events.length, 4);
      for (const event of events) assert.match(String(event.text), /\nLasted: not known\.$/);
    }
    assert.match(lines[0], /^cannot-ask episode-start incident:[a-z-]+: .*EACCES/);
  });

  test("(5) a row read that fails says `I could not read it`, and the incident is still sent through the core", async () => {
    const lines: string[] = /** @type {string[]} */ ([]);
    const { events, cannotAsk } = await observeIncidents({ now: () => NOW, log: (line) => lines.push(line), readers: { ...unresolved, readFixRow: () => { throw new Error("gh: HTTP 502"); } } });
    assert.equal(events.length, 4);
    for (const event of events) assert.equal(lineOf(event, "Being done"), "Being done: I could not read it.");
    assert.deepEqual(cannotAsk, [], "the row read is not a reason to withhold the incident");
    assert.match(lines[0], /^cannot-ask fix-row incident:[a-z-]+: .*HTTP 502/);
    const run = messenger();
    run.set(NOW + 31 * MINUTE);
    await run.tick(events.filter((event) => event.key === "incident:trunk-red"));
    assert.match(run.provider.sent[0].text, /Being done: I could not read it\./);
  });

  test("(5) a reader that is not wired, and one that hands back a non-row, are `I could not read it` too", async () => {
    for (const readers of [{}, { readFixRow: () => undefined }, { readFixRow: () => ({ number: "3500" }) }, { readFixRow: () => ({ number: 3500, comment: { author: "x", at: "not a time", text: "t" } }) }]) {
      const { events } = await observeWith(readers);
      assert.equal(lineOf(events[0], "Being done"), "Being done: I could not read it.", JSON.stringify(readers));
    }
  });

  test("(6) the key, firstSeenAt and everything but the text are the bare event's, and the core still holds it down 30 minutes", async () => {
    const justRed = () => [trunkRun("failure", NOW)];
    const bare = trunkRedEvents(justRed(), NOW)[0];
    const [meant] = (await observeWith({ readTrunkRuns: justRed, readFixRow: () => null })).events.filter((event) => event.key === "incident:trunk-red");
    const { text: bareText, ...bareRest } = bare;
    const { text: meantText, ...meantRest } = meant;
    assert.deepEqual(meantRest, bareRest);
    assert.ok(String(meantText).startsWith(String(bareText)), "the original sentence is first and unedited");
    const run = messenger();
    run.set(NOW + 29 * MINUTE);
    await run.tick([meant]);
    assert.equal(run.provider.sent.length, 0, "29 minutes: still held");
    run.set(NOW + 31 * MINUTE);
    await run.tick([meant]);
    await run.tick([meant]);
    assert.equal(run.provider.sent.length, 1, "31 minutes: ONE message, however many ticks");
    assert.match(run.provider.sent[0].text, /Impact: Nothing can merge\.\nBeing done: nobody has picked this up yet\./);
  });
});
