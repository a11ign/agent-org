// no-token: gh -- every `gh` call in this file is an injected fake tracker; the live read was run by hand and is pasted on the pull request (a11ign/a11ign#4126)
// #4126 (child B of #4122): a second closed row under one `class:<id>` label is a repeat, and org-health offers it to `ceo` ONCE.
//
// THE FAKE TRACKER HONOURS `state` AND `labels`, because a fake that answers every argv accepts a query that asks for the wrong thing (the row's own warning).
// POSITIVE CONTROLS: every "trips nothing" case has a twin that DOES trip, over the same tracker with one fact changed, so a reading that never trips turns
// the twin red and one that always trips turns the case red. The mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLASS_REPEAT_WINDOW_MS, FAILURE_CLASSES_PATH, groupByClass, parseFailureClasses, readClassRepeat, type ClassRepeatFact,
} from "./class-repeat.ts";
import { SIGNALS } from "./org-health/thresholds.ts";
import { classRepeatReadings, orgHealthOrders, orgHealthReadings, orgHealthTick } from "./org-health/fleet-build-readings.ts";
import { HOME_CHECKOUT } from "./project-config.ts";

const NOW = Date.parse("2026-10-08T14:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const INDEX = JSON.stringify({ classes: [
  { id: "x", name: "the x failure", guard: "the x detector in CI", guardNote: null },
  { id: "y", name: "the y failure", guard: null, guardNote: "none in force; ordered on #9" },
  { id: "z", name: "the z failure", guard: "the z rule", guardNote: null },
] });
const REPO = "a11ign/a11ign";

/** @param {number} agoMs @returns {string} */
const closedAgo = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
/** @param {number} number @param {string[]} labels @param {number} agoMs @param {object} [over] */
const closed = (number: number, labels: string[], agoMs: number, over: object = {}) => ({ number, state: "closed", closed_at: closedAgo(agoMs), pull_request: false, labels, ...over });

/**
 * A tracker that answers `gh api repos/<repo>/issues` the way GitHub does for the parameters the reader sends: `state` and `labels` filter, `per_page` cuts, the array is
 * newest-updated first. It records every call, and REFUSES a path it was not built for, so a reader that drifts to another endpoint is red.
 * @param {object[]} issues @param {{ hostile?: boolean, fail?: string }} [how] `hostile` ignores `state` (an open row comes back anyway); `fail` is the message every call throws
 */
function tracker(issues: object[], { hostile = false, fail = "" }: { hostile?: boolean; fail?: string; } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (fail) throw new Error(fail);
    assert.equal(args[0], "api");
    assert.equal(args.find((a) => a.startsWith("repos/")), `repos/${REPO}/issues`);
    const param = (name: string) => args.flatMap((a, i) => (args[i - 1] === "-f" && a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []))[0];
    let rows = issues;
    if (!hostile && param("state")) rows = rows.filter((r) => (r as any).state === param("state"));
    if (param("labels")) rows = rows.filter((r) => (r as any).labels.includes(param("labels")));
    return JSON.stringify(rows.slice(0, Number(param("per_page"))));
  };
  return { run, calls };
}

/** @param {object[]} issues @param {object} [io] */
const factOf = (issues: object[], { how = {}, index = INDEX, now = NOW }: { how?: any; index?: any; now?: any } = {}) =>
  readClassRepeat(tracker(issues, how).run, REPO, { root: "/project", read: () => index, now });
/** @param {object[]} issues @param {object} [io] */
const readingsOf = (issues: object[], io: object = {}) => classRepeatReadings({ now: NOW, classRepeat: factOf(issues, io) });
/** @param {import("./org-health.ts").Reading[]} readings */
const orderTexts = (readings: import("./org-health/thresholds.ts").Reading[]) => orgHealthOrders(readings).map((o) => o.prompt);

const TWO_IN_X = [closed(11, ["class:x"], 10 * MINUTE), closed(10, ["bug", "class:x"], 3 * DAY)];

