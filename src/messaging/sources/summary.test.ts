// @ts-check
// THE DAILY SUMMARY SOURCE, AGAINST THE REAL CORE (a11ign/a11ign#2903 done-whens 3 and 4). The clock is injected and the instants are
// chosen on both sides of BOTH 2026 Europe/London changes (spring 2026-03-29, autumn 2026-10-25), because 08:00 London is 08:00Z in
// winter and 07:00Z in summer and a fixed offset is wrong on exactly the days after a change.
//
// POSITIVE CONTROLS: each "not yet" has a neighbour one minute later that IS due, and each "nothing sent" a case that sends.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "../core.mjs";
import { createFakeProvider } from "../fake-provider.ts";
import { createLedger } from "../ledger.mjs";
import { SUMMARY_LIST_LIMIT, localClock, observeSummary, summaryDue, summaryKey } from "./summary.mjs";

const REPO = "a11ign/a11ign";
const LONDON = { at: "08:00", timezone: "Europe/London" };
const HOUR = 3_600_000;
const MINUTE = 60_000;

const scratch = mkdtempSync(join(tmpdir(), "messaging-summary-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** @param {string} iso */
const at = (iso: string) => Date.parse(iso);

/** @param {number} count @param {Record<string, unknown>} [more] @returns {Record<string, unknown>[]} */
function rows(count: number, more: Record<string, unknown> = {}): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ number: index + 1, ...more }));
}

/**
 * A fixture reader. Every number below is DIFFERENT, so a summary that put the merged count on the ready line would fail: waiting 2,
 * ready 3, merged 7, red 1, stalled 4 (of six in-progress rows, two touched within the day).
 *
 * @param {Partial<Record<"issuesLabelled" | "mergedPullsSince" | "redPulls", (query: any) => Promise<any>>>} [overrides]
 */
function reader(overrides: Partial<Record<"issuesLabelled" | "mergedPullsSince" | "redPulls", (query: any) => Promise<any>>> = {}, nowMs = at("2026-10-02T07:00:00Z")) {
  const stale = new Date(nowMs - 30 * HOUR).toISOString();
  const fresh = new Date(nowMs - 2 * HOUR).toISOString();
  const calls: { name: string; query: any; }[] = /** @type {any[]} */ ([]);
  const base = {
    issuesLabelled: async (/** @type {any} */ query: any) => {
      if (query.label === "needs:chairman") return rows(2);
      if (query.label === "ready") return rows(3);
      return [...rows(4, { updatedAt: stale }), ...rows(2, { updatedAt: fresh })];
    },
    mergedPullsSince: async () => rows(7),
    redPulls: async () => rows(1),
  };
  /** @type {Record<string, any>} */
  const merged: Record<string, any> = { ...base, ...overrides };
  const wrapped = Object.fromEntries(Object.entries(merged).map(([name, fn]) => [name, async (/** @type {any} */ query: any) => { calls.push({ name, query }); return fn(query); }]));
  return { github: /** @type {any} */ (wrapped), calls };
}

/** @param {number} startMs */
function world(startMs: number) {
  let now = startMs;
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const provider = createFakeProvider();
  const messenger = createMessenger({ provider, ledger: createLedger({ path, now: () => now }), now: () => now });
  return {
    provider,
    set: (/** @type {number} */ ms: number) => { now = ms; },
    /** @param {number} ms @param {ReturnType<typeof reader>} [github] */
    async tick(ms: number, github: ReturnType<typeof reader> = reader({}, ms)) {
      now = ms;
      const { events } = await observeSummary({ github: github.github, repo: REPO, now: ms, summary: LONDON });
      return { events, decisions: await messenger.tick(events) };
    },
  };
}

