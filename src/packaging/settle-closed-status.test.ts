/**
 * #1227: the close-side Status write, tested where no token is required.
 *
 * `close-rows-on-merge.test.ts` carries a `token` through its own closure -- it did BEFORE this row, so
 * the row's named acceptance command was never runnable in the job that runs acceptance commands. The
 * decision under test is pure, so it lives in a pure module and is tested here. #1009's rule: the fix is
 * placement, not weakening.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  settleClosedStatus, refusalCause, unsettledVerdict, PROJECT_UNREADABLE,
  // #2081: the board-keyed pass's three pure pieces, in the same pure module and for the same reason.
  closedRowsToSettle, settleBoardRows, boardReadRefusal,
} from "../settle-closed-status.mjs";
// #1996: the resting state's single copy. Imported from the pure module that owns it, so this file's
// closure still needs no token and the row's Acceptance stays runnable where Acceptance runs.
import { RESTING_STATUS } from "../board-status-health.mjs";

/** CAPTURED, not composed: the reason `moveProjectStatus` gave for #1299 in trunk run 34769927592 (`02ae7420`). */
const CAPTURED_PROJECT_UNREADABLE = "could not move #1299's Status to \"Done\" -- board-snapshot: could not read "
  + "Project 1 items -- refusing to snapshot a partial board. NOT_FOUND (organization.projectV2): Could not resolve to a "
  + "ProjectV2 with the number 2.";

