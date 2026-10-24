// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9, part B): THE ARGUMENTS AND READINGS OF THE DAILY APPROVED-UNQUEUED READING'S OPERATIONS (agent-org#893), which `src/approved-unqueued.test.ts` used to assert by answering a fake `gh` and are the plugin's
 * now (that test runs on the fake code host's rows). Each case copies the argument list from the base code, so a changed command fails, and feeds the REAL operation the shape GitHub answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editComment, keyedCommentsOf, mergedWindowOf, openPullsOf, postRowComment, reviewsOf } from "./approved-unqueued-reads.ts";
import { recording } from "./recording-run.test.support.ts";

const MARKER = "<!-- approved-unqueued: ";

test("the keyed comments are one paginated read, filtered by `jq` to the comments that start with the marker, each parsed from one JSON line", () => {
  const gh = recording('{"id":5,"body":"<!-- approved-unqueued: 2026-10-10 count=2 -->\\nA"}\n{"id":6,"body":"<!-- approved-unqueued: 2026-10-11 count=0 -->\\nB"}\n');
  const found = keyedCommentsOf({ repo: "o/home", row: 928, marker: MARKER, since: "2026-10-09T00:00:00Z", run: gh.run });
  assert.deepEqual(gh.asked, [["api", "--paginate", "repos/o/home/issues/928/comments?per_page=100&since=2026-10-09T00:00:00Z", "--jq", `.[] | select(.body | startswith("${MARKER}")) | {id, body} | @json`]]);
  assert.deepEqual(found.map(({ id }) => id), [5, 6]);
  assert.equal(found[0].body, "<!-- approved-unqueued: 2026-10-10 count=2 -->\nA");
  assert.deepEqual(keyedCommentsOf({ repo: "o/home", row: 928, marker: MARKER, since: "2026-10-09T00:00:00Z", run: recording("\n").run }), [], "nothing printed is no keyed comment");
  assert.throws(() => keyedCommentsOf({ repo: "o/home", row: 928, marker: MARKER, since: "2026-10-09T00:00:00Z", run: recording(new Error("HTTP 502")).run }), /HTTP 502/, "a refused read throws: the caller decides what an unread answer is");
});

test("the day's comment is posted with `issue comment` on the row of the repository, and any comment (the day's, the tick's heartbeat, a tracker comment) is edited with a PATCH of its own id", () => {
  const post = recording("https://github.com/o/home/issues/928#issuecomment-1\n");
  postRowComment({ repo: "o/home", row: 928, body: "the day", run: post.run });
  assert.deepEqual(post.asked, [["issue", "comment", "928", "--repo", "o/home", "--body", "the day"]]);
  const edit = recording("{}");
  editComment({ repo: "o/home", id: 5, body: "the day, edited", run: edit.run });
  assert.deepEqual(edit.asked, [["api", "-X", "PATCH", "repos/o/home/issues/comments/5", "-f", "body=the day, edited"]]);
  // The same PATCH is the tick's standing heartbeat comment (`work-tick.ts`) and a tracker comment's replacement (`tracker-comment.ts`): one operation, so one argument list.
  const heartbeat = recording("");
  editComment({ repo: "a11ign/a11ign", id: 6026375754, body: "<!-- gate-heartbeat -->\n1 x\n", run: heartbeat.run });
  assert.deepEqual(heartbeat.asked, [["api", "-X", "PATCH", "repos/a11ign/a11ign/issues/comments/6026375754", "-f", "body=<!-- gate-heartbeat -->\n1 x\n"]]);
  const corrected = recording("");
  editComment({ repo: "a11ign/a11ign", id: 42, body: "the corrected text", run: corrected.run });
  assert.deepEqual(corrected.asked, [["api", "-X", "PATCH", "repos/a11ign/a11ign/issues/comments/42", "-f", "body=the corrected text"]]);
  assert.throws(() => editComment({ repo: "o/home", id: 5, body: "x", run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
});

test("the reviews of a pull request are one paginated, slurped read; the pages are flattened, and an answer that is not a list is thrown", () => {
  const gh = recording([[{ state: "COMMENTED", submitted_at: "2026-10-11T10:00:00Z" }], [{ state: "APPROVED", submitted_at: "2026-10-11T11:20:00Z" }]]);
  assert.deepEqual(reviewsOf({ repo: "o/home", number: 7, run: gh.run }).map((review) => review.state), ["COMMENTED", "APPROVED"]);
  assert.deepEqual(gh.asked, [["api", "--paginate", "--slurp", "repos/o/home/pulls/7/reviews"]]);
  assert.deepEqual(reviewsOf({ repo: "o/home", number: 7, run: recording([{ state: "APPROVED", submitted_at: "2026-10-11T11:20:00Z" }]).run }).map((review) => review.state), ["APPROVED"], "a list that is not paged is as good");
  assert.throws(() => reviewsOf({ repo: "o/home", number: 7, run: recording({ message: "Not Found" }).run }), /not a list/);
});

test("the merged window is ONE GraphQL read of the most recently updated merged pull requests, with the reviews and queue entries `jq` projects", () => {
  const nodes = [{ number: 1, mergedAt: "2026-10-11T08:56:00Z", reviews: [{ state: "APPROVED", submittedAt: "2026-10-11T08:40:00Z" }], queuedAt: ["2026-10-11T08:43:00Z"] }];
  const gh = recording(nodes);
  assert.deepEqual(mergedWindowOf({ repo: "o/home", window: 60, run: gh.run }), nodes);
  assert.deepEqual(gh.asked, [["api", "graphql", "-f",
    "query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequests(states:MERGED,first:$n,orderBy:{field:UPDATED_AT,direction:DESC})"
      + "{nodes{number mergedAt reviews(first:50){nodes{state submittedAt}} timelineItems(first:5,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT]){nodes{... on AddedToMergeQueueEvent{createdAt}}}}}}}",
    "-f", "o=o", "-f", "r=home", "-F", "n=60", "--jq", ".data.repository.pullRequests.nodes | map({number, mergedAt, reviews: .reviews.nodes, queuedAt: [.timelineItems.nodes[].createdAt]})"]]);
  assert.throws(() => mergedWindowOf({ repo: "o/home", window: 60, run: recording(new Error("gate-budget: refused `gh api graphql` at 53/60 points")).run }), /gate-budget: refused/, "a refused read throws and is never an empty window");
});

test("the manual run's open pull requests are one `pr list` of the fields the caller names", () => {
  const gh = recording([{ number: 7 }]);
  assert.deepEqual(openPullsOf({ repo: "o/home", fields: "number,title,reviews", run: gh.run }), [{ number: 7 }]);
  assert.deepEqual(gh.asked, [["pr", "list", "--repo", "o/home", "--state", "open", "--limit", "100", "--json", "number,title,reviews"]]);
});
