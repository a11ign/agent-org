/**
 * #1219: 311 CLOSED ROWS ADVERTISE A LIVE STATUS, AND THE INSTRUMENT WATCHING FOR IT COULD NOT SEE IT.
 *
 * Measured 2026-09-13 across 444 board items, driving the GraphQL query that returns issue STATE rather
 * than `gh project item-list`, which does not carry it:
 *
 * ```
 *  220  In progress / CLOSED
 *   69  Done        / CLOSED
 *   45  Ready       / CLOSED
 *   32  Backlog     / OPEN
 * ```
 *
 * **`Done` is the exception rather than the resting state**, and the board's most populated live column
 * is entirely finished work. A session reading the board to find work reads 220 rows that are done.
 *
 * **HALF THE ROW IS THE INSTRUMENT.** The health check asked `label -> Status` in two directions and
 * never `Status -> label`, so it reported clean while every row disagreed in the direction it did not
 * test. That is #1193's one-directional pin, six hours later, inside the thing watching for it.
 *
 * IMPORTS ONLY THE PURE MODULE, DELIBERATELY. `board-snapshot.mjs` is where this classifier's sibling
 * lives, and its closure carries a `token` -- so a test importing it would make this row's own
 * acceptance command refused in the job that runs acceptance commands. #1009 records that; the remedy
 * is placement, and `deriveClosureRequirements` on the new module returns `[]`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusContradictions, statusCensus, vocabularyDrift, RESTING_STATUS, WRITTEN_STATUSES }
  from "../board-status-health.mjs";
import { readFileSync } from "node:fs";

/** The shape the real query returns, with the numbers this row measured. */
const REAL_SHAPE = [
  { number: 1, state: "CLOSED", status: "In progress" },
  { number: 2, state: "CLOSED", status: "Ready" },
  { number: 3, state: "CLOSED", status: "Done" },
  { number: 4, state: "OPEN", status: "Backlog" },
  { number: 5, state: "OPEN", status: "Ready" },
  { number: 6, state: "OPEN", status: null },
];

test("#1219 clause 1: a closed row at a live Status is reported, and named", () => {
  const { closedButLive } = statusContradictions(REAL_SHAPE);
  // POSITIVE CONTROL FIRST: the census prints what was examined. A query that returned nothing and a
  // board that is clean produce the same empty offender list, and only this separates them.
  const census = statusCensus(REAL_SHAPE);
  assert.match(census, /6 item\(s\) examined/, `census did not report the population:\n${census}`);
  assert.deepEqual(closedButLive.map((i) => i.number), [1, 2],
    "a closed row whose Status is not Done is advertising work that is finished");
});

test("#1219 clause 2: the OTHER direction is a separate failure, not the same check", () => {
  // The half the old instrument never asked. A one-directional pin is satisfied by whichever side you
  // did not look at -- and reporting both through one list would hide which direction broke.
  const { openButDone } = statusContradictions([
    { number: 7, state: "OPEN", status: "Done" },
    { number: 8, state: "OPEN", status: "Ready" },
  ]);
  assert.deepEqual(openButDone.map((i) => i.number), [7],
    "an OPEN row at Done advertises finished work that is not finished -- the reverse error, and it "
    + "must be its own finding rather than folded into the closed-row count");
  // AND THE CONTROL: the same input must produce no closed-row offenders, or clause 1 and clause 2
  // are one assertion wearing two names.
  assert.deepEqual(statusContradictions([{ number: 7, state: "OPEN", status: "Done" }]).closedButLive, []);
});

test("#1219 clause 3: a row with NO Status is not an offender in either direction", () => {
  // The third state, and it must not collapse into either. A row off the board and a row on it at the
  // wrong column need different fixes, and `null` is "nobody said", not "somebody said Done".
  const { closedButLive, openButDone } = statusContradictions([
    { number: 9, state: "CLOSED", status: null },
    { number: 10, state: "OPEN", status: null },
  ]);
  assert.deepEqual([closedButLive, openButDone], [[], []],
    "a row with no Status is unclassified, never assumed -- the same distinction as `unstamped` in the "
    + "provision stamp: 'I could not ask' and 'it matches' are different answers");
});