test("#1227: the three outcomes are reported distinctly, never folded into one success", () => {
  const said: string[] = [];
  const log = (line: string) => { said.push(String(line)); };
  const settled = [
    settleClosedStatus(1, { moveStatus: () => ({ moved: true }), log }),
    settleClosedStatus(2, { moveStatus: () => ({ moved: false, notOnBoard: true, reason: "not an item" }), log }),
    settleClosedStatus(3, { moveStatus: () => ({ moved: false, notOnBoard: false, reason: "HTTP 500" }), log }),
  ];
  // #1299: the outcome is RETURNED, not only logged -- a caller could not tell the refused move from the others.
  assert.deepEqual(settled, [
    { settled: true, refused: [] },
    { settled: true, refused: [] },
    { settled: false, refused: [{ row: 3, cause: "other", message: "HTTP 500" }] },
  ], "moved and not-on-board are settled; a refused move is not, and carries its row, cause and message");
  assert.match(said[0], /#1 Status -> Done/);
  assert.match(said[1], /#2 is not on the Project/,
    "a row not on the board is a real, common state and not a defect -- ceo's ruling");
  assert.match(said[2], /#3 CLOSED but Status NOT moved -- HTTP 500/,
    "and a genuine failure is the half-applied case: the close landed and the board write did not, which "
    + "must not look like an ordinary success");
});

test("#1227: it asks for `Done` by name, not for whatever it is handed", () => {
  const asked: string[] = [];
  settleClosedStatus(4, { moveStatus: (_n, s) => { asked.push(s); return { moved: true }; }, log: () => {} });
  assert.deepEqual(asked, ["Done"],
    "the resting state is this function's decision -- a caller choosing it would put the same choice in "
    + "two places, which is how the claim-side and close-side writes drifted apart to begin with");
});

test("bridge: the CAPTURED CI refusal is classified project-unreadable where the refusal is made", () => {
  const outcome = settleClosedStatus(1299, {
    moveStatus: () => ({ moved: false, notOnBoard: false, reason: CAPTURED_PROJECT_UNREADABLE }), log: () => {} });
  assert.deepEqual(outcome, { settled: false,
    refused: [{ row: 1299, cause: PROJECT_UNREADABLE, message: CAPTURED_PROJECT_UNREADABLE }] });
});

test("bridge: only the Project's own NOT_FOUND is project-unreadable -- a neighbouring message stays `other`", () => {
  // Each is shaped like the captured message and is not it: a failure the bridge must not absorb.
  const neighbours = [
    "HTTP 500",
    "NOT_FOUND (repository): Could not resolve to a Repository with the name 'o/r'.",
    "NOT_FOUND (organization.projectV2.item): Could not resolve to a node with the global id of 'x'.",
    "could not move #1's Status to \"Done\" -- HTTP 403: Resource not accessible by integration",
  ];
  assert.deepEqual(neighbours.map(refusalCause), ["other", "other", "other", "other"]);
  assert.equal(refusalCause(CAPTURED_PROJECT_UNREADABLE), PROJECT_UNREADABLE,
    "the positive control: the same classifier, on the captured message, does say project-unreadable");
  assert.equal(refusalCause(CAPTURED_PROJECT_UNREADABLE.replace("organization.projectV2", "organization.projectV2")),
    PROJECT_UNREADABLE, "the owner kind is not part of the cause -- the transfer changes it");
});

test("bridge: DEGRADED only when every refusal is project-unreadable -- one other refusal fails the run", () => {
  const unreadable = (row: number) => ({ row, cause: refusalCause(CAPTURED_PROJECT_UNREADABLE), message: CAPTURED_PROJECT_UNREADABLE });
  const other = { row: 7, cause: refusalCause("HTTP 500"), message: "HTTP 500" };
  assert.deepEqual(unsettledVerdict([unreadable(1299), unreadable(1326)]), { degraded: true, other: [] },
    "the CI run as captured: four rows, one cause, is degraded and not failed");
  assert.deepEqual(unsettledVerdict([unreadable(1299), other]), { degraded: false, other: [other] },
    "mixed: the other refusal is named, and the unreadable one does not excuse it");
  assert.deepEqual(unsettledVerdict([other, unreadable(1299)]), { degraded: false, other: [other] }, "in either order");
  assert.deepEqual(unsettledVerdict([]), { degraded: false, other: [] }, "no refusals is neither degraded nor failed");
});

// --- #1360: a row already at Done issues no move; its Status comes from data the caller already holds ---

/** A `moveStatus` that counts every call and records what it was asked for. */
function countingMove(answer: { moved: true } | { moved: false, notOnBoard: boolean, reason: string } = { moved: true }) {
  const calls: Array<[number, string]> = [];
  return { calls, moveStatus: (n: number, s: string) => { calls.push([n, s]); return answer; } };
}

test("#1360 ACCEPTANCE: a row whose held Status is already Done issues NO move, and is settled", () => {
  const move = countingMove();
  const said: string[] = [];
  const outcome = settleClosedStatus(1298, { moveStatus: move.moveStatus, currentStatus: () => "Done",
    log: (line) => said.push(line) });
  assert.equal(move.calls.length, 0, "no GraphQL mutation for a Status that is already where it rests");
  assert.deepEqual(outcome, { settled: true, refused: [] }, "and it is settled, not refused -- nothing is wrong");
  assert.match(said.join("\n"), /#1298 Status is already Done -- no move/, "the skip is said, never silent");
});

test("#1360 CONTROL: a row at a live Status is still moved, once, to Done", () => {
  for (const live of ["In progress", "Ready", "Backlog", "Blocked", "Fleet-gated"]) {
    const move = countingMove();
    const outcome = settleClosedStatus(7, { moveStatus: move.moveStatus, currentStatus: () => live, log: () => {} });
    assert.deepEqual(move.calls, [[7, "Done"]], `a closed row at ${live} must still be moved`);
    assert.deepEqual(outcome, { settled: true, refused: [] });
  }
});

test("#1360 CONTROL: a refused move at a live Status is still reported exactly as #1299 made it", () => {
  const move = countingMove({ moved: false, notOnBoard: false, reason: "HTTP 500" });
  const outcome = settleClosedStatus(3, { moveStatus: move.moveStatus, currentStatus: () => "In progress", log: () => {} });
  assert.equal(move.calls.length, 1);
  assert.deepEqual(outcome, { settled: false, refused: [{ row: 3, cause: "other", message: "HTTP 500" }] });
});

test("#1360 an UNKNOWN Status -- no held snapshot, or a row it does not carry -- is moved as before, never skipped on a guess", () => {
  const unheld = countingMove();
  settleClosedStatus(9, { moveStatus: unheld.moveStatus, currentStatus: () => null, log: () => {} });
  assert.equal(unheld.calls.length, 1, "null is 'not known', and a closed row left at a live Status is #1227's defect");
  const noLookup = countingMove();
  settleClosedStatus(9, { moveStatus: noLookup.moveStatus, log: () => {} });
  assert.equal(noLookup.calls.length, 1, "a caller that passes no lookup behaves exactly as before this row");
});

test("#1360 only the exact resting state skips: a Status merely CONTAINING 'Done' is still moved", () => {
  for (const near of ["done", "Done ", "Not Done", ""]) {
    const move = countingMove();
    settleClosedStatus(11, { moveStatus: move.moveStatus, currentStatus: () => near, log: () => {} });
    assert.equal(move.calls.length, 1, `${JSON.stringify(near)} is not the resting state this function names`);
  }
});

test("#1360 a Status read that FAILS refuses with its classified cause, and the move is never attempted", () => {
  const move = countingMove();
  const unreadable = settleClosedStatus(1393, { moveStatus: move.moveStatus, log: () => {},
    currentStatus: () => { throw new Error("board-snapshot: could not read Project 1's item for #1393 -- refusing to mutate "
      + "without a snapshot. NOT_FOUND (organization.projectV2): Could not resolve to a ProjectV2 with the number 2."); } });
  assert.equal(move.calls.length, 0, "no second read by the move: CI's unreadable Project would fail twice per row");
  assert.equal(unreadable.settled, false);
  assert.equal(unreadable.refused[0].cause, PROJECT_UNREADABLE, "classified where the refusal is made, as #546's bridge reads it");
  assert.match(unreadable.refused[0].message, /could not read #1393's Status before moving it/);
  const other = settleClosedStatus(8, { moveStatus: move.moveStatus, log: () => {},
    currentStatus: () => { throw new Error("HTTP 502"); } });
  assert.equal(other.refused[0].cause, "other", "CONTROL: a failure that is not the unreadable Project stays other");
  assert.equal(move.calls.length, 0);
});

/**
 * #1996: THE NAME IT ASKS FOR IS NOW IMPORTED, AND THE TEST ABOVE STILL PINS THE LITERAL.
 *
 * Measured 2026-09-22: the live board's `Status` field offered `Backlog, Ready, In progress, Blocked,
 * Fleet-gated` and no `Done`, so every move this function made had been refused since the board moved to
 * the org -- 121 closed rows stranded at a live Status, under a green suite. The suite was green because
 * `"Done"` was a string this repository handed itself in every direction: written here, defaulted in
 * `statusContradictions`, supplied by the fixtures.
 *
 * The remedy has two halves and neither is a test: the name has ONE copy (`RESTING_STATUS`), and
 * `board-snapshot.mjs` reads the live option list and reports what this code writes that the board will
 * not take. What a test CAN hold is that the copy really is one -- which is
 * `board-status-health.test.ts`'s `one copy` case -- and that consolidating it did not change the name
 * actually sent, which is the existing `it asks for \`Done\` by name` case above, deliberately left
 * spelling the literal.
 */
test("#1996: the imported constant is the same name the move was always sent, spelled independently", () => {
  const asked: string[] = [];
  settleClosedStatus(12, { moveStatus: (_n, s) => { asked.push(s); return { moved: true }; }, log: () => {} });
  assert.deepEqual(asked, ["Done"],
    "the literal, NOT `RESTING_STATUS` -- asserting the constant equals the constant is the shape that "
    + "let this defect live, and a rename that silently changed what is sent must fail here");
  assert.equal(RESTING_STATUS, "Done", "and the constant is that same name, checked once, in one place");
});

test("#1996: the skip and the log line follow the constant rather than a second literal", () => {
  const calls: string[] = [];
  const said: string[] = [];
  const outcome = settleClosedStatus(13, { currentStatus: () => RESTING_STATUS, log: (l) => said.push(l),
    moveStatus: (_n, s) => { calls.push(s); return { moved: true }; } });
  assert.equal(calls.length, 0, "#1360's skip still fires, now keyed on the imported name");
  assert.deepEqual(outcome, { settled: true, refused: [] });
  assert.match(said.join("\n"), /#13 Status is already Done -- no move/,
    "and the line an operator reads still names the real status, not a variable name");
});

// --- #2081: the board-keyed pass -- the population is the BOARD, and no PR list is ever read ---

/** The board as `board-snapshot.mjs` records it, narrowed to the three fields the classifier reads. */
type Item = { number: number | null, state: string | null, status: string | null };
const item = (number: number | null, state: string | null, status: string | null): Item => ({ number, state, status });

/**
 * THE INJECTED BOARD THE DONE-WHEN NAMES, and what makes it the right control is what is NOT in it:
 * no PR number, no `closingIssuesReferences`, no merge time -- nothing a merged-PR-keyed path could key on.
 * #2061 and #1976 are real rows from the 2026-09-23 measurement, closed BY HAND, drifted at a live Status.
 */
const HAND_CLOSED_BOARD: Item[] = [
  item(2061, "CLOSED", "In progress"), // closed by hand, drifted -- the row this pass exists for
  item(1976, "CLOSED", "Fleet-gated"), // and one advertising itself as pickable fleet work
  item(2037, "CLOSED", "Done"), // already settled: no write
  item(2081, "OPEN", "In progress"), // live work: never touched
  item(1234, "OPEN", "Done"), // #1228's OTHER contradiction -- a different defect, not this pass's to repair
  item(1978, "CLOSED", null), // on the board, no Status at all: counted apart, repaired the same way
  item(null, null, "Ready"), // a draft item: content is null, so it has no issue to edit
  item(null, "CLOSED", "In progress"), // and the same, arriving through the offender list -- see below
];

/** A `settle` that records what it was asked to move and what Status the pass handed it, and always succeeds. */
function recordingSettle() {
  const calls: Array<[number, string | null]> = [];
  const settle = (n: number, held: string | null) => {
    calls.push([n, held]);
    return { settled: true, refused: [] } as ReturnType<typeof settleClosedStatus>;
  };
  return { calls, settle };
}

test("#2081 ACCEPTANCE: a row closed BY HAND is settled from the board alone -- no PR anywhere in the data", () => {
  const move = recordingSettle();
  const said: string[] = [];
  const outcome = settleBoardRows(HAND_CLOSED_BOARD, { settle: move.settle, log: (l) => said.push(l) });
  assert.deepEqual(outcome.attempted, [2061, 1976, 1978],
    "every CLOSED row whose Status is not Done, and only those -- #2061 and #1976 have no closing PR at "
    + "all, which is exactly why both merged-PR-keyed paths leave them drifted forever");
  assert.deepEqual(outcome.unsettled, []);
  assert.deepEqual(move.calls.map(([, held]) => held), ["In progress", "Fleet-gated", null],
    "and each move is handed the Status the board read already holds, not a second per-row read (#1360)");
  assert.match(said.join("\n"), /8 board item\(s\) read -- 2 CLOSED at a live Status, 1 CLOSED with no Status/,
    "the census prints whatever the verdict: 'nothing drifted' and 'nothing examined' are the same empty result");
});

test("#2081 NEGATIVE: a closed row already at Done, an OPEN row, and a numberless item produce no move at all", () => {
  const move = recordingSettle();
  settleBoardRows(HAND_CLOSED_BOARD, { settle: move.settle, log: () => {} });
  const touched = move.calls.map(([n]) => n);
  assert.equal(touched.includes(2037), false, "a closed row ALREADY at Done is not written again (#1360's budget)");
  assert.equal(touched.includes(2081), false, "an OPEN row at a live Status is live work, whatever this pass thinks");
  assert.equal(touched.includes(1234), false,
    "an OPEN row at Done is #1228's OTHER contradiction -- reported by the health check, never repaired by "
    + "moving it to Done, which is where it already is");
  assert.equal(touched.includes(null as unknown as number), false,
    "and NOTHING WITHOUT AN ISSUE NUMBER is ever moved: `gh project item-edit --url` has no URL to name. The "
    + "second numberless row is CLOSED at a live Status, so it reaches the offender list and only the "
    + "narrowing keeps it out -- today's producer cannot emit that pairing (number and state both come from "
    + "`content`), so this pins the function's contract against its DECLARED input type rather than one board");
  assert.equal(move.calls.length, 3);
});

test("#2081 CONTROL: the population is not empty by construction -- a board with nothing drifted attempts nothing", () => {
  const move = recordingSettle();
  const clean = [item(1, "CLOSED", "Done"), item(2, "OPEN", "Ready"), item(3, "OPEN", "In progress")];
  const outcome = settleBoardRows(clean, { settle: move.settle, log: () => {} });
  assert.deepEqual(outcome.attempted, [],
    "the emptiness this asserts is real, and the case above is its positive control");
  assert.equal(move.calls.length, 0);
});

test("#2081 the two lists stay apart (#1228), and both are settled", () => {
  const { atLiveStatus, withNoStatus } = closedRowsToSettle(HAND_CLOSED_BOARD);
  assert.deepEqual(atLiveStatus, [{ number: 2061, status: "In progress" }, { number: 1976, status: "Fleet-gated" }]);
  assert.deepEqual(withNoStatus, [{ number: 1978, status: null }],
    "a closed row with NO Status is invisible to a check that reads Statuses, which is why #1228 counts it "
    + "separately -- the repair is the same write, and folding the lists would undo that row");
});

test("#2081 a row that is not an item on the Project is REPORTED and skipped, never refused", () => {
  const said: string[] = [];
  const outcome = settleBoardRows([item(393, "CLOSED", "In progress")], {
    log: (l) => said.push(l),
    settle: (n) => settleClosedStatus(n, { log: (l) => said.push(l), prefix: "SETTLE-BOARD",
      moveStatus: () => ({ moved: false, notOnBoard: true, reason: "issue #393 is not an item in project 1" }) }),
  });
  assert.deepEqual(outcome.unsettled, [],
    "an off-board row is not a failure of this pass -- #2075 owns that population");
  assert.match(said.join("\n"), /SETTLE-BOARD: #393 is not on the Project -- no Status to move/);
});

test("#2081 a refused move is carried out of the pass with its classified cause, row by row", () => {
  const board = [item(7, "CLOSED", "In progress"), item(8, "CLOSED", "Backlog")];
  const outcome = settleBoardRows(board, {
    log: () => {},
    settle: (n) => settleClosedStatus(n, { log: () => {}, prefix: "SETTLE-BOARD",
      moveStatus: () => ({ moved: false, notOnBoard: false,
        reason: n === 7 ? CAPTURED_PROJECT_UNREADABLE : "HTTP 500" }) }),
  });
  assert.deepEqual(outcome.attempted, [7, 8]);
  assert.deepEqual(outcome.unsettled.map((r) => [r.row, r.cause]), [[7, PROJECT_UNREADABLE], [8, "other"]]);
  // The exit contract `closeRowsExit` reads off this list, pinned through the same pure verdict it calls:
  assert.equal(unsettledVerdict(outcome.unsettled).degraded, false,
    "one `other` refusal still fails the run (exit 3)");
  assert.equal(unsettledVerdict(outcome.unsettled.slice(0, 1)).degraded, true,
    "and a run whose every refusal is the unreadable Project is DEGRADED -- exit 0, as in CI");
});

test("#2081 the BOARD READ's own refusal is classified too: CI is stopped before any row exists to refuse", () => {
  // CAPTURED: `fetchBoardItems`'s own thrown message, which carries GraphQL's error verbatim (#555).
  const ciRead = "board-snapshot: could not read Project 1 items -- refusing to snapshot a partial board. "
    + "NOT_FOUND (organization.projectV2): Could not resolve to a ProjectV2 with the number 1.";
  const degraded = boardReadRefusal(ciRead);
  assert.equal(degraded.degraded, true,
    "exit 0 with a DEGRADED line: this command runs in CI too, and trunk must not go red for #546's ceiling");
  assert.match(degraded.line, /SETTLE-BOARD: DEGRADED -- the board could not be read, so no Status was examined/);
  const other = boardReadRefusal("board-snapshot: gh's response was not JSON -- refusing to guess.");
  assert.equal(other.degraded, false, "CONTROL: any other read failure is INCONCLUSIVE, never 'fine' -- exit 2");
  assert.match(other.line, /SETTLE-BOARD: CANNOT ASK/);
});

test("#2081 the log prefix says which path did the work, and the two older paths are unchanged", () => {
  const said: string[] = [];
  settleClosedStatus(1, { moveStatus: () => ({ moved: true }), log: (l) => said.push(l), prefix: "SETTLE-BOARD" });
  settleClosedStatus(2, { moveStatus: () => ({ moved: true }), log: (l) => said.push(l) });
  assert.deepEqual(said, ["SETTLE-BOARD: #1 Status -> Done.", "CLOSE-ROWS: #2 Status -> Done."],
    "close-rows-sweep.mjs's own rule -- which path did the work is a fact about the pipeline's health -- and "
    + "the default is the literal both close paths have always logged");
});

/**
 * #2081's done-when in its structural form: the pass must never read a PR list, because reading one is
 * precisely what makes a hand-closed row invisible. Asserted on the source with its own positive control,
 * so "the check found nothing" and "the check cannot see anything" stay distinguishable.
 */
test("#2081 the board-keyed command reads no PR list -- and the same check DOES fire on the path that does", () => {
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  // COMMENTS STRIPPED FIRST: both files DISCUSS the PR-keyed population in prose -- this pass's header says
  // at length why it reads no PR list -- and a check that cannot tell a mention from a call is a check on
  // the wording rather than on the code.
  const codeOnly = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const readsPrList = (text: string) => /\["pr", "list"|closingIssuesReferences/.test(codeOnly(text));
  assert.equal(readsPrList(source("settle-closed-rows.mjs")), false, "the board-keyed pass keys on the board alone");
  assert.equal(readsPrList(source("close-rows-sweep.mjs")), true,
    "THE POSITIVE CONTROL: the sweep this pass complements does read one, so the check above is not vacuous");
});
