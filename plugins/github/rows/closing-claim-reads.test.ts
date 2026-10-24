// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE ARGUMENTS AND READINGS OF THE OPERATIONS THE CHECKS ON A ROW'S CLAIM ASK -- the open claimed rows with their newest comments and a pull request's head (`closes-mismatch-check.ts`), one file of a consumer's
 * repository (the same file's `lookupConsumerFile`) and a row's comments (`sweep-window.ts`) -- which core's tests of those callers used to assert over a stubbed `gh` and which are the plugin's now (core's tests run on the
 * fake code host's rows). The argument lists are copied from the callers they were moved from, as they stood in `src/closes-mismatch-check.ts` and `src/sweep-window.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedRowsWithComments, commentsOfRowIn, consumerFileTextOf, headBranchAndForkOf } from "./closing-rows.ts";

/** A `run` that records the argument list it was given and answers `answer`. */
const recording = (answer: string) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer; } };
};
const refusing = (args: string[]): string => { throw new Error(`HTTP 502 for ${args[0]}`); };

const CLAIMED_QUERY = "query($owner:String!,$name:String!,$label:String!,$count:Int!,$window:Int!){"
  + "repository(owner:$owner,name:$name){issues(states:OPEN,labels:[$label],first:$count){totalCount nodes{number "
  + "comments(last:$window){totalCount nodes{body createdAt author{login}}}}}}}";

test("the open claimed rows are ONE GraphQL query of the owner, name, label, page size and comment window, and each row carries its newest comments and how many it has in all", () => {
  const comment = { body: "<!-- claim -->", createdAt: "2026-10-10T09:00:00Z", author: { login: "a11ign-ai-workers" } };
  const answer = { data: { repository: { issues: { totalCount: 3, nodes: [
    { number: 4770, comments: { totalCount: 1, nodes: [comment] } },
    { number: 4800, comments: { totalCount: 250, nodes: [comment, comment] } },
  ] } } } };
  const { seen, run } = recording(JSON.stringify(answer));
  const page = claimedRowsWithComments({ repo: "a11ign/a11ign", label: "in-progress", count: 100, window: 100, run });
  assert.deepEqual(seen, [["api", "graphql", "-f", `query=${CLAIMED_QUERY}`, "-F", "owner=a11ign", "-F", "name=a11ign", "-F", "label=in-progress", "-F", "count=100", "-F", "window=100"]]);
  assert.deepEqual(page, { total: 3, rows: [{ number: 4770, comments: [comment], commentsTotal: 1 }, { number: 4800, comments: [comment, comment], commentsTotal: 250 }] },
    "the total is the repository's, not the page's: a total beyond the page is a page that is not the population, and the caller reads that");
});

test("the open claimed rows: a refused read, an answer that is not JSON and one that is not the query's shape all THROW, never an empty page", () => {
  assert.throws(() => claimedRowsWithComments({ repo: "o/r", label: "x", count: 1, window: 1, run: refusing }), /HTTP 502/);
  assert.throws(() => claimedRowsWithComments({ repo: "o/r", label: "x", count: 1, window: 1, run: () => "not json" }));
  assert.throws(() => claimedRowsWithComments({ repo: "o/r", label: "x", count: 1, window: 1, run: () => JSON.stringify({ data: { repository: null } }) }));
  assert.deepEqual(claimedRowsWithComments({ repo: "o/r", label: "x", count: 1, window: 1, run: () => JSON.stringify({ data: { repository: { issues: { totalCount: 0, nodes: [] } } } }) }), { total: 0, rows: [] },
    "CONTROL: a read that worked and found no claimed row is the empty page");
});

test("a pull request's head is read by REST (the core pool): its branch, and whether its repository is not the base's", () => {
  const pull = (headRepo: string | null) => JSON.stringify({ head: { ref: "agent/x-1", repo: headRepo === null ? null : { full_name: headRepo } }, base: { repo: { full_name: "a11ign/a11ign" } } });
  const own = recording(pull("a11ign/a11ign"));
  assert.deepEqual(headBranchAndForkOf({ repo: "a11ign/a11ign", number: 2810, run: own.run }), { branch: "agent/x-1", fork: false });
  assert.deepEqual(own.seen, [["api", "repos/a11ign/a11ign/pulls/2810"]]);
  assert.deepEqual(headBranchAndForkOf({ repo: "a11ign/a11ign", number: 1, run: () => pull("someone/fork") }), { branch: "agent/x-1", fork: true });
  assert.deepEqual(headBranchAndForkOf({ repo: "a11ign/a11ign", number: 1, run: () => pull(null) }), { branch: "agent/x-1", fork: true }, "a head whose repository was deleted is not the base's");
});

test("a pull request's head: a refused read, a head with no branch name and an answer that is not JSON THROW, never a branch", () => {
  assert.throws(() => headBranchAndForkOf({ repo: "o/r", number: 1, run: refusing }), /HTTP 502/);
  assert.throws(() => headBranchAndForkOf({ repo: "o/r", number: 1, run: () => JSON.stringify({ head: { ref: "" }, base: { repo: { full_name: "o/r" } } }) }), /the PR names no head branch/);
  assert.throws(() => headBranchAndForkOf({ repo: "o/r", number: 1, run: () => JSON.stringify({ head: {}, base: { repo: { full_name: "o/r" } } }) }), /the PR names no head branch/);
  assert.throws(() => headBranchAndForkOf({ repo: "o/r", number: 1, run: () => "not json" }));
});

test("agent-org#873/#839: one file of a consumer's repository is read RAW, from the default branch with no ref and from the commit with one", () => {
  const head = recording('{"a":1}');
  assert.equal(consumerFileTextOf({ repo: "o/consumer", path: "config/routing.json", run: head.run }), '{"a":1}');
  assert.deepEqual(head.seen, [["api", "repos/o/consumer/contents/config/routing.json", "-H", "Accept: application/vnd.github.raw"]]);
  const at = recording("{}");
  consumerFileTextOf({ repo: "o/consumer", path: "config/routing.json", ref: "a".repeat(40), run: at.run });
  assert.deepEqual(at.seen, [["api", `repos/o/consumer/contents/config/routing.json?ref=${"a".repeat(40)}`, "-H", "Accept: application/vnd.github.raw"]]);
  assert.throws(() => consumerFileTextOf({ repo: "o/consumer", path: "absent.json", run: refusing }), /HTTP 502/, "a file that cannot be read THROWS: could not read is never read-and-empty");
});

test("a row's comments are read in its repository, oldest first as GitHub lists them; a row with none answers none, and a refused read throws", () => {
  const comments = [{ body: "<!-- row-claim: claim record -->", createdAt: "2026-10-10T09:00:00Z", author: { login: "a11ign-ai-workers" } }];
  const { seen, run } = recording(JSON.stringify({ comments }));
  assert.deepEqual(commentsOfRowIn({ repo: "a11ign/a11ign", number: 4389, run }), comments);
  assert.deepEqual(seen, [["issue", "view", "4389", "--repo", "a11ign/a11ign", "--json", "comments"]]);
  assert.deepEqual(commentsOfRowIn({ repo: "o/r", number: 1, run: () => JSON.stringify({}) }), [], "an answer that carries no comments is a row with none, as it always was");
  assert.throws(() => commentsOfRowIn({ repo: "o/r", number: 1, run: refusing }), /HTTP 502/);
  assert.throws(() => commentsOfRowIn({ repo: "o/r", number: 1, run: () => "not json" }));
});