test("#1219: the Status vocabulary is INJECTED, so a renamed column fails loudly here", () => {
  // This file states no board's column names as fact. If `Done` is renamed, the caller passes the new
  // name and this keeps working; if it is renamed and the caller is NOT updated, every closed row
  // becomes an offender at once -- loud, which is the direction that gets noticed.
  const items = [{ number: 11, state: "CLOSED", status: "Shipped" }];
  assert.deepEqual(statusContradictions(items, { done: "Shipped" }).closedButLive, [],
    "with `Shipped` named as the done state, a closed row at Shipped is correct");
  assert.deepEqual(statusContradictions(items).closedButLive.map((i) => i.number), [11],
    "and with the default it is an offender -- so the vocabulary is really an input, not decoration");
});

/**
 * #1219: THE QUERY MUST ACTUALLY ASK FOR `state`, and nothing else here can tell.
 *
 * Found by mutation: dropping `state` from the GraphQL selection left this suite at 39/0, because every
 * fixture supplies the field itself regardless of what the query requested. **That is the row's own
 * defect restored and unnoticed — a filter on a field nobody fetched — rebuilt inside the fix for it.**
 *
 * Injected fixtures are the right way to test the classifier and they are structurally blind to this:
 * they model the response, so they cannot witness the request. This asserts the request.
 *
 * Read from the query constant with comments stripped, because a comment explaining that `state` is
 * fetched would satisfy a plain search — the shape three separate files needed `stripComments` for
 * tonight.
 */
test("#1219: the board query REQUESTS state -- fixtures cannot witness what the query asks for", () => {
  const source = readFileSync(new URL("../board-snapshot.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const selection = /content\s*\{[^}]*on Issue\s*\{([^}]*)\}/.exec(source);
  assert.ok(selection, "the Issue selection set moved or was renamed -- update this to find it, not to pass");
  assert.match(selection[1], /\bstate\b/,
    "the query does not ask for `state`, so every item arrives without it and `statusContradictions` "
    + "classifies nothing -- silently, because the fixtures in this file supply the field themselves and "
    + "would keep passing. That is the defect #1219 is about, in #1219's own guard");
});

/**
 * #1228: A CLOSED ROW WITH NO STATUS IS A THIRD OUTCOME, not a widened filter.
 *
 * During #1224 this guard reported **41** and the truth was **44** — three closed rows carried no Status,
 * and it compares a Status against `Done`, so it had none to compare. Two sessions predicted 44 and 41
 * from the same board and **both were right about different questions**.
 */
test("#1228: an unboarded closed row is its own outcome, in neither existing list", () => {
  const { closedButLive, openButDone, closedUnboarded } = statusContradictions([
    { number: 1, state: "CLOSED", status: null },
    { number: 2, state: "CLOSED", status: "Ready" },
    { number: 3, state: "OPEN", status: null },
  ]);
  assert.deepEqual(closedUnboarded.map((i) => i.number), [1],
    "a CLOSED row with no Status is reported -- it was invisible, and invisible is not clean");
  assert.deepEqual(closedButLive.map((i) => i.number), [2],
    "and it does NOT migrate into the live list: the remedies differ, so one list with two would tell a "
    + "caller to correct a Status that does not exist");
  assert.deepEqual(openButDone, [],
    "an OPEN row with no Status is not any of the three -- nobody has said anything about it");
});

test("#1228: the third list is EMPTY rather than absent when there is nothing to report", () => {
  // "none" and "not asked" must stay distinguishable -- the distinction this guard is itself about.
  const r = statusContradictions([{ number: 4, state: "CLOSED", status: "Done" }]);
  assert.deepEqual(r.closedUnboarded, [],
    "an empty array, not undefined: a caller destructuring a missing key gets the same silence as a "
    + "clean board, which is the failure mode this row exists to end");
});

/**
 * #1996: THE BOARD OFFERED NO `Done` AT ALL, AND EVERY TEST ABOVE AGREED IT DID.
 *
 * Measured 2026-09-22 on the org Project's live `Status` field: `Backlog, Ready, In progress, Blocked,
 * Fleet-gated` -- and no `Done`. So `settleClosedStatus`'s move had been refused on EVERY closed row
 * since the board moved to the org, and 121 closed rows sat at a live Status while `gh project
 * item-edit` answered `option "Done" not found on field "Status"`.
 *
 * **NOTHING IN THE SUITE COULD SEE IT, INCLUDING THIS FILE.** Every `"Done"` above is a string this
 * repository hands itself: the fixtures supply it, the classifier compares against it, and the settle
 * path wrote it. The live option set was read by no code at all, so the vocabulary could be renamed,
 * dropped, or never exist, with a green suite throughout. These tests pin the two halves of the remedy:
 * the name has ONE copy, and something that reads the live field reports when the board cannot take it.
 */
test("#1996: the resting status has exactly one copy, and the settle path spells no second one", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const health = src("../board-status-health.mjs");
  const settle = src("../settle-closed-status.mjs");
  // DERIVED, not asserted from a list I typed: count the literal in the code rather than in the prose.
  const codeLines = (s: string) => s.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l));
  assert.equal(codeLines(health).filter((l) => l.includes('"Done"')).length, 1,
    'board-status-health.mjs must spell "Done" exactly once -- the RESTING_STATUS declaration. A second '
    + "copy is how the settle path and the classifier came to agree about a name the board did not have");
  assert.deepEqual(codeLines(settle).filter((l) => l.includes('"Done"')), [],
    "and settle-closed-status.mjs must spell it NONE: it imports the name instead");
  // The POSITIVE CONTROL for both counts above: the literal really is the one under test.
  assert.equal(RESTING_STATUS, "Done",
    "pinned as a literal on purpose -- asserting it equals itself would be the defect this row is about");
});

