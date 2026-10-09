// no-token: gh -- importing `work-gate.mjs` reaches `defaultRun`, and this file never lets it run: `waitTickFacts` is handed a fake `run`, `orgHealthNow` the clock, the last merge and the log, and the one process test refuses `--until` before the command reads a label
/**
 * `packages/agent-org/src/wait-condition.mjs` and its wiring, #2996: A DECLARED WAIT NAMES THE CONDITION IT WAITS FOR, AND THE TICK RE-READS IT.
 *
 * THE INCIDENT, REPLAYED (the chairman, 2026-10-02): the freeze ended at 06:50Z and four hours later `hold:ceo` was still on #2988/#2990 while twelve sessions
 * sat idle, because `holdersOf` and `NOT_STARTABLE` read a declared wait as proof of health. The positive control is that PR: `hold:ceo`, `Waiting-for: closed #2867`,
 * #2867 CLOSED. Every "is excused" below is only worth anything because that one is NOT.
 *
 * THE LITERALS ARE WRITTEN OUT, 4 HOURS AND 30 MINUTES, and `the constants are the row's` pins them to the exports in ONE place: a test built from the constant
 * moves with it, so moving N by one would leave it green.
 *
 * MUTATION, run by hand 2026-10-02 and recorded on the row, each restored byte-identical (`diff` of a copy): `conditionHolds` ALWAYS FALSE turns 10 of 30 red -- the positive
 * control, the exemption's trip, the end-to-end tick, the truth table and the per-kind cases that need a true condition -- and `the SAME fixture ... OPEN` stays green; ALWAYS TRUE turns
 * 10 red, the "unresolved is excused" ones among them. Each direction breaks the tests that assert its own half and no wiring test that does not read a condition.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WAIT_FIELDS, WAIT_STATES, WAIT_MARKER, MANUAL_WAIT_HOURS, STALE_WAIT_GRACE_MINUTES, parseWaits, conditionHolds, waitItemOf, waitFieldsOf, staleWaits, bareWaits,
  manualWaits, setterOf,
} from "../wait-condition.ts";
import { holdReasonOf, holdExcused } from "../pr-hold-state.ts";
import { SIGNALS, redPrReading, staleWaitReading, waitWithoutReasonReading, orgHealthReadings, orgHealthOrders } from "../org-health.ts";
import { decide, withPrOwners, redPrFacts, staleWaitOrders, waitTickFacts, refFactOf, readWaitFacts, orgHealthNow } from "../work-gate.ts";

const HOLD_ENTRY = fileURLToPath(new URL("../pr-hold.ts", import.meta.url));
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-02T11:00:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();

type Facts = { items: Record<string, { state: "open" | "closed" | "merged"; labels: string[]; resolvedAt: number | null; changedAt: number | null }> };
const closed2867: Facts = { items: { "#2867": { state: "closed", labels: [], resolvedAt: NOW - 4 * HOUR_MS, changedAt: NOW - 4 * HOUR_MS } } };
const open2867: Facts = { items: { "#2867": { state: "open", labels: [], resolvedAt: null, changedAt: NOW - HOUR_MS } } };

const marker = (lines: string, at: number) => ({ author: { login: "a11ign-ai-workers" }, createdAt: ISO(at), body: `${WAIT_MARKER}\nHeld by \`ceo\`.\n${lines}` });

/** The #2988 shape: held by ceo, red ONLY on the hold's own two jobs since three hours ago, opened by the shared account. */
const heldPr = (comments: unknown[], extra: Record<string, unknown> = {}) => ({
  number: 2988, headRefOid: "24b0e94f00000000", isDraft: false, headRefName: "agent/some-slug", labels: [{ name: "hold:ceo" }], closingIssuesReferences: [],
  author: { login: "a11ign-ai-workers" }, body: "", comments, updatedAt: ISO(NOW - 5 * HOUR_MS),
  statusCheckRollup: ["deliberateRefusals", "gate"].map((name) => ({ name, status: "COMPLETED", conclusion: "FAILURE", startedAt: ISO(NOW - 3 * HOUR_MS - MINUTE_MS), completedAt: ISO(NOW - 3 * HOUR_MS) })),
  ...extra,
});
const ROWS = [{ number: 11, labels: [{ name: "in-progress" }, { name: "session:worker-11" }] }];

// --- the grammar ------------------------------------------------------------------------------------------------------------

