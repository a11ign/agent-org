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
import { settleClosedStatus } from "../../../../scripts/settle-closed-status.mjs";

test("#1227: the three outcomes are reported distinctly, never folded into one success", () => {
  const said: string[] = [];
  const log = (line: string) => { said.push(String(line)); };
  settleClosedStatus(1, { moveStatus: () => ({ moved: true }), log });
  settleClosedStatus(2, { moveStatus: () => ({ moved: false, notOnBoard: true, reason: "not an item" }), log });
  settleClosedStatus(3, { moveStatus: () => ({ moved: false, notOnBoard: false, reason: "HTTP 500" }), log });
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
