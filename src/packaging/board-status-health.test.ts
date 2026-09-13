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
import { statusContradictions, statusCensus } from "../../../../scripts/board-status-health.mjs";
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
  const source = readFileSync(new URL("../../../../scripts/board-snapshot.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const selection = /content\s*\{[^}]*on Issue\s*\{([^}]*)\}/.exec(source);
  assert.ok(selection, "the Issue selection set moved or was renamed -- update this to find it, not to pass");
  assert.match(selection[1], /\bstate\b/,
    "the query does not ask for `state`, so every item arrives without it and `statusContradictions` "
    + "classifies nothing -- silently, because the fixtures in this file supply the field themselves and "
    + "would keep passing. That is the defect #1219 is about, in #1219's own guard");
});