test("two closed rows under one class trip the reading, and the order names the class, its guard and both rows", () => {
  const [reading, ...rest] = readingsOf(TWO_IN_X);
  assert.equal(rest.length, 0);
  assert.equal(reading.signal, SIGNALS.CLASS_REPEAT);
  assert.equal(reading.status, "tripped");
  const [order, ...others] = orgHealthOrders([reading]);
  assert.equal(others.length, 0);
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, "org-health");
  assert.equal(order.subject, "class-repeat");
  assert.match(order.prompt, /the guard failed/i);
  for (const fact of ["`x`", "the x failure", "the x detector in CI", "#11", "#10"]) assert.ok(order.prompt.includes(fact), `the order names ${fact}`);
});

test("ONE closed row under a class does not trip it (the twin of the case above, one row fewer)", () => {
  assert.equal(readingsOf(TWO_IN_X.slice(0, 1))[0].status, "clear");
  assert.equal(readingsOf(TWO_IN_X)[0].status, "tripped");
});

test("two rows under DIFFERENT classes do not trip it", () => {
  const split = [closed(11, ["class:x"], 10 * MINUTE), closed(10, ["class:z"], 5 * MINUTE)];
  assert.equal(readingsOf(split)[0].status, "clear");
  assert.equal(readingsOf([...split, closed(9, ["class:z"], 4 * DAY)])[0].status, "tripped", "a second z row trips it, so the case above is not vacuous");
});

test("a label naming a class absent from the index is reported as an unknown class, and trips nothing", () => {
  const typo = [closed(21, ["class:xx"], 10 * MINUTE), closed(20, ["class:xx"], 2 * DAY)];
  const [reading, ...rest] = readingsOf(typo);
  assert.equal(rest.length, 0);
  assert.equal(reading.status, "unknown", "two rows under a label no class owns are not a repeat, and not clear either");
  assert.match(reading.detail, /unknown class/);
  assert.ok(reading.detail.includes("`class:xx`") && reading.detail.includes("#21") && reading.detail.includes("#20"));
  assert.deepEqual(orgHealthOrders([reading]), []);
});

test("a typo does not hide a repeat: the real class trips and the stranger is still named", () => {
  const readings = readingsOf([...TWO_IN_X, closed(30, ["class:xx"], 5 * MINUTE)]);
  assert.deepEqual(readings.map((r) => r.status), ["tripped"]);
  assert.match(readings[0].detail, /unknown class/);
  assert.ok(readings[0].detail.includes("`class:xx`"));
});

test("a refused read of the labels or the file is unknown, never 'no repeats'", () => {
  const refusals = {
    "the labels are refused": factOf(TWO_IN_X, { how: { fail: "HTTP 403: API rate limit exceeded" } }),
    "the listing is not JSON": readClassRepeat(() => "<html>not json</html>", REPO, { root: "/project", read: () => INDEX, now: NOW }),
    "the listing is not a list": readClassRepeat(() => "{}", REPO, { root: "/project", read: () => INDEX, now: NOW }),
    "the index is missing": readClassRepeat(tracker(TWO_IN_X).run, REPO, { root: "/project", read: () => { throw new Error("ENOENT"); }, now: NOW }),
    "the index is not an index": factOf(TWO_IN_X, { index: "{\"classes\": \"no\"}" }),
    "the index is not JSON": factOf(TWO_IN_X, { index: "not json" }),
  };
  for (const [what, fact] of Object.entries(refusals)) {
    assert.ok("unreadable" in fact, `${what}: the fact says it was not read`);
    const [reading, ...rest] = classRepeatReadings({ now: NOW, classRepeat: fact });
    assert.equal(rest.length, 0, what);
    assert.equal(reading.status, "unknown", what);
    assert.deepEqual(orgHealthOrders([reading]), [], what);
  }
  assert.equal(classRepeatReadings({ now: NOW, classRepeat: null })[0].status, "unknown", "a null fact is a refused read too");
});

