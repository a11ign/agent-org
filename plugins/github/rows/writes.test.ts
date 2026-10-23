// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 4): THE ARGUMENTS AND READINGS OF TWO OF THE ROWS' OPERATIONS, which core's tests of their callers used to assert and which are the plugin's now (core's tests of those callers run on the fake
 * code host's rows): `createRow` (agent-org#1208, the tick's standing row) and `commentsSince` (a11ign#5117, the stops `spec-lint` counts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentsSince } from "./comments-since.ts";
import { createRow } from "./approved-unqueued-reads.ts";

test("agent-org#1208: the created row carries exactly the labels it was given, its number is read from the printed URL, and a create that printed none is thrown", () => {
  let argv: string[] = [];
  const number = createRow({ repo: "a11ign/a11ign", title: "t", labels: ["lane:ceo"], body: "b", run: (args) => { argv = args; return "https://github.com/a11ign/a11ign/issues/4321\n"; } });
  assert.equal(number, 4321);
  assert.deepEqual(argv.filter((arg, index) => argv[index - 1] === "--label"), ["lane:ceo"], "one label, the lane; `ready` would offer the row as work");
  assert.throws(() => createRow({ repo: "a/b", title: "t", labels: [], body: "b", run: () => "created" }), /printed no row URL/, "a create with no number is never taken for one");
});

const NOW = Date.parse("2026-10-11T18:00:00Z");
const comment = (body: string) => ({ body, created_at: "2026-10-11T12:00:00Z", issue_url: "https://api.github.com/repos/a11ign/a11ign/issues/6001" });

test("`commentsSince` flattens the pages, and a refused run or an answer that is not a list of lists is `null`, never `[]`", () => {
  const seen: string[][] = [];
  const flat = commentsSince({ repo: "a11ign/a11ign", since: NOW, run: (args) => {
    seen.push(args);
    return [[comment("a"), comment("b")], [comment("c")]];
  } });
  assert.deepEqual(flat?.map((one) => one.body), ["a", "b", "c"]);
  assert.deepEqual(seen[0], ["api", "--paginate", "--slurp", "repos/a11ign/a11ign/issues/comments?since=2026-10-11T18:00:00.000Z&per_page=100"]);
  assert.deepEqual(commentsSince({ repo: "r/r", since: NOW, run: () => [] }), [], "a list with no page is no comments: the read WORKED (the twin of the two nulls)");
  assert.equal(commentsSince({ repo: "r/r", since: NOW, run: () => null }), null);
  assert.equal(commentsSince({ repo: "r/r", since: NOW, run: () => [{ message: "Bad credentials" }] }), null);
});