test("the grammar's item states are the four #2996 names, and each round-trips through parseWaits (the release states are #4005's, in wait-release-states.test.ts)", () => {
  assert.deepEqual([...WAIT_STATES].slice(0, 4), ["closed", "merged", "labelled", "unlabelled"]);
  for (const text of ["closed #2867", "merged owner/repo#40", "labelled hold:ceo #12", "unlabelled needs:chairman a/b#7"]) {
    const [wait] = parseWaits(`Waiting-for: ${text}`);
    assert.equal(wait.text, text);
    assert.ok(WAIT_STATES.includes(wait.state), `${text} is read as ${wait.state}`);
  }
  assert.deepEqual(parseWaits("## Waiting-for: merged a/b#5").map((w) => [w.state, (w as { repo: string }).repo, (w as { number: number }).number]), [["merged", "a/b", 5]]);
});

test("a body QUOTING the grammar in prose, inline, as a block quote or in a fence declares nothing; the real line beside them is read", () => {
  const body = [
    "Use `Waiting-for: closed #1` like so, or write Waiting-for: closed #4 in a sentence.",
    "> Waiting-for: closed #3",
    "```",
    "Waiting-for: closed #2",
    "```",
    "~~~md",
    "Waiting-for: closed #6",
    "~~~",
  ].join("\n");
  assert.deepEqual(parseWaits(body), [], "POSITIVE CONTROL is the next assertion: the parser reads a real line");
  assert.deepEqual(parseWaits(`${body}\nWaiting-for: closed #9`).map((w) => w.text), ["closed #9"]);
});

test("a value outside the grammar is KEPT as unreadable, never dropped and never a pass", () => {
  for (const text of ["soon", "closed", "closed #x", "labelled needs:chairman", "open #5", "closed #5 and #6"]) {
    assert.deepEqual(parseWaits(`Waiting-for: ${text}`), [{ state: "unreadable", text }], text);
  }
  assert.deepEqual(parseWaits("Waiting-for:   "), [], "an empty value is no declaration at all");
  assert.deepEqual(parseWaits("Waiting-for: manual"), [{ state: "manual", text: "manual" }]);
});

test("conditionHolds: true is the reason gone, false is it standing, null is cannot-say -- and a missing reference is never closed", () => {
  const w = (text: string) => parseWaits(`Waiting-for: ${text}`)[0];
  const facts: Facts = { items: { "#1": { state: "closed", labels: [], resolvedAt: 1, changedAt: 1 }, "#2": { state: "merged", labels: ["x"], resolvedAt: 1, changedAt: 1 },
    "#3": { state: "open", labels: ["hold:ceo"], resolvedAt: null, changedAt: 1 } } };
  assert.equal(conditionHolds(w("closed #1"), facts), true);
  assert.equal(conditionHolds(w("closed #2"), facts), true, "a merged PR is closed");
  assert.equal(conditionHolds(w("closed #3"), facts), false);
  assert.equal(conditionHolds(w("merged #2"), facts), true);
  assert.equal(conditionHolds(w("merged #1"), facts), false, "closed UNMERGED is not merged: the condition cannot come true");
  assert.equal(conditionHolds(w("labelled hold:ceo #3"), facts), true);
  assert.equal(conditionHolds(w("unlabelled hold:ceo #3"), facts), false);
  assert.equal(conditionHolds(w("unlabelled hold:ceo #2"), facts), true);
  assert.equal(conditionHolds(w("closed #404"), facts), null, "an item nobody read");
  assert.equal(conditionHolds(w("closed other/repo#3"), facts), null, "a cross-repository key is its own key");
  assert.equal(conditionHolds(w("manual"), facts), null);
  assert.equal(conditionHolds(parseWaits("Waiting-for: soon")[0], facts), null);
});

// --- (1) the incident --------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL, THE INCIDENT: hold:ceo + `Waiting-for: closed #2867` with #2867 CLOSED is a stale-wait naming the PR, the setter ceo and the field to remove", () => {
  const pr = heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)]);
  const items = [waitItemOf(pr, "pr")];
  const stale = staleWaits({ items, facts: closed2867, now: NOW });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].item.number, 2988);
  assert.equal(stale[0].setter, "ceo");
  assert.ok(stale[0].remove.some((field) => field.includes("hold:ceo")), "the label is named");
  assert.ok(stale[0].remove.some((field) => field.includes("Waiting-for: closed #2867")), "the declaring line is named");
  assert.equal(stale[0].resolvedAt, NOW - 4 * HOUR_MS);
  const [order] = staleWaitOrders(stale) as { session: string; cause: string; subject: string; prompt: string; causeKey: string }[];
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, "org-health");
  assert.equal(order.subject, "stale-wait-2988");
  assert.match(order.prompt, /#2988 declares `Waiting-for: closed #2867` and that condition is now TRUE/);
  assert.match(order.prompt, /hold:ceo/);
  assert.equal(holdExcused(pr, { facts: closed2867, now: NOW }), false, "the label no longer excuses it");
});

