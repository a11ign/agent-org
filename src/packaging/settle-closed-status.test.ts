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
