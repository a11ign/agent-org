// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 7): THE ARGUMENTS AND READINGS OF THE CLAIM'S OPERATIONS, which core's tests of `row-claim.ts` used to assert over a stubbed `gh` and which are the plugin's now (core's tests of the claim run on
 * the fake code host's rows). The argument lists are the ones `row-claim.ts` built before they moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editRowLabels, ensureLabelArgs, readRestComments, readRestRow, setRowLabels } from "./claim-ops.ts";
import { recording } from "./recording-run.test.support.ts";

const REPO = "a11ign/agent-org";

test("a label is created in the tracker's repository with --force, so a second claim's create is harmless", () => {
  assert.deepEqual(ensureLabelArgs("session:worker-1", REPO), ["label", "create", "session:worker-1", "--repo", REPO, "--force"]);
});

test("(agent-org#1302) a row is read over REST, its labels by name and its state upper-cased; a state REST does not state is absent", () => {
  const open = recording({ number: 7, title: "A row", labels: [{ name: "ready" }, { name: "lane:x" }], state: "open" });
  assert.deepEqual(readRestRow({ repo: REPO, number: 7, run: open.run }), { row: { number: 7, title: "A row", labels: ["ready", "lane:x"], state: "OPEN" } });
  assert.deepEqual(open.asked, [["api", `repos/${REPO}/issues/7`]], "one REST read of the row, not `gh issue view`: GraphQL's pool may be exhausted");
  assert.equal((readRestRow({ repo: REPO, number: 7, run: recording({ number: 7, title: "t", labels: [], state: "closed" }).run }) as { row: { state: string } }).row.state, "CLOSED");
  assert.equal((readRestRow({ repo: REPO, number: 7, run: recording({ number: 7, title: "t", labels: [] }).run }) as { row: { state?: string } }).row.state, undefined, "no state stated is not a verified close");
});

test("a refused read THROWS what `gh` threw; an answer that is not a row is `unreadable`, in the words the claim refuses with, never an empty label list", () => {
  assert.throws(() => readRestRow({ repo: REPO, number: 7, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  const notJson = readRestRow({ repo: REPO, number: 7, run: () => "<html>" });
  assert.deepEqual(notJson, { unreadable: "row-claim: gh's response for issue #7 was not JSON -- refusing to guess. First 200 chars: <html>" });
  const noLabels = readRestRow({ repo: REPO, number: 7, run: recording({ number: 7, title: "t" }).run });
  assert.match("unreadable" in noLabels ? noLabels.unreadable : "", /^row-claim: gh's response for issue #7 is missing number\/title\/labels -- refusing to guess\. Got: /);
  const nameless = readRestRow({ repo: REPO, number: 7, run: recording({ number: 7, title: "t", labels: [{ name: "a" }, {}] }).run });
  assert.deepEqual(nameless, { unreadable: "row-claim: a label on issue #7 has no name -- refusing to guess. Got: {}" });
});

test("(agent-org#1302) the comments are read over REST with the pages joined, the last 100 are kept oldest first, and a comment with no body is an empty one", () => {
  const pages = recording([[{ body: "a" }, { body: 4 }], [{ body: "c" }]]);
  assert.deepEqual(readRestComments({ repo: REPO, number: 7, run: pages.run }), { comments: ["a", "", "c"] });
  assert.deepEqual(pages.asked, [["api", `repos/${REPO}/issues/7/comments?per_page=100`, "--paginate", "--slurp"]]);
  const many = recording([Array.from({ length: 130 }, (_, at) => ({ body: `c${at}` }))]);
  const read = readRestComments({ repo: REPO, number: 7, run: many.run }) as { comments: string[] };
  assert.equal(read.comments.length, 100);
  assert.equal(read.comments[0], "c30", "the NEWEST hundred, as GraphQL's `comments(last: 100)` gave them");
  assert.equal(read.comments.at(-1), "c129");
  assert.throws(() => readRestComments({ repo: REPO, number: 7, run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
  assert.match((readRestComments({ repo: REPO, number: 7, run: () => "not json" }) as { unreadable: string }).unreadable, /^row-claim: gh's comment response for issue #7 was not JSON -- refusing to guess\. First 200 chars: not json$/);
  assert.match((readRestComments({ repo: REPO, number: 7, run: recording([{ body: "flat, not pages" }]).run }) as { unreadable: string }).unreadable, /^row-claim: gh's response for issue #7's comments was not a list of pages -- refusing to guess\. Got: /);
});

test("(#2151) the claim's labels are ONE PUT of the whole set; nothing is added or removed one at a time", () => {
  const put = recording("");
  setRowLabels({ repo: REPO, number: 7, labels: ["in-progress", "session:worker-7", "started"], run: put.run });
  assert.deepEqual(put.asked, [["api", "--method", "PUT", `repos/${REPO}/issues/7/labels`, "-f", "labels[]=in-progress", "-f", "labels[]=session:worker-7", "-f", "labels[]=started"]]);
  assert.throws(() => setRowLabels({ repo: REPO, number: 7, labels: [], run: recording(new Error("HTTP 422")).run }), /HTTP 422/, "a write that was refused is thrown, never read as done");
});

test("(#2746) an edit of a row's labels removes and adds in ONE `issue edit`, in the tracker's repository, removals first; the back-off is the same edit with nothing to add", () => {
  const edit = recording("");
  editRowLabels({ repo: REPO, number: 7, remove: ["in-progress", "session:a"], add: ["blocked"], run: edit.run });
  editRowLabels({ repo: REPO, number: 7, remove: ["session:a", "started"], add: [], run: edit.run });
  assert.deepEqual(edit.asked, [
    ["issue", "edit", "7", "--repo", REPO, "--remove-label", "in-progress", "--remove-label", "session:a", "--add-label", "blocked"],
    ["issue", "edit", "7", "--repo", REPO, "--remove-label", "session:a", "--remove-label", "started"],
  ]);
  assert.throws(() => editRowLabels({ repo: REPO, number: 7, remove: [], add: ["x"], run: recording(new Error("label not found")).run }), /label not found/);
});

test("#1406: the REST answer recorded for #55 (2026-09-13T20:21:41Z, byte for byte) reads as a closed row with no labels", () => {
  const recorded = "{\"labels\":[],\"number\":55,\"state\":\"closed\",\"title\":\"A row can be claimed twice, because the collision check reads diffs and a claim does not live in a diff\"}\n";
  const { run, asked } = recording(recorded);
  assert.deepEqual(readRestRow({ repo: "a11ign/a11ign", number: 55, run }), { row: { number: 55, title: "A row can be claimed twice, because the collision check reads diffs and a claim does not live in a diff", labels: [], state: "CLOSED" } });
  assert.deepEqual(asked, [["api", "repos/a11ign/a11ign/issues/55"]], "the argv the live call used, so the recording answers the real question");
});