describe("the clock reads the zone's own rules (done-when 3)", () => {
  test("localClock gives the local date and minutes, and midnight is 00:00 and not 24:00", () => {
    assert.deepEqual(localClock(at("2026-01-15T08:30:00Z"), "Europe/London"), { date: "2026-01-15", minutes: 8 * 60 + 30 });
    assert.deepEqual(localClock(at("2026-07-15T08:30:00Z"), "Europe/London"), { date: "2026-07-15", minutes: 9 * 60 + 30 });
    assert.deepEqual(localClock(at("2026-07-14T23:00:00Z"), "Europe/London"), { date: "2026-07-15", minutes: 0 }, "midnight BST is 23:00Z the day before");
  });

  // [name, the last instant it is NOT yet 08:00 in London, the first instant it is]
  for (const [name, notYet, due] of /** @type {[string, string, string][]} */ ([
    ["winter, the day before the spring change", "2026-03-28T07:59:00Z", "2026-03-28T08:00:00Z"],
    ["the day of the spring change (the clocks went forward at 01:00Z)", "2026-03-29T06:59:00Z", "2026-03-29T07:00:00Z"],
    ["summer, the day after the spring change", "2026-03-30T06:59:00Z", "2026-03-30T07:00:00Z"],
    ["summer, the day before the autumn change", "2026-10-24T06:59:00Z", "2026-10-24T07:00:00Z"],
    ["the day of the autumn change (the clocks went back at 01:00Z)", "2026-10-25T07:59:00Z", "2026-10-25T08:00:00Z"],
    ["winter, the day after the autumn change", "2026-10-26T07:59:00Z", "2026-10-26T08:00:00Z"],
  ])) {
    test(`08:00 London, ${name}: not due a minute before, due at the minute`, () => {
      assert.equal(summaryDue({ nowMs: at(notYet), at: "08:00", timeZone: "Europe/London" }).due, false);
      assert.equal(summaryDue({ nowMs: at(due), at: "08:00", timeZone: "Europe/London" }).due, true);
    });
  }

  test("the summary is BUILT at those instants and not a minute before, on both sides of the spring change", async () => {
    for (const [early, onTime] of [["2026-03-28T07:59:00Z", "2026-03-28T08:00:00Z"], ["2026-03-30T06:59:00Z", "2026-03-30T07:00:00Z"]]) {
      const w = world(at(early));
      assert.deepEqual((await w.tick(at(early))).events, [], `${early}: before the time`);
      assert.equal(w.provider.sent.length, 0);
      assert.equal((await w.tick(at(onTime))).events.length, 1, `${onTime}: at the time`);
      assert.equal(w.provider.sent.length, 1);
    }
  });

  test("a time the zone skips (01:30 on the spring-forward day) is reached at the first minute after the gap", () => {
    const due = (/** @type {string} */ iso: string) => summaryDue({ nowMs: at(iso), at: "01:30", timeZone: "Europe/London" }).due;
    assert.equal(due("2026-03-29T00:59:00Z"), false);
    assert.equal(due("2026-03-29T01:00:00Z"), true, "02:00 BST is the first reading after the gap");
  });

  test("the summary's date is the LOCAL date: 00:30 BST on the 15th is the 14th in UTC and the 15th in London", () => {
    assert.equal(summaryDue({ nowMs: at("2026-07-14T23:30:00Z"), at: "00:10", timeZone: "Europe/London" }).date, "2026-07-15");
  });

  test("another zone is read by its own clock", () => {
    assert.equal(summaryDue({ nowMs: at("2026-07-15T11:59:00Z"), at: "08:00", timeZone: "America/New_York" }).due, false);
    assert.equal(summaryDue({ nowMs: at("2026-07-15T12:00:00Z"), at: "08:00", timeZone: "America/New_York" }).due, true);
  });
});

