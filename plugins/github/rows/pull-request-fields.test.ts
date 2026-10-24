// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 9, part B): WHAT ONE PULL REQUEST'S NAMED FIELDS ASK OF GITHUB. The verdict delivery's read of a pull request (`pullReadOf`, agent-org#1649) DECIDES on the state, the head and the comments of the pull request
 * it is handed, and its tests run on the fake code host; the argument list the read sends, and the refusal of a read that fails, are here. Moved from `verdict-delivery.test.ts`, whose `run` stub answered the read for `pullReadOf`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pullRequestFieldsOf } from "./pull-request-fields.ts";
import { recording } from "./recording-run.test.support.ts";

const HEAD = "a".repeat(40);

test("#1649 (3) THE READ of GitHub asks for the state, the head and the verdict-bearing fields in the pull request's repository, and a refused read is null", () => {
  const { run, asked } = recording({ state: "OPEN", headRefOid: HEAD, comments: [], reviews: [] });
  assert.deepEqual(pullRequestFieldsOf({ repo: "a11ign/a11ign", number: 1655, fields: "state,headRefOid,comments,reviews", run }), { state: "OPEN", headRefOid: HEAD, comments: [], reviews: [] });
  assert.deepEqual(asked, [["pr", "view", "1655", "--repo", "a11ign/a11ign", "--json", "state,headRefOid,comments,reviews"]]);
  assert.equal(pullRequestFieldsOf({ repo: "a11ign/a11ign", number: 1655, fields: "state", run: recording(new Error("HTTP 502")).run }), null);
});

test("an answer that does not parse is null as a refused read is: absence is not proof", () => {
  assert.equal(pullRequestFieldsOf({ repo: "a11ign/a11ign", number: 1655, fields: "state", run: recording("<html>").run }), null);
});
