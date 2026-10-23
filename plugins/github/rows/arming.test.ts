// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 5): THE GITHUB READS AND WRITES BEHIND ARMING ONE PULL REQUEST. What `arm-pr` DECIDES is core's and its tests run on the fake code host; what it ASKS OF GITHUB, and how it reads the
 * answer, is here: the arguments each operation sends and the shapes of answer it refuses. Moved from `arm-refuses-open-blocker.test.ts` (#3544, #470), `arm-pr-row-repo.test.ts`, `arm-pr-labels-live.test.ts`
 * and `auto-arm-token.test.ts` (#1022, #2046, #2391), whose `run` stubs answered these reads for `arm-pr` itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addLabelsToPull, armedReasonOf, armMergeOf, armPullAuto, commentOnPull, dequeueByHandCommand, jumpToFront, labelsOfRow, openBlockersOf, openBlockersOfRow, pullStateOf, readPullComments, readPullForArming, readQueueSeat, settledReason, trunkRunsPage } from "./arming.ts";
import { recording } from "./recording-run.test.support.ts";

const REPO = "a11ign/a11ign";
const node = (number: number, state: string) => ({ number, state, title: `row ${number}`, url: `https://github.com/${REPO}/issues/${number}` });
const edges = (...nodes: ReturnType<typeof node>[]) => ({ blockedBy: { nodes, totalCount: nodes.length } });

// --- the blockers of a row ---

test("#3544: only an OPEN blocker counts; a node with no state is open, and an edge list that cannot be trusted whole is null, never 'no blockers'", () => {
  assert.deepEqual(openBlockersOf(edges(node(3509, "OPEN"), node(3414, "CLOSED"))), [3509], "#3422's real edge list: #3509 OPEN, #3414 CLOSED");
  assert.deepEqual(openBlockersOf(edges(node(3509, "CLOSED"), node(3414, "CLOSED"))), []);
  assert.deepEqual(openBlockersOf(edges()), []);
  assert.deepEqual(openBlockersOf({ blockedBy: { nodes: [{ number: 3509 }], totalCount: 1 } } as never), [3509], "no `state` reads as OPEN, as `waitingOn` reads it");
  const unreadable: Record<string, unknown> = {
    "no `blockedBy` key": { labels: [] },
    "no `nodes` array": { blockedBy: { totalCount: 1 } },
    "a `null` answer": null,
    "totalCount says a page was not read and none of the nodes read is open": { blockedBy: { nodes: [node(3414, "CLOSED")], totalCount: 2 } },
  };
  for (const [name, answer] of Object.entries(unreadable)) assert.equal(openBlockersOf(answer as never), null, name);
  assert.deepEqual(openBlockersOf({ blockedBy: { nodes: [node(3509, "OPEN")], totalCount: 2 } }), [3509], "an OPEN node already read is blocked however many pages there are");
});

test("#3544: a row's blocked-by edges are read in the repository the row lives in, and a refused or unparseable read THROWS", () => {
  const { run, asked } = recording(edges(node(3509, "OPEN")));
  assert.deepEqual(openBlockersOfRow({ repo: REPO, number: 3422, run }), [3509]);
  assert.deepEqual(asked, [["issue", "view", "3422", "--repo", REPO, "--json", "blockedBy"]]);
  assert.throws(() => openBlockersOfRow({ repo: REPO, number: 3422, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  assert.throws(() => openBlockersOfRow({ repo: REPO, number: 3422, run: recording("<html>").run }));
  assert.equal(openBlockersOfRow({ repo: REPO, number: 3422, run: recording({ blockedBy: { totalCount: 1 } }).run }), null, "an answer with no list is null, which the caller reads as 'could not ask'");
});

// --- labels and comments ---

test("arm-pr reads a row's labels in the row's own repository (#2995), and a pull request's labels, body, state and author in one read", () => {
  const labels = recording({ labels: [{ name: "session:a" }, { name: "ready" }] });
  assert.deepEqual(labelsOfRow({ repo: "a11ign/lab", number: 12, run: labels.run }), ["session:a", "ready"]);
  assert.deepEqual(labels.asked, [["issue", "view", "12", "--repo", "a11ign/lab", "--json", "labels"]]);
  assert.throws(() => labelsOfRow({ repo: REPO, number: 12, run: recording({}).run }), "an answer with no label list THROWS: a row with no labels read is not a row with none");

  const view = recording({ labels: [{ name: "hold:x" }], body: "Closes #1", state: "OPEN", author: { login: "worker-1" } });
  assert.deepEqual(readPullForArming({ repo: REPO, number: "3460", run: view.run }), { labels: ["hold:x"], body: "Closes #1", state: "OPEN", author: "worker-1" });
  assert.deepEqual(view.asked, [["pr", "view", "3460", "--repo", REPO, "--json", "labels,body,state,author"]]);
  assert.equal(readPullForArming({ repo: REPO, number: "1", run: recording({ labels: [], body: "b", state: 3 }).run }).state, null, "a state that is not text is unread");
  assert.throws(() => readPullForArming({ repo: REPO, number: "1", run: recording({ body: "b" }).run }), "no label list THROWS: unreadable is not unheld (#645)");
});

test("#3544: the comments already on a pull request are read for their bodies, a missing list THROWS, and a comment is posted with the marker in its body", () => {
  const comments = recording({ comments: [{ body: "<!-- arm-refused: open-blocker 3509 -->\nfirst" }, {}] });
  assert.deepEqual(readPullComments({ repo: REPO, number: 3507, run: comments.run }), [{ body: "<!-- arm-refused: open-blocker 3509 -->\nfirst" }, { body: "" }]);
  assert.deepEqual(comments.asked, [["pr", "view", "3507", "--repo", REPO, "--json", "comments"]]);
  assert.throws(() => readPullComments({ repo: REPO, number: 3507, run: recording({}).run }), /no comment list/);
  const posted = recording("");
  commentOnPull({ repo: REPO, number: 3507, body: "the words", run: posted.run });
  assert.deepEqual(posted.asked, [["pr", "comment", "3507", "--repo", REPO, "--body", "the words"]]);
});

test("session labels are added to the pull request one flag each, and a refused write THROWS", () => {
  const edit = recording("");
  addLabelsToPull({ repo: REPO, number: "9", labels: ["session:a", "session:b"], run: edit.run });
  assert.deepEqual(edit.asked, [["pr", "edit", "9", "--repo", REPO, "--add-label", "session:a", "--add-label", "session:b"]]);
  assert.throws(() => addLabelsToPull({ repo: REPO, number: "9", labels: ["x"], run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
});

// --- the state, and the arm ---

test("#1022: a pull request's state is OPEN, MERGED or CLOSED, text only; and MERGED and CLOSED are the states with nothing left to arm", () => {
  const view = recording({ state: "MERGED" });
  assert.equal(pullStateOf({ repo: REPO, number: "5", run: view.run }), "MERGED");
  assert.deepEqual(view.asked, [["pr", "view", "5", "--repo", REPO, "--json", "state"]]);
  assert.equal(pullStateOf({ repo: REPO, number: "5", run: recording({}).run }), null);
  assert.throws(() => pullStateOf({ repo: REPO, number: "5", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  assert.equal(settledReason("MERGED"), "it is already merged");
  assert.equal(settledReason("CLOSED"), "it is already closed");
  assert.equal(settledReason("OPEN"), null);
  assert.equal(settledReason(null), null, "an unreadable pull request must not resolve to 'nothing to do'");
});

test("#2046: the armed reason of a pull request in the merge queue is 'queued', and a refused read THROWS", () => {
  const queued = recording({ merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "AWAITING_CHECKS" } });
  assert.equal(armedReasonOf({ repo: REPO, number: "5", run: queued.run }), "it is already queued to merge");
  assert.equal(armedReasonOf({ repo: REPO, number: "5", run: recording({ merged: false, autoMergeRequest: null, mergeQueueEntry: null }).run }), null);
  assert.throws(() => armedReasonOf({ repo: REPO, number: "5", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("the arm is auto-merge with a merge commit, aimed at the repository, and its refusal THROWS", () => {
  const merge = recording("");
  armPullAuto({ repo: REPO, number: 7, run: merge.run });
  assert.deepEqual(merge.asked, [["pr", "merge", "--auto", "--merge", "7", "--repo", REPO]]);
  assert.throws(() => armPullAuto({ repo: REPO, number: 7, run: recording(new Error("GraphQL: Merge already in progress")).run }), /already in progress/);
});

/** `armMergeOf` over a table of what each command answers; `merge` answers the arm, `state` the state read, `armed` the armed query. */
function arming({ merge = "" as string | Error, state = { state: "OPEN" } as unknown | Error, armed = { merged: false, autoMergeRequest: null, mergeQueueEntry: null } as unknown | Error }) {
  const seen: string[] = [];
  const slept: number[] = [];
  const say: string[] = [];
  const run = (args: string[]): string => {
    const [first, second] = args;
    const given = first === "pr" && second === "merge" ? merge : first === "pr" && second === "view" ? state : armed;
    seen.push(`${first} ${second}`);
    if (given instanceof Error) throw given;
    return typeof given === "string" ? given : JSON.stringify(given);
  };
  const seams = { sleep: (ms: number) => { slept.push(ms); }, error: (line: string) => { say.push(line); } };
  return { run, seen, slept, say, seams };
}

test("#1022: an arm that took is armed, and nothing else is asked", () => {
  const { run, seen, seams } = arming({});
  assert.deepEqual(armMergeOf({ number: "7", repo: REPO, run }, seams), { armed: true, reason: "auto-merge enabled" });
  assert.deepEqual(seen, ["pr merge"]);
});

test("#1022: a refused arm on a pull request that merged meanwhile has nothing left to arm, and the poll ends at the first positive read", () => {
  const { run, seen, slept, seams } = arming({ merge: new Error("GraphQL: Merge already in progress"), state: { state: "MERGED" } });
  assert.deepEqual(armMergeOf({ number: "7", repo: REPO, run }, seams), { armed: false, reason: "it is already merged -- nothing was left to arm" });
  assert.deepEqual(seen, ["pr merge", "pr view"], "one state read, then it stops");
  assert.deepEqual(slept, [], "it does not wait before the first read");
});

test("#1022: a pull request that reads OPEN is asked again after the interval, up to the attempts, before the refusal is believed", () => {
  const { run, seen, slept, seams } = arming({ merge: new Error("boom"), state: { state: "OPEN" } });
  assert.throws(() => armMergeOf({ number: "7", repo: REPO, run }, { ...seams, attempts: 3, intervalMs: 50 }), /boom/);
  assert.deepEqual(seen, ["pr merge", "pr view", "pr view", "pr view", "api graphql"], "three state reads, then the armed read, then the refusal is thrown");
  assert.deepEqual(slept, [50, 50], "it waits between reads and not before the first");
});

test("#2046: a refusal on a pull request in the merge queue, which reads OPEN forever, is explained by the armed read and is not thrown", () => {
  const { run, seams } = arming({ merge: new Error("Auto merge is already enabled"), armed: { merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "AWAITING_CHECKS" } } });
  assert.deepEqual(armMergeOf({ number: "7", repo: REPO, run }, { ...seams, attempts: 1 }), { armed: false, reason: "it is already queued to merge -- nothing was left to arm" });
});

test("a refusal nothing explains is thrown unchanged, and the reads that failed on the way are said, not swallowed", () => {
  const { run, say, seams } = arming({ merge: new Error("not mergeable"), state: new Error("HTTP 502"), armed: new Error("HTTP 502") });
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => { logged.push(line); };
  try {
    assert.throws(() => armMergeOf({ number: "7", repo: REPO, run }, { ...seams, attempts: 2 }), /not mergeable/);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2, "each state read that failed is said");
  assert.match(logged[0]!, /arm-pr: could not read #7's state: .*HTTP 502/);
  assert.equal(say.length, 1);
  assert.match(say[0]!, /could not read whether #7 is already armed/);
});

// --- the trunk, the queue seat and the jump ---

test("#2391: the trunk's runs are read a page at a time from `main`, and a page with no list is an empty page", () => {
  const page = recording({ workflow_runs: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(trunkRunsPage({ repo: REPO, workflow: "ci.yml", page: 2, perPage: 100, run: page.run }), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(page.asked, [["api", `repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&per_page=100&page=2`]]);
  assert.deepEqual(trunkRunsPage({ repo: REPO, workflow: "ci.yml", page: 1, perPage: 100, run: recording({}).run }), []);
  assert.throws(() => trunkRunsPage({ repo: REPO, workflow: "ci.yml", page: 1, perPage: 100, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("#2391: the queue seat is one GraphQL read, a read that answers no pull request THROWS, and the jump sends the head it expects", () => {
  const seat = { id: "PR_1", headRefOid: "a".repeat(40), mergeStateStatus: "CLEAN", mergeQueueEntry: { position: 3, state: "QUEUED" } };
  const read = recording(seat);
  assert.deepEqual(readQueueSeat({ number: "9", repo: REPO, run: read.run }), seat);
  assert.deepEqual(read.asked[0]!.slice(0, 2), ["api", "graphql"]);
  assert.ok(read.asked[0]!.includes("o=a11ign") && read.asked[0]!.includes("r=a11ign") && read.asked[0]!.includes("n=9"));
  assert.match(read.asked[0]!.find((arg) => arg.startsWith("query="))!, /id headRefOid mergeStateStatus mergeQueueEntry\{position state jump\}/);
  for (const answer of ["null", "{}", JSON.stringify({ id: 4 })]) assert.throws(() => readQueueSeat({ number: "9", repo: REPO, run: recording(answer).run }), /no pull request/, answer);
  const jump = recording("{}");
  jumpToFront({ id: "PR_1", headOid: "b".repeat(40), run: jump.run });
  assert.match(jump.asked[0]!.find((arg) => arg.startsWith("query="))!, /enqueuePullRequest\(input:\{pullRequestId:\$id,jump:true,expectedHeadOid:\$oid\}\)/);
  assert.ok(jump.asked[0]!.includes("id=PR_1") && jump.asked[0]!.includes(`oid=${"b".repeat(40)}`));
  assert.throws(() => jumpToFront({ id: "PR_1", headOid: "b", run: recording(new Error("HTTP 422")).run }), /HTTP 422/);
});

test("#1278: the dequeue a person runs by hand names the pull request's node id", () => {
  assert.match(dequeueByHandCommand("PR_node_9"), /gh api graphql .*dequeuePullRequest.* -f id=PR_node_9$/);
});