describe("once per local date, and silent (done-when 3)", () => {
  test("many ticks through the day send one summary, and it is silent", async () => {
    const w = world(at("2026-10-02T06:50:00Z"));
    for (let minute = 0; minute < 14 * 60; minute += 5) await w.tick(at("2026-10-02T06:50:00Z") + minute * MINUTE);
    assert.equal(w.provider.sent.length, 1);
    assert.equal(w.provider.sent[0].silent, true, "the summary is the one silent message");
  });

  test("the next local date is a new summary, with its own key", async () => {
    const w = world(at("2026-10-02T07:00:00Z"));
    const first = await w.tick(at("2026-10-02T07:00:00Z"));
    await w.tick(at("2026-10-02T12:00:00Z"));
    const second = await w.tick(at("2026-10-03T07:05:00Z"));
    assert.equal(w.provider.sent.length, 2);
    assert.equal(first.events[0].key, summaryKey("2026-10-02"));
    assert.equal(second.events[0].key, "summary:2026-10-03");
  });

  test("the day of the autumn change is one summary though its 01:00-02:00 hour happens twice", async () => {
    const w = world(at("2026-10-25T00:00:00Z"));
    for (let minute = 0; minute < 24 * 60; minute += 5) await w.tick(at("2026-10-25T00:00:00Z") + minute * MINUTE);
    assert.equal(w.provider.sent.length, 1);
  });

  test("a restart after it was sent does not send it again (the ledger is the memory)", async () => {
    const path = join(scratch, "restart.jsonl");
    const provider = createFakeProvider();
    let now = at("2026-10-02T07:00:00Z");
    const start = () => createMessenger({ provider, ledger: createLedger({ path, now: () => now }), now: () => now });
    const github = reader().github;
    const observe = async () => (await observeSummary({ github, repo: REPO, now, summary: LONDON })).events;
    await start().tick(await observe());
    now += 10 * MINUTE;
    await start().tick(await observe());
    assert.equal(provider.sent.length, 1);
  });

  test("a machine that was off at 08:00 still owes the day's summary, stamped with the time it was actually read", async () => {
    const w = world(at("2026-10-02T14:00:00Z"));
    await w.tick(at("2026-10-02T14:00:00Z"));
    assert.equal(w.provider.sent.length, 1);
    assert.match(w.provider.sent[0].text, /\(as of 14:00Z\)/);
  });

  test("before the time the reader is not even asked: no read is made for a summary that cannot be sent", async () => {
    const github = reader();
    const { events } = await observeSummary({ github: github.github, repo: REPO, now: at("2026-10-02T06:59:00Z"), summary: LONDON });
    assert.deepEqual(events, []);
    assert.deepEqual(github.calls, []);
  });
});