test("the SAME fixture with #2867 OPEN yields no stale-wait and keeps the hold excused; an unread reference is excused too, never released", () => {
  const pr = heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)]);
  assert.deepEqual(staleWaits({ items: [waitItemOf(pr, "pr")], facts: open2867, now: NOW }), []);
  assert.equal(holdExcused(pr, { facts: open2867, now: NOW }), true);
  assert.deepEqual(staleWaits({ items: [waitItemOf(pr, "pr")], facts: { items: {} }, now: NOW }), [], "a refused read is an unknown, not a resolution");
  assert.equal(holdExcused(pr, { facts: { items: {} }, now: NOW }), true);
});

test("a `Waiting-for:` line on an item nothing holds is a leftover and stops nothing: it is not stale", () => {
  const row = { number: 7, labels: [{ name: "ready" }], body: "Waiting-for: closed #2867\n" };
  assert.deepEqual(staleWaits({ items: [waitItemOf(row, "row")], facts: closed2867, now: NOW }), []);
});

test("setterOf: the hold's session, else the row's lane owner, else product-manager; lane:any is nobody's", () => {
  assert.equal(setterOf(waitItemOf({ number: 1, labels: ["hold:ceo", "lane:orchestrator"] }, "pr")), "ceo");
  assert.equal(setterOf(waitItemOf({ number: 1, labels: ["lane:orchestrator"] }, "row")), "orchestrator");
  assert.equal(setterOf(waitItemOf({ number: 1, labels: ["lane:any", "blocked"] }, "row")), "product-manager");
  assert.equal(setterOf(waitItemOf({ number: 1, labels: [] }, "row")), "product-manager");
});

// --- (2) the exemption bites ------------------------------------------------------------------------------------------------

/** red-pr-unattended exactly as `orgHealthNow` reads it: `redPrFacts` over the gate's own orders, with the hold's excuse asked of the condition. */
function redReadingFor(pr: Record<string, unknown>, facts: Facts) {
  const prs = withPrOwners([pr] as never, ROWS as never, () => null);
  const decided = decide({ prs, readyRows: [], openRows: ROWS } as never);
  const holdStands = (p: unknown) => holdExcused(p as never, { facts, now: NOW });
  return redPrReading({ now: NOW, redPrs: redPrFacts(prs, decided, { holdStands }) as never });
}

test("red-pr-unattended TRIPS for a red PR whose hold's condition is resolved, and not for one whose condition is unresolved", () => {
  const withCondition = heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)]);
  const tripped = redReadingFor(withCondition, closed2867);
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /#2988 \(red 3 h, NO OWNER\)/);
  assert.equal(redReadingFor(withCondition, open2867).status, "clear");
  assert.equal(redReadingFor(withCondition, { items: {} }).status, "clear", "unread is excused, not released");
});

test("the exemption of a `manual` hold: 3 h old is excused, 5 h old trips", () => {
  assert.equal(redReadingFor(heldPr([marker("Waiting-for: manual", NOW - 3 * HOUR_MS)]), open2867).status, "clear");
  assert.equal(redReadingFor(heldPr([marker("Waiting-for: manual", NOW - 5 * HOUR_MS)]), open2867).status, "tripped");
});

test("a hold with NO reason is excused only while the PR is younger than 4 h quiet, and every hold taken before #2996 is one", () => {
  const quiet = (hours: number) => heldPr([], { updatedAt: ISO(NOW - hours * HOUR_MS) });
  assert.equal(holdReasonOf(quiet(1)).reason, "none");
  assert.equal(redReadingFor(quiet(3), open2867).status, "clear");
  assert.equal(redReadingFor(quiet(5), open2867).status, "tripped");
});

test("THE DEFECT, KEPT AS A CONTROL: with no `holdStands` the label alone excuses, which is what red-pr.mjs did before #2996 and what org-retro and queue-table still ask", () => {
  const pr = heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)]);
  const prs = withPrOwners([pr] as never, ROWS as never, () => null);
  assert.deepEqual(redPrFacts(prs, decide({ prs, readyRows: [], openRows: ROWS } as never)), []);
});

