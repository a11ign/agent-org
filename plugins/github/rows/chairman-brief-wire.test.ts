// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * a11ign#5528, agent-org#1538 (A11-160, step 9): THE CHAIRMAN'S BRIEF ON A REVIEW-GATED PULL REQUEST is two writes, and the gate's decision to file it (core's, tested on the fake code host in
 * `src/work-gate/pr-orders.test.ts`) does not see their argument lists: the label first, then the brief as a comment, each aimed at the pull request's repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

test("the brief is the label on the pull request, then the brief as its comment, both aimed at its repository", () => {
  const writes = recording("");
  rows().briefChairmanOnPull({ repo: "a11ign/a11ign", number: 5528, label: "needs:chairman", body: "the brief\nin two lines", run: writes.run });
  assert.deepEqual(writes.asked, [
    ["pr", "edit", "5528", "--repo", "a11ign/a11ign", "--add-label", "needs:chairman"],
    ["pr", "comment", "5528", "--repo", "a11ign/a11ign", "--body", "the brief\nin two lines"],
  ]);
});

test("a refused label write is thrown and the comment is not posted", () => {
  const refused = recording(new Error("HTTP 502"));
  assert.throws(() => rows().briefChairmanOnPull({ repo: "a11ign/a11ign", number: 5528, label: "needs:chairman", body: "b", run: refused.run }), /HTTP 502/);
  assert.equal(refused.asked.length, 1);
});