describe("every number is read, not typed (done-when 4)", () => {
  test("a fixture reader returning 3 ready rows yields '3', and each count comes from its own read", async () => {
    const w = world(at("2026-10-02T07:00:00Z"));
    await w.tick(at("2026-10-02T07:00:00Z"));
    const text = w.provider.sent[0].text;
    assert.match(text, /^Daily summary 2026-10-02 \(as of 07:00Z\)\n/);
    assert.match(text, /^Waiting on you: 2$/m);
    assert.match(text, /^Ready rows: 3$/m);
    assert.match(text, /^Merged in the last 24 h: 7$/m);
    assert.match(text, /^Red \(open pull requests with a failing check\): 1$/m);
    assert.match(text, /^Stalled \(in-progress rows untouched for 24 h\): 4$/m);
  });

  test("changing what the reader returns changes the number: nothing is typed", async () => {
    const github = reader({ mergedPullsSince: async () => rows(11), redPulls: async () => [] });
    const { events } = await observeSummary({ github: github.github, repo: REPO, now: at("2026-10-02T07:00:00Z"), summary: LONDON });
    assert.match(String(events[0].text), /^Merged in the last 24 h: 11$/m);
    assert.match(String(events[0].text), /^Red .*: 0$/m, "an EMPTY list is a read, and reads as 0");
  });

  test("the reads are asked for the right thing: the 24 h window, the repository, the labels", async () => {
    const now = at("2026-10-02T07:00:00Z");
    const github = reader({}, now);
    await observeSummary({ github: github.github, repo: REPO, now, summary: LONDON });
    const asked = (/** @type {string} */ name: string) => github.calls.filter((call) => call.name === name).map((call) => call.query);
    assert.deepEqual(asked("mergedPullsSince").map((query) => [query.repo, query.sinceMs]), [[REPO, now - 24 * HOUR]]);
    assert.deepEqual(asked("issuesLabelled").map((query) => query.label).sort(), ["in-progress", "needs:chairman", "ready"]);
    assert.ok(asked("issuesLabelled").every((query) => query.repo === REPO));
  });

  test("a read that failed says unread and WHY, and is never shown as 0", async () => {
    const github = reader({ redPulls: async () => { throw new Error("HTTP 502 from the pulls list"); } });
    const { events, unread } = await observeSummary({ github: github.github, repo: REPO, now: at("2026-10-02T07:00:00Z"), summary: LONDON });
    const text = String(events[0].text);
    assert.match(text, /^Red .*: unread \(HTTP 502 from the pulls list\)$/m);
    assert.doesNotMatch(text, /^Red .*: 0$/m);
    assert.match(text, /^Ready rows: 3$/m, "the reads that worked are still shown");
    assert.deepEqual(unread, ["red: HTTP 502 from the pulls list"]);
  });

  test("a list as long as the limit is unread and not counted as if it were whole", async () => {
    const github = reader({ mergedPullsSince: async () => rows(500) });
    const { events } = await observeSummary({ github: github.github, repo: REPO, now: at("2026-10-02T07:00:00Z"), summary: LONDON });
    assert.match(String(events[0].text), /^Merged in the last 24 h: unread \(500 or more, the limit of the read\)$/m);
  });

  test("when EVERY read fails nothing is emitted, and the next tick tries again", async () => {
    const down = async () => { throw new Error("GitHub is down"); };
    const w = world(at("2026-10-02T07:00:00Z"));
    const failed = await w.tick(at("2026-10-02T07:00:00Z"), reader({ issuesLabelled: down, mergedPullsSince: down, redPulls: down }));
    assert.deepEqual(failed.events, []);
    assert.equal(w.provider.sent.length, 0);
    await w.tick(at("2026-10-02T07:05:00Z"));
    assert.equal(w.provider.sent.length, 1, "POSITIVE CONTROL: once GitHub answers, the day's summary goes");
  });

  test("the stalled count is by the row's own `updatedAt`, and a row with no usable time is not counted as stalled", async () => {
    const now = at("2026-10-02T07:00:00Z");
    const github = reader({
      issuesLabelled: async (query) => (query.label === "in-progress"
        ? [{ number: 1, updatedAt: new Date(now - 25 * HOUR).toISOString() }, { number: 2, updatedAt: new Date(now - 23 * HOUR).toISOString() }, { number: 3 }]
        : []),
    }, now);
    const { events } = await observeSummary({ github: github.github, repo: REPO, now, summary: LONDON });
    assert.match(String(events[0].text), /^Stalled .*: 1$/m);
  });

  test("a cut in-progress list is unread even when the 24 h filter brings it under the limit", async () => {
    const now = at("2026-10-02T07:00:00Z");
    const rows = (/** @type {number} */ n: number) => Array.from({ length: n }, (_, i) => ({ number: i, updatedAt: new Date(now - HOUR).toISOString() }));
    const asRead = (/** @type {number} */ n: number) => reader({ issuesLabelled: async (query) => (query.label === "in-progress" ? rows(n) : []) }, now);
    const cut = await observeSummary({ github: asRead(SUMMARY_LIST_LIMIT).github, repo: REPO, now, summary: LONDON });
    assert.match(String(cut.events[0].text), /^Stalled .*: unread \(/m, "every row was touched within the day, so the filter leaves none, and it is still unread");
    const whole = await observeSummary({ github: asRead(SUMMARY_LIST_LIMIT - 1).github, repo: REPO, now, summary: LONDON });
    assert.match(String(whole.events[0].text), /^Stalled .*: 0$/m, "POSITIVE CONTROL: one row fewer is a complete read");
  });
});