test("#1996: WRITTEN_STATUSES is the set the writers actually send, derived from their source", () => {
  // The population comes from the writers, never from a list typed here: a fifth writer must fail this
  // rather than be silently uncovered by the drift check (#1157's habit, made mechanical where it can be).
  const writers = ["row-claim.mjs", "row-file.mjs", "settle-closed-status.mjs"];
  const sent = new Set<string>();
  for (const w of writers) {
    const src = readFileSync(new URL(`../${w}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/moveStatus\(\s*\w+\s*,\s*"([^"]+)"/g)) sent.add(m[1]);
  }
  // `row-file.mjs` sends `boarding.status`, a variable, so its two names come from `boardingFor`'s own
  // return type -- the one place they are written down.
  const rowFile = readFileSync(new URL("../row-file.mjs", import.meta.url), "utf8");
  for (const m of rowFile.matchAll(/status:\s*"(Backlog|Ready)"/g)) sent.add(m[1]);
  sent.add(RESTING_STATUS); // settle-closed-status sends the imported constant, not a literal.
  assert.deepEqual([...sent].sort(), [...WRITTEN_STATUSES].sort(),
    "every Status name some writer sends must be in WRITTEN_STATUSES, and nothing else -- the drift "
    + "check is only as wide as this list, so a name missing here is a write nobody is watching");
  assert.ok(sent.size >= 4, "POSITIVE CONTROL: the derivation found writers, rather than matching nothing");
});

test("#1996: vocabularyDrift names what the code writes and the board will not take", () => {
  // The board AS MEASURED on 2026-09-22, before this row moved anything.
  const asMeasured = ["Backlog", "Ready", "In progress", "Blocked", "Fleet-gated"];
  assert.deepEqual(vocabularyDrift(asMeasured).missing, ["Done"],
    "the whole defect, in one call: the one name the settle path writes is the one the board lacked");
  const repaired = [...asMeasured, "Done"];
  assert.deepEqual(vocabularyDrift(repaired).missing, [],
    "and the board as this row left it drifts in no direction");
  assert.deepEqual(vocabularyDrift([]).missing, [...WRITTEN_STATUSES],
    "a field offering nothing is total drift -- a real answer, and distinct from the read that failed");
});

test("#1996: a name the board offers and nobody writes is NOT drift", () => {
  // `Blocked` and `Fleet-gated` are set by hand. Reporting them would put permanent noise over the one
  // line that matters, which is how a report stops being read.
  assert.deepEqual(vocabularyDrift([...WRITTEN_STATUSES, "Blocked", "Fleet-gated", "Icebox"]).missing, [],
    "only the direction that breaks a write is reported");
});

test("#1996: a read that FAILED is refused, never reported as a board that lost its vocabulary", () => {
  for (const notRead of [null, undefined]) {
    assert.throws(() => vocabularyDrift(notRead as unknown as string[]), /not a board that drifted/,
      `${notRead} means nobody asked; returning every written name as missing would read as the loudest `
      + "possible finding, sourced from the absence of a measurement");
  }
});