test("holdReasonOf: the NEWEST marker is the reason, so a hold taken with none supersedes an older hold's condition", () => {
  const older = marker("Waiting-for: closed #2867", NOW - 9 * HOUR_MS);
  const newer = { ...marker("No condition was named, so nothing says when this hold ends.", NOW - 2 * HOUR_MS) };
  assert.equal(holdReasonOf(heldPr([older])).reason, "until");
  assert.equal(holdReasonOf(heldPr([older, newer])).reason, "none");
  assert.equal(holdReasonOf(heldPr([newer, older])).reason, "none", "by time, not by position");
  assert.equal(holdReasonOf(heldPr([marker("Waiting-for: manual", NOW - HOUR_MS)])).reason, "manual");
  assert.equal(holdReasonOf(heldPr([], { body: "Waiting-for: merged #5\n" })).reason, "until", "a PR body may carry it");
  assert.equal(holdReasonOf(heldPr([marker("Waiting-for: soon", NOW)])).reason, "none", "unreadable is no reason");
});

// --- (3) every wait FIELD kind ------------------------------------------------------------------------------------------------

const KIND_CASES: Record<string, Record<string, unknown>> = {
  "Not-before": { body: "Not-before: 2026-10-03T18:27:56Z\n" },
  "Fleet-hold-until": { body: "Fleet-hold-until: 2026-10-03T18:27:56Z\n" },
  "hold:*": { labels: [{ name: "hold:ceo" }] },
  "answer:*": { labels: [{ name: "answer:ceo" }] },
  "blocked": { labels: [{ name: "blocked" }] },
  "parked": { labels: [{ name: "parked" }] },
  "blockedBy": { blockedBy: { nodes: [{ number: 2972, state: "OPEN" }] } },
};
const SELF_CLEARS: Record<string, boolean> = { "Not-before": true, "Fleet-hold-until": true, "hold:*": false, "answer:*": false, "blocked": false, "parked": false, "blockedBy": true };

test("the wait-field set is pinned, and a kind added without a case is red", () => {
  assert.deepEqual(WAIT_FIELDS.map((f) => f.kind).sort(), Object.keys(KIND_CASES).sort(), "add a case to KIND_CASES for the new kind");
  assert.deepEqual(Object.fromEntries(WAIT_FIELDS.map((f) => [f.kind, f.selfClears])), SELF_CLEARS);
});

for (const { kind, selfClears } of WAIT_FIELDS) {
  test(`wait field \`${kind}\` ${selfClears ? "CLEARS ITSELF and never needs a condition" : "does NOT clear itself and needs one"}`, () => {
    const raw = { number: 50, updatedAt: ISO(NOW - 5 * HOUR_MS), body: "", ...KIND_CASES[kind] } as Record<string, unknown>;
    const item = waitItemOf(raw, "row");
    assert.ok(waitFieldsOf(item, NOW).some((f) => f.kind === kind), "the gate reads the field");
    const bare = bareWaits({ items: [item], now: NOW });
    assert.equal(bare.length, selfClears ? 0 : 1, selfClears ? "a clock or an edge is never bare" : "no condition, quiet 5 h: wait-without-reason");
    const declared = waitItemOf({ ...raw, body: `${String(raw.body)}Waiting-for: closed #2867\n` }, "row");
    assert.deepEqual(bareWaits({ items: [declared], now: NOW }), [], "with a readable condition it is not bare");
    assert.equal(staleWaits({ items: [declared], facts: closed2867, now: NOW }).length, 1, "and a true condition while the field stands is stale");
    assert.equal(staleWaits({ items: [declared], facts: open2867, now: NOW }).length, 0);
  });
}

test("a clock already in the past is not a wait field", () => {
  assert.deepEqual(waitFieldsOf(waitItemOf({ number: 1, body: "Not-before: 2026-10-01\nFleet-hold-until: 2026-10-01T00:00:00Z\n" }, "row"), NOW), []);
});

// --- (4) a condition the gate cannot read -----------------------------------------------------------------------------------