test("a failure on the PER-CLASS read is unknown too, not the cheap read's answer", () => {
  let n = 0;
  const base = tracker(TWO_IN_X).run;
  const failsSecond = (args: string[]) => { if (++n === 2) throw new Error("HTTP 502"); return base(args); };
  const fact = readClassRepeat(failsSecond, REPO, { root: "/project", read: () => INDEX, now: NOW });
  assert.ok("unreadable" in fact);
  assert.equal(classRepeatReadings({ now: NOW, classRepeat: fact })[0].status, "unknown");
});

test("the same newest row is not offered twice; a third row is a new offer", () => {
  const first = readingsOf(TWO_IN_X)[0];
  const later = classRepeatReadings({ now: NOW + 20 * MINUTE, classRepeat: factOf(TWO_IN_X, { now: NOW + 20 * MINUTE }) })[0];
  assert.equal(later.discriminator, first.discriminator, "inside the window the same newest row is the same key, which the ledger delivers once");
  const after = classRepeatReadings({ now: NOW + 3 * 60 * MINUTE, classRepeat: factOf(TWO_IN_X, { now: NOW + 3 * 60 * MINUTE }) });
  assert.deepEqual(after.map((r) => r.status), ["clear"], "past the window the offer is over, so it is not re-sent when the ledger's TTL lapses");
  const third = readingsOf([closed(12, ["class:x"], 2 * MINUTE), ...TWO_IN_X])[0];
  assert.equal(third.status, "tripped");
  assert.notEqual(third.discriminator, first.discriminator, "a third row is a new newest row, so a new key");
  assert.match(third.detail, /#12/);
});

test("the window is strictly under the judgment TTL and its edge is exact", () => {
  const TWO_HOURS = 2 * 60 * MINUTE;
  assert.ok(CLASS_REPEAT_WINDOW_MS < TWO_HOURS, "a window of the TTL or more would order the same key twice");
  const atEdge = [closed(11, ["class:x"], CLASS_REPEAT_WINDOW_MS), closed(10, ["class:x"], DAY)];
  const pastEdge = [closed(11, ["class:x"], CLASS_REPEAT_WINDOW_MS + 1), closed(10, ["class:x"], DAY)];
  assert.equal(readingsOf(atEdge)[0].status, "tripped");
  assert.equal(readingsOf(pastEdge)[0].status, "clear");
});

test("an OPEN row under the label is not counted, even when the tracker hands it back", () => {
  const withOpen = [closed(11, ["class:x"], 10 * MINUTE), closed(10, ["class:x"], 3 * DAY, { state: "open", closed_at: null })];
  assert.equal(readingsOf(withOpen)[0].status, "clear");
  assert.equal(readingsOf(withOpen, { how: { hostile: true } })[0].status, "clear", "a tracker that ignores `state` does not make an open row an instance");
  assert.equal(readingsOf([...withOpen, closed(9, ["class:x"], 4 * DAY)])[0].status, "tripped", "a second CLOSED row does");
});

test("a pull request carrying the label is not an instance", () => {
  const withPr = [closed(11, ["class:x"], 10 * MINUTE), closed(10, ["class:x"], 3 * DAY, { pull_request: true })];
  assert.equal(readingsOf(withPr)[0].status, "clear");
});

test("a repeat in a class nobody has touched for days is not offered, and costs no per-class read", () => {
  const stale = [closed(11, ["class:x"], 2 * DAY), closed(10, ["class:x"], 3 * DAY)];
  const { run, calls } = tracker(stale);
  const fact = readClassRepeat(run, REPO, { root: "/project", read: () => INDEX, now: NOW });
  assert.equal(classRepeatReadings({ now: NOW, classRepeat: fact })[0].status, "clear");
  assert.equal(calls.length, 1, "one listing and nothing else on a quiet tick");
  const busy = tracker(TWO_IN_X);
  readClassRepeat(busy.run, REPO, { root: "/project", read: () => INDEX, now: NOW });
  assert.equal(busy.calls.length, 2, "one listing plus one read of the class with a recent instance");
  assert.ok(busy.calls[1].includes("labels=class:x"));
});

test("a class repeated over all time is counted over all time, not over the newest page", () => {
  const old = [closed(11, ["class:x"], 5 * MINUTE), closed(2, ["class:x"], 60 * DAY), closed(1, ["class:x"], 90 * DAY)];
  const recentPage = old.slice(0, 1);
  const base = tracker(old).run;
  const run = (args: string[]) => (args.some((a) => a.startsWith("labels=")) ? base(args) : JSON.stringify(recentPage));
  const [reading] = classRepeatReadings({ now: NOW, classRepeat: readClassRepeat(run, REPO, { root: "/project", read: () => INDEX, now: NOW }) });
  assert.equal(reading.status, "tripped");
  assert.ok(reading.detail.includes("3 closed rows") && reading.detail.includes("#11, #2, #1"));
});

test("which class has the most instances is printed beside the offer", () => {
  const rows = [...TWO_IN_X, closed(40, ["class:z"], 8 * DAY), closed(41, ["class:z"], 9 * DAY), closed(42, ["class:z"], 10 * DAY), closed(43, ["class:y"], 11 * DAY)];
  const [reading] = readingsOf(rows);
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /most first: z 3, x 2, y 1/);
});

