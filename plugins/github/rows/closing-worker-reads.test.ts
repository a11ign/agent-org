// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE ARGUMENTS AND READINGS OF THE ROW READS `worker:state` AND THE WORKTREE REMOVERS ASK, which core's tests of those callers used to assert over a stubbed `gh` (`worker-state.test.ts`'s
 * `ghRowLook` case, `prune-worktrees.test.ts`'s and `worktree-removal.test.ts`'s answers to `issue view`) and which are the plugin's now (core's tests of them run on the fake code host's rows).
 * The argument lists are copied from the callers they were moved from (`src/worker-state.ts` and `src/worktree-removal.ts` at the commit before the move).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowNumberStateAndLabelsOf, rowStateAndLabelsOf, rowWithCommentsOf } from "./closing-rows.ts";

/** A `run` that records the argument list it was given and answers `answer`, or throws it. */
const recording = (answer: string | Error) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); if (answer instanceof Error) throw answer; return answer; } };
};

const COMMENTED = '{"state":"CLOSED","body":"B","labels":[{"name":"x"}],"comments":[{"id":"IC_1","url":"u","body":"b","createdAt":"t","author":{"login":"a"}}]}';
const LOOK = ["issue", "view", "460", "--repo", "a11ign/a11ign", "--json", "state,labels,comments,body"];

test("`worker:state` reads a row in ONE call -- its state, labels, comments and body -- and keeps only the fields it weighs of each comment", () => {
  const { seen, run } = recording(COMMENTED);
  assert.deepEqual(rowWithCommentsOf({ repo: "a11ign/a11ign", number: 460, run }), { state: "CLOSED", labels: ["x"], comments: [{ id: "IC_1", url: "u", body: "b", createdAt: "t" }], body: "B" });
  assert.deepEqual(seen, [LOOK]);
});

test("a row read with a missing body or labels reads them as empty, a state that is not OPEN reads CLOSED, and a reply with no comments is an empty list", () => {
  assert.deepEqual(rowWithCommentsOf({ repo: "r/r", number: 1, run: recording('{"state":"OPEN","comments":[]}').run }), { state: "OPEN", labels: [], comments: [], body: "" });
  assert.deepEqual(rowWithCommentsOf({ repo: "r/r", number: 1, run: recording('{"state":"MERGED","labels":[],"comments":[]}').run })?.state, "CLOSED", "anything but OPEN is closed");
  assert.deepEqual(rowWithCommentsOf({ repo: "r/r", number: 1, run: recording('{"state":"OPEN","labels":[],"comments":[],"body":null}').run })?.body, "");
});

test("a reply with no comments field THROWS: no comments would read as no ruling, which fails open", () => {
  assert.throws(() => rowWithCommentsOf({ repo: "a11ign/a11ign", number: 460, run: recording('{"state":"OPEN","labels":[]}').run }), /gh issue view of #460 of a11ign\/a11ign carried no comments field, so no ruling can be read/);
  assert.throws(() => rowWithCommentsOf({ repo: "r/r", number: 1, run: recording('{"state":"OPEN","labels":[],"comments":{}}').run }), /no comments field/, "a field that is not a list is no comments field either");
  assert.throws(() => rowWithCommentsOf({ repo: "r/r", number: 1, run: recording("not json").run }), SyntaxError);
});

test("no such issue is null, in each of the three phrasings GitHub uses, whether the CLI put it on stderr or in the message; any other failure is thrown as it came", () => {
  for (const said of ["GraphQL: Could not resolve to an Issue with the number of 9999.", "GraphQL: Could not resolve to an issue with the number of 9999.", "issue not found", "no issue matches"]) {
    assert.equal(rowWithCommentsOf({ repo: "a11ign/a11ign", number: 9999, run: recording(Object.assign(new Error("gh failed"), { stderr: said })).run }), null, `stderr: ${said}`);
    assert.equal(rowWithCommentsOf({ repo: "a11ign/a11ign", number: 9999, run: recording(new Error(said)).run }), null, `message: ${said}`);
  }
  const bad = Object.assign(new Error("gh failed"), { stderr: "HTTP 502" });
  assert.throws(() => rowWithCommentsOf({ repo: "a11ign/a11ign", number: 460, run: recording(bad).run }), (thrown) => thrown === bad, "a refusal that is not 'no such issue' is not a missing row");
});

test("a claim read is `issue view` of the row for its state and labels: a closed row, an open one, and the names of its labels", () => {
  const { seen, run } = recording('{"state":"OPEN","labels":[{"name":"in-progress"},{"name":"session:worker-1"}]}');
  assert.deepEqual(rowStateAndLabelsOf({ repo: "a11ign/agent-org", number: 1159, run }), { state: "OPEN", labels: ["in-progress", "session:worker-1"] });
  assert.deepEqual(seen, [["issue", "view", "1159", "--repo", "a11ign/agent-org", "--json", "state,labels"]]);
  assert.deepEqual(rowStateAndLabelsOf({ repo: "r/r", number: 2, run: recording('{"state":"CLOSED","labels":[]}').run }), { state: "CLOSED", labels: [] });
});

test("a claim read that cannot be made THROWS, and so does an answer that carries no labels: could not ask is never nobody holds it", () => {
  assert.throws(() => rowStateAndLabelsOf({ repo: "r/r", number: 1, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  assert.throws(() => rowStateAndLabelsOf({ repo: "r/r", number: 1, run: recording('{"state":"OPEN"}').run }), TypeError);
  assert.throws(() => rowStateAndLabelsOf({ repo: "r/r", number: 1, run: recording("not json").run }), SyntaxError);
});

test("the orphaned-row report reads a row's number, state and labels in its repository; a row without labels has none, and a refusal throws", () => {
  const { seen, run } = recording('{"number":2000,"state":"OPEN","labels":[{"name":"in-progress"}]}');
  assert.deepEqual(rowNumberStateAndLabelsOf({ repo: "a11ign/a11ign", number: 2000, run }), { number: 2000, state: "OPEN", labels: ["in-progress"] });
  assert.deepEqual(seen, [["issue", "view", "2000", "--repo", "a11ign/a11ign", "--json", "number,state,labels"]]);
  assert.deepEqual(rowNumberStateAndLabelsOf({ repo: "r/r", number: 3, run: recording('{"number":3,"state":"CLOSED"}').run }), { number: 3, state: "CLOSED", labels: [] });
  assert.throws(() => rowNumberStateAndLabelsOf({ repo: "r/r", number: 3, run: recording(new Error("HTTP 404")).run }), /HTTP 404/);
});