test("`Waiting-for: soon` is wait-without-reason, never a pass; `manual` is counted and not bare", () => {
  const soon = waitItemOf(heldPr([], { body: "Waiting-for: soon\n" }), "pr");
  const bare = bareWaits({ items: [soon], now: NOW });
  assert.equal(bare.length, 1);
  assert.deepEqual(bare[0].fields, ["hold:ceo"]);
  const reading = waitWithoutReasonReading({ now: NOW, bare });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#2988 \(hold:ceo, quiet 5 h\)/);
  assert.deepEqual(staleWaits({ items: [soon], facts: closed2867, now: NOW }), [], "and it is never read as resolved");
  const manual = waitItemOf(heldPr([], { body: "Waiting-for: manual\n" }), "pr");
  assert.deepEqual(bareWaits({ items: [manual], now: NOW }), []);
  assert.equal(manualWaits({ items: [manual, soon], now: NOW }), 1);
});

test("wait-without-reason: quiet 3 h is clear, 5 h trips, an undated item is unknown and a refused read is unknown", () => {
  const bareAt = (quietSince: number | null) => [{ item: waitItemOf({ number: 9 }, "row"), fields: ["blocked"], quietSince }];
  assert.equal(waitWithoutReasonReading({ now: NOW, bare: bareAt(NOW - 3 * HOUR_MS) as never }).status, "clear");
  assert.equal(waitWithoutReasonReading({ now: NOW, bare: bareAt(NOW - 4 * HOUR_MS + 1) as never }).status, "clear");
  assert.equal(waitWithoutReasonReading({ now: NOW, bare: bareAt(NOW - 4 * HOUR_MS) as never }).status, "tripped");
  assert.equal(waitWithoutReasonReading({ now: NOW, bare: bareAt(null) as never }).status, "unknown");
  assert.equal(waitWithoutReasonReading({ now: NOW, bare: null }).status, "unknown");
});

// --- the readings and the gate's tick ----------------------------------------------------------------------------------------

test("the constants are the row's: 4 hours and 30 minutes", () => {
  assert.equal(MANUAL_WAIT_HOURS, 4);
  assert.equal(STALE_WAIT_GRACE_MINUTES, 30);
});

test("stale-wait is offered to ceo only after 30 minutes of a true condition, and names each wait", () => {
  const item = waitItemOf(heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)]), "pr");
  const at = (resolvedAt: number | null) => staleWaitReading({ now: NOW, stale: [{ item, wait: parseWaits("Waiting-for: closed #2867")[0], setter: "ceo", remove: [], resolvedAt }] as never });
  assert.equal(at(NOW - 29 * MINUTE_MS).status, "clear");
  const tripped = at(NOW - 31 * MINUTE_MS);
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /#2988 \(`Waiting-for: closed #2867` true for 31 min, setter ceo\)/);
  assert.equal(at(null).status, "unknown");
  assert.equal(staleWaitReading({ now: NOW, stale: null }).status, "unknown");
  const [order] = orgHealthOrders(orgHealthReadings({ now: NOW, lastMergedAt: NOW - HOUR_MS, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null,
    waits: { stale: [{ item, wait: parseWaits("Waiting-for: closed #2867")[0], setter: "ceo", remove: [], resolvedAt: NOW - 2 * HOUR_MS }], bare: [], manual: 0 } } as never)) as { session: string; subject: string }[];
  assert.equal(order.session, "ceo");
  assert.equal(order.subject, SIGNALS.STALE_WAIT);
});

/** A `gh api repos/<r>/issues/<n>` that answers from a table, and records what it was asked. */
function fakeGh(table: Record<string, unknown>) {
  const asked: string[] = [];
  const run = (args: string[]) => {
    asked.push(args[1]);
    if (!Object.hasOwn(table, args[1])) throw new Error("refused");
    return JSON.stringify(table[args[1]]);
  };
  return { run, asked };
}
const ISSUE_2867 = { state: "closed", closed_at: ISO(NOW - 4 * HOUR_MS), updated_at: ISO(NOW - 4 * HOUR_MS), merged_at: null, labels: [] };