test("a class with no guard says so, and is still a repeat", () => {
  const [reading] = readingsOf([closed(11, ["class:y"], MINUTE), closed(10, ["class:y"], DAY)]);
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /NONE IN FORCE \(none in force; ordered on #9\)/);
});

test("two classes repeating in one tick are two readings with their own keys", () => {
  const rows = [...TWO_IN_X, closed(51, ["class:z"], 20 * MINUTE), closed(50, ["class:z"], 6 * DAY)];
  const readings = readingsOf(rows);
  assert.equal(readings.length, 2);
  assert.equal(new Set(readings.map((r) => r.discriminator)).size, 2);
  assert.deepEqual(readings.map((r) => r.discriminator).sort(), ["class-repeat/x@11", "class-repeat/z@51"]);
});

test("the tick: an omitted fact is silent, a tripped one is one order to ceo, an unknown one logs and orders nothing", () => {
  const lines = ([] as string[]);
  const base = { now: NOW, lastMergedAt: NOW - MINUTE, work: null, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null, copies: [] };
  const io = { log: (l: string) => lines.push(l), readAutoOff: () => undefined };
  assert.equal(orgHealthReadings(base).some((r) => r.signal === SIGNALS.CLASS_REPEAT), false, "a caller that does not ask gets no class-repeat reading");
  const orders = orgHealthTick({ ...base, classRepeat: factOf(TWO_IN_X) }, (io as any)).filter((o) => o.subject === SIGNALS.CLASS_REPEAT);
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.causeKey]), [["ceo", "org-health", "ceo/org-health/class-repeat/x@11"]]);
  orgHealthTick({ ...base, classRepeat: { unreadable: "the labels are refused" } }, (io as any));
  assert.ok(lines.some((l) => l.includes("class-repeat UNKNOWN") && l.includes("not read as clear")));
});

test("the index parser takes the shape of the real file and refuses anything else", () => {
  assert.deepEqual(parseFailureClasses(INDEX)?.map((c) => [c.id, c.guard === null]), [["x", false], ["y", true], ["z", false]]);
  for (const bad of ["", "[]", "{}", "{\"classes\":[{\"name\":\"no id\"}]}", "{\"classes\":[{\"id\":\"\"}]}"]) assert.equal(parseFailureClasses(bad), null, bad);
  assert.deepEqual(groupByClass([], [{ number: 1, closedAt: 0, classes: ["a", "b"] }]).map((g) => g.id), ["a", "b"], "one row under two labels is an instance of each");
});

