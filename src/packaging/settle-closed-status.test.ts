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
import {
  settleClosedStatus, refusalCause, unsettledVerdict, PROJECT_UNREADABLE,
} from "../../../../scripts/settle-closed-status.mjs";

/** CAPTURED, not composed: the reason `moveProjectStatus` gave for #1299 in trunk run 34769927592 (`02ae7420`). */
const CAPTURED_PROJECT_UNREADABLE = "could not move #1299's Status to \"Done\" -- board-snapshot: could not read "
  + "Project 2 items -- refusing to snapshot a partial board. NOT_FOUND (user.projectV2): Could not resolve to a "
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
    "NOT_FOUND (user.projectV2.item): Could not resolve to a node with the global id of 'x'.",
    "could not move #1's Status to \"Done\" -- HTTP 403: Resource not accessible by integration",
  ];
  assert.deepEqual(neighbours.map(refusalCause), ["other", "other", "other", "other"]);
  assert.equal(refusalCause(CAPTURED_PROJECT_UNREADABLE), PROJECT_UNREADABLE,
    "the positive control: the same classifier, on the captured message, does say project-unreadable");
  assert.equal(refusalCause(CAPTURED_PROJECT_UNREADABLE.replace("user.projectV2", "organization.projectV2")),
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
    currentStatus: () => { throw new Error("board-snapshot: could not read Project 2's item for #1393 -- refusing to mutate "
      + "without a snapshot. NOT_FOUND (user.projectV2): Could not resolve to a ProjectV2 with the number 2."); } });
  assert.equal(move.calls.length, 0, "no second read by the move: CI's unreadable Project would fail twice per row");
  assert.equal(unreadable.settled, false);
  assert.equal(unreadable.refused[0].cause, PROJECT_UNREADABLE, "classified where the refusal is made, as #546's bridge reads it");
  assert.match(unreadable.refused[0].message, /could not read #1393's Status before moving it/);
  const other = settleClosedStatus(8, { moveStatus: move.moveStatus, log: () => {},
    currentStatus: () => { throw new Error("HTTP 502"); } });
  assert.equal(other.refused[0].cause, "other", "CONTROL: a failure that is not the unreadable Project stays other");
  assert.equal(move.calls.length, 0);
});