function tick(prsRead: unknown[], run: (args: string[]) => string) {
  const said: string[] = [];
  const prs = withPrOwners(prsRead as never, ROWS as never, () => null);
  const decideArgs = { prs, required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const decided = decide({ prs, readyRows: [], openRows: ROWS } as never);
  const orders = orgHealthNow({ prsRead, readyRead: [], openRowsRead: [], decideArgs, decided } as never,
    { now: NOW, lastMergedAt: () => NOW - HOUR_MS, log: (line: string) => said.push(line), readCopies: (() => []) as never, readCaptures: (() => undefined) as never,
      readWaits: ((args: never) => waitTickFacts({ ...(args as Parameters<typeof waitTickFacts>[0]), run })) as never,
      // #3364: the gate would LIFT these holds itself; a release that fails is the fallback, so the order and the signal below are still the ones tested here
      // (`gate-lifts-resolved-holds.test.ts` owns the lift).
      release: (() => false) as never,
      // #3672: no remote: a project that declares `teamAccess` would otherwise make the live `gh api` read here, and this file asserts nothing about it
      teamAccess: () => undefined });
  return { orders: orders as { session: string; cause: string; subject: string; prompt: string }[], said };
}

test("THE TICK, END TO END: the freeze's PR with #2867 closed orders the setter AND offers ceo the stale-wait signal AND the red-pr signal", () => {
  const { run, asked } = fakeGh({ "repos/a11ign/a11ign/issues/2867": ISSUE_2867 });
  const { orders } = tick([heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)])], (args) => run(args.map((a) => a.replace(/^repos\/[^/]+\/[^/]+\//, "repos/a11ign/a11ign/"))));
  assert.equal(asked.length, 1, "one read for the one reference");
  const subjects = orders.map((o) => `${o.session}/${o.cause}/${o.subject}`).sort();
  assert.deepEqual(subjects, ["ceo/org-health/red-pr-unattended", "ceo/org-health/stale-wait", "ceo/org-health/stale-wait-2988"]);
});

test("THE SAME TICK with the read REFUSED orders nothing: an unreadable reference is an unknown, said on stderr, never a release", () => {
  const { orders, said } = tick([heldPr([marker("Waiting-for: closed #2867", NOW - 8 * HOUR_MS)])], fakeGh({}).run);
  assert.deepEqual(orders, []);
  assert.deepEqual(said.filter((line) => /stale-wait|wait-without-reason/.test(line)), [], "the reference is unread, the PR list is read: neither wait reading is unknown");
});

test("a reference found in the open lists costs no read, and reads past the bound are left unread", () => {
  const { run, asked } = fakeGh({});
  const row = { number: 2867, labels: [{ name: "ready" }], body: "", updatedAt: ISO(NOW - HOUR_MS) };
  const holder = waitItemOf(heldPr([marker("Waiting-for: closed #2867", NOW - HOUR_MS)]), "pr");
  const facts = readWaitFacts({ items: [holder], open: [row], run });
  assert.equal(facts.items["#2867"].state, "open");
  assert.deepEqual(asked, []);
  const many = waitItemOf(heldPr([], { body: Array.from({ length: 5 }, (_, i) => `Waiting-for: closed #${3000 + i}`).join("\n") }), "pr");
  const asking: string[] = [];
  const bounded = readWaitFacts({ items: [many], open: [], run: (args: string[]) => { asking.push(args[1]); return JSON.stringify(ISSUE_2867); }, limit: 2 });
  assert.equal(asking.length, 2, "the bound stops the reads");
  assert.deepEqual(Object.keys(bounded.items), ["#3000", "#3001"], "and the rest are LEFT OUT, which conditionHolds calls unknown");
  assert.equal(waitTickFacts({ prsRead: null, openRowsRead: [], now: NOW }), null, "a refused list is a refusal, not an empty org");
});

test("refFactOf: merged_at tells a merge from a close, and a state it does not know is null", () => {
  assert.equal(refFactOf({ state: "closed", merged_at: ISO(NOW), closed_at: ISO(NOW - HOUR_MS), updated_at: ISO(NOW), labels: [{ name: "a" }] })?.state, "merged");
  assert.equal(refFactOf({ state: "closed", merged_at: null, closed_at: ISO(NOW - HOUR_MS), updated_at: ISO(NOW), labels: [] })?.resolvedAt, NOW - HOUR_MS);
  assert.deepEqual(refFactOf({ state: "open", updated_at: ISO(NOW), labels: [{ name: "a" }] }), { state: "open", labels: ["a"], resolvedAt: null, changedAt: NOW });
  assert.equal(refFactOf({ state: "weird" }), null);
});

// --- pr:hold --until ---------------------------------------------------------------------------------------------------------

test("pr:hold refuses an --until outside the grammar BEFORE it reads or writes anything", () => {
  const run = spawnSync("node", [HOLD_ENTRY, "2988", "--session=ceo", "--until=soon"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /REFUSING --until="soon": it is not a condition the gate can read/);
  const unknownFlag = spawnSync("node", [HOLD_ENTRY, "2988", "--session=ceo", "--untill=closed #1"], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(unknownFlag.status, 0, "a mistyped flag is still refused as unknown");
});