test("a ledger counter is no class: it is left out of the groups, a real event kind is grouped, and an unknown key is still a stranger (#4618)", () => {
  const repeat = (classKey: string) => ({ classKey, refs: ["a", "b"], newestAt: 1 });
  assert.deepEqual(groupByClass([], [], [repeat("unclassified"), repeat("unidentified-caller-order")]), [], "both counters are absent");
  const index = [{ id: "hand-reroute", name: "n", guard: null, guardNote: "n" }];
  assert.deepEqual(groupByClass(index, [], [repeat("hand-reroute")]).map((g) => [g.id, g.entry?.id]), [["hand-reroute", "hand-reroute"]], "a real event kind is still grouped");
  assert.deepEqual(groupByClass(index, [], [repeat("unclassified"), repeat("mystery-kind")]).map((g) => [g.id, g.entry]), [["mystery-kind", null]], "an unknown key is a stranger beside a counter");
});

test("a ledger holding two refs under each counter and no closed rows reads CLEAR, and a real typo in the ledger is still an unknown class (agent-org#508)", () => {
  const ledgerOf = (...keys: string[]) => keys.flatMap((key) => ["r1", "r2"].map((ref, i) => `${key}\t${NOW - (10 - i) * MINUTE}\t${ref}`)).join("\n");
  const readOf = (ledger: string) => readClassRepeat(tracker([]).run, REPO, { root: "/project", read: () => INDEX, now: NOW, ledgerPath: "/state/failure-ledger", readLedger: () => ledger });
  const counters = readOf(ledgerOf("unclassified", "unidentified-caller-order"));
  assert.ok(!("unreadable" in counters) && Array.isArray(counters.ledger) && counters.ledger.length === 2, "the ledger does hold both counters as repeats, so the case is not vacuous");
  const [reading, ...rest] = classRepeatReadings({ now: NOW, classRepeat: counters });
  assert.equal(rest.length, 0);
  assert.equal(reading.status, "clear", "the counters are bookkeeping, not strangers");
  assert.doesNotMatch(reading.detail, /unknown class|unclassified|unidentified-caller-order/);
  const typo = classRepeatReadings({ now: NOW, classRepeat: readOf(ledgerOf("unclassified", "mystery-kind")) });
  assert.deepEqual(typo.map((r) => r.status), ["unknown"], "a ledger key that is neither a counter nor indexed is still named");
  assert.match(typo[0].detail, /unknown class/);
  assert.ok(typo[0].detail.includes("`class:mystery-kind`") && !typo[0].detail.includes("unclassified"));
});

// agent-org#1316 (a11ign/a11ign#5282): a class's ledger refs count from its `countedSince`. The refs before it are the defect the guard fixed, so they are no repeat.
const COUNTED_SINCE = "2026-10-08T13:00:00Z";
const COUNTED_INDEX = JSON.stringify({ classes: [{ id: "claim-refused", name: "the claim refused", guard: "the claim guard", guardNote: null, countedSince: COUNTED_SINCE }] });
const at = (iso: string) => Date.parse(iso);
const refLine = (key: string, iso: string, ref: string) => `${key}\t${at(iso)}\t${ref}`;
const countedRepeats = (ledger: string[], index = COUNTED_INDEX) =>
  readClassRepeat(tracker([]).run, REPO, { root: "/project", read: () => index, now: NOW, ledgerPath: "/state/failure-ledger", readLedger: () => ledger.join("\n") });

test("parseFailureClasses reads countedSince as the time it names, and refuses a value that is not a time", () => {
  assert.equal(parseFailureClasses(COUNTED_INDEX)?.[0].countedSince, at(COUNTED_SINCE));
  assert.equal(parseFailureClasses(INDEX)?.[0].countedSince, undefined, "absent means every ref counts, as it always did");
  assert.equal(parseFailureClasses(JSON.stringify({ classes: [{ id: "x", countedSince: "last tuesday" }] })), null, "a malformed time is a stated gap, not a silent count-everything");
});

test("a ref before countedSince and one after are one occurrence, so no repeat (the guard fixed the earlier one)", () => {
  const fact = countedRepeats([refLine("claim-refused", "2026-10-08T12:00:00Z", "old defect"), refLine("claim-refused", "2026-10-08T13:30:00Z", "new defect")]);
  assert.ok(!("unreadable" in fact));
  assert.deepEqual(fact.ledger, [], "one ref after the line is one occurrence, and the one before it does not count");
});

test("two refs after countedSince are a repeat, and the ref before it is not one of them (the twin of the case above)", () => {
  const fact = countedRepeats([
    refLine("claim-refused", "2026-10-08T12:00:00Z", "old defect"),
    refLine("claim-refused", "2026-10-08T13:30:00Z", "new defect 1"),
    refLine("claim-refused", "2026-10-08T13:40:00Z", "new defect 2"),
  ]);
  assert.ok(!("unreadable" in fact));
  assert.deepEqual(fact.ledger, [{ classKey: "claim-refused", refs: ["new defect 1", "new defect 2"], newestAt: at("2026-10-08T13:40:00Z") }]);
});

test("countedSince is per class: another kind's refs before its line still repeat", () => {
  const fact = countedRepeats([refLine("other-kind", "2026-10-08T12:00:00Z", "a"), refLine("other-kind", "2026-10-08T12:10:00Z", "b")]);
  assert.ok(!("unreadable" in fact) && Array.isArray(fact.ledger));
  assert.deepEqual(fact.ledger.map(({ classKey }) => classKey), ["other-kind"], "a class with no countedSince counts every ref it has");
});

// agent-org#1551 (a11ign/a11ign#4690, #5156, #5166 and two the detector wrote for a step pull request that said its row stays open): a ref a person has read as NOT the class is
// left out of its count. The ledger keeps the line; the index says which refs are no occurrence.
const NOT_FINISHABLE_REFS = ["a11ign/a11ign#4690", "a11ign/a11ign#5156", "a11ign/a11ign#5166", "a11ign/a11ign#5409@a11ign/.github#4", "a11ign/a11ign#5462@a11ign/a11ign#5538"];
const FALSE_REFS = NOT_FINISHABLE_REFS.slice(3);
const NOT_FINISHABLE_LINES = NOT_FINISHABLE_REFS.map((ref, i) => refLine("row-not-finishable", `2026-10-08T12:${10 + i}:00Z`, ref));
const notFinishableIndex = (notOccurrences?: unknown) => JSON.stringify({ classes: [{ id: "row-not-finishable", name: "the row not finishable", guard: "the row-finishable check", guardNote: null,
  ...(notOccurrences === undefined ? {} : { notOccurrences }) }] });
const listed = (refs: string[]) => refs.map((ref) => ({ ref, reason: "the step pull request said its row stays open, so the row was finishable" }));
/** the refs a class reads as in the repeats, `undefined` when it is not a repeat at all */
const refsOf = (fact: ClassRepeatFact, classKey = "row-not-finishable") => {
  assert.ok(!("unreadable" in fact) && Array.isArray(fact.ledger), "the ledger is read");
  return fact.ledger.find((repeat) => repeat.classKey === classKey)?.refs;
};

test("a ref listed in notOccurrences is no occurrence of its class: 3 refs with the list, 5 with it absent as today (agent-org#1551)", () => {
  assert.deepEqual(refsOf(countedRepeats(NOT_FINISHABLE_LINES, notFinishableIndex(listed(FALSE_REFS)))), NOT_FINISHABLE_REFS.slice(0, 3), "the three real refs remain, in order");
  assert.deepEqual(refsOf(countedRepeats(NOT_FINISHABLE_LINES, notFinishableIndex())), NOT_FINISHABLE_REFS, "absent, every ref counts, as it always did");
});

test("a ref listed under one class is still counted under another that carries it too: the exclusion is per class (agent-org#1551)", () => {
  const index = JSON.stringify({ classes: [
    { id: "row-not-finishable", name: "the row not finishable", guard: "the row-finishable check", guardNote: null, notOccurrences: listed(FALSE_REFS) },
    { id: "other-kind", name: "another kind", guard: null, guardNote: "none in force" },
  ] });
  const fact = countedRepeats([...NOT_FINISHABLE_LINES, refLine("other-kind", "2026-10-08T12:20:00Z", FALSE_REFS[0]), refLine("other-kind", "2026-10-08T12:21:00Z", "a11ign/a11ign#9")], index);
  assert.deepEqual(refsOf(fact, "other-kind"), [FALSE_REFS[0], "a11ign/a11ign#9"], "the other class lists nothing, so the ref counts under it");
  assert.deepEqual(refsOf(fact), NOT_FINISHABLE_REFS.slice(0, 3), "and it is still left out of the class that lists it");
});

test("a listed ref that is not in the ledger is no error and changes nothing (agent-org#1551)", () => {
  assert.deepEqual(refsOf(countedRepeats(NOT_FINISHABLE_LINES, notFinishableIndex(listed([...FALSE_REFS, "a11ign/a11ign#9999"])))), NOT_FINISHABLE_REFS.slice(0, 3));
});

test("a notOccurrences that is not a list of { ref, reason } strings makes the whole index a stated gap (agent-org#1551)", () => {
  const malformed = [
    "a11ign/a11ign#5409",
    [{ ref: "a11ign/a11ign#5409" }],
    [{ ref: 5409, reason: "a number is no ref" }],
    [{ ref: "a11ign/a11ign#5409", reason: "" }],
    [null],
  ];
  for (const notOccurrences of malformed) assert.equal(parseFailureClasses(notFinishableIndex(notOccurrences)), null, `refused: ${JSON.stringify(notOccurrences)}`);
  assert.deepEqual(parseFailureClasses(notFinishableIndex(listed(FALSE_REFS)))?.[0].notOccurrences, listed(FALSE_REFS), "a well-formed list is read as given");
  assert.equal(parseFailureClasses(notFinishableIndex())?.[0].notOccurrences, undefined, "absent is no list at all");
  assert.ok("unreadable" in countedRepeats(NOT_FINISHABLE_LINES, notFinishableIndex(FALSE_REFS)), "read through the gate, the index is a stated gap, not 5 refs and not no repeat");
});

test("listing all but one ref of a class reads as no repeat: the order is not raised for one (agent-org#1551)", () => {
  assert.equal(refsOf(countedRepeats(NOT_FINISHABLE_LINES, notFinishableIndex(listed(NOT_FINISHABLE_REFS.slice(1))))), undefined, "one ref left is one occurrence");
  const pair = [refLine("other-kind", "2026-10-08T12:20:00Z", "a"), refLine("other-kind", "2026-10-08T12:21:00Z", "b")];
  const pairIndex = JSON.stringify({ classes: [{ id: "other-kind", name: "another kind", guard: null, guardNote: "none in force", notOccurrences: listed(["a"]) }] });
  assert.equal(refsOf(countedRepeats(pair, pairIndex), "other-kind"), undefined, "two refs with one listed is one occurrence");
});

const REAL = join(HOME_CHECKOUT, FAILURE_CLASSES_PATH);
test("the project's real failure-classes.json parses and every class has an id, a name and a guard or a guardNote",
  { skip: existsSync(REAL) ? false : `${REAL} is absent on this host (the project checkout is not at a commit that has the seed, #4125)` }, () => {
    const index = parseFailureClasses(readFileSync(REAL, "utf8"));
    assert.ok(index !== null && index.length > 0, "the file is an index with at least one class");
    for (const c of index) assert.ok(c.name !== "" && (c.guard !== null || (c.guardNote ?? "") !== ""), `${c.id} has a name and a guard or a guardNote`);
  });
