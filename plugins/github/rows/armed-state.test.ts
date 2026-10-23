// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 5): WHAT THE GITHUB PLUGIN KNOWS OF WHETHER A PULL REQUEST IS ARMED, and of the merge queue's history of it. Moved from `arm-refuses-an-ejected-pr.test.ts` (#3487), which asked the
 * same questions of `arm-pr`'s and the sweep's own reads; those doors' tests are core's and run on the fake code host.
 *
 * THE FIXTURE IS #3460's REAL TIMELINE, `EJECTED_3460`: the last ten nodes of its `EJECTION_QUERY` window, as the Open-check on the row read them. The controls change ONE thing each, so the
 * ejection cannot be read by never being reached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { armedFromApi, armedNodeOf, armedQueryArgs, armedReason, ejectionQueryArgs, queueEjectionOf, readQueueEjection } from "./armed-state.ts";

const COMMIT = { __typename: "PullRequestCommit" };
const added = (createdAt: string) => ({ __typename: "AddedToMergeQueueEvent", createdAt });
const removed = (createdAt: string, reason = "failed_checks") => ({ __typename: "RemovedFromMergeQueueEvent", createdAt, reason });

/** #3460's timeline, oldest first: two commits, then four ADDED / REMOVED `failed_checks` pairs. Last removal 14:48:06Z. */
const TIMELINE_3460 = [COMMIT, COMMIT,
  added("2026-10-04T14:08:56Z"), removed("2026-10-04T14:20:02Z"),
  added("2026-10-04T14:20:19Z"), removed("2026-10-04T14:27:45Z"),
  added("2026-10-04T14:28:56Z"), removed("2026-10-04T14:36:27Z"),
  added("2026-10-04T14:40:24Z"), removed("2026-10-04T14:48:06Z")];
const LAST_REMOVAL = "2026-10-04T14:48:06Z";
const pullRequest = (nodes: unknown[]) => ({ mergeQueueEntry: null, timelineItems: { nodes } });
const EJECTED_3460 = pullRequest(TIMELINE_3460);

test("#2046: a pull request is armed when it merged, auto-merges or sits in the merge queue, and the reason names the most advanced state", () => {
  assert.equal(armedFromApi(null), false);
  assert.equal(armedFromApi({}), false, "nobody has armed a pull request that is none of the three");
  assert.equal(armedFromApi({ merged: true }), true);
  assert.equal(armedFromApi({ autoMergeRequest: { enabledAt: "2026-10-23T10:00:00Z" } }), true);
  assert.equal(armedFromApi({ mergeQueueEntry: { state: "AWAITING_CHECKS" } }), true, "#1762: a pull request at position 1 has left auto-merge and is armed (#1729)");
  assert.equal(armedReason({ merged: true, mergeQueueEntry: { state: "QUEUED" } }), "it is already merged", "most advanced first: a merged pull request that carries a stale entry reads as merged");
  assert.equal(armedReason({ mergeQueueEntry: { state: "QUEUED" }, autoMergeRequest: { enabledAt: "t" } }), "it is already queued to merge");
  assert.equal(armedReason({ autoMergeRequest: { enabledAt: "t" } }), "auto-merge is already enabled on it");
  assert.equal(armedReason({ merged: false, autoMergeRequest: null, mergeQueueEntry: null }), null);
});

test("the armed query is one GraphQL read of the pull request, aimed at its owner, name and number", () => {
  const args = armedQueryArgs({ number: 3460, repo: "a11ign/a11ign" });
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("o=a11ign") && args.includes("r=a11ign") && args.includes("n=3460"), args.join(" "));
  assert.match(args.find((arg) => arg.startsWith("query="))!, /merged autoMergeRequest\{enabledAt\} mergeQueueEntry\{state\}/, "all three states are asked for: dropping one makes the rule answer false for it (#2004)");
  assert.deepEqual(args.slice(-2), ["--jq", ".data.repository.pullRequest"]);
});

test("armedNodeOf reads the armed query's node through the run it is handed, and THROWS when the read is refused or is not JSON", () => {
  const asked: string[][] = [];
  const node = armedNodeOf({ number: "7", repo: "o/r", run: (args) => { asked.push(args); return JSON.stringify({ merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "QUEUED" } }); } });
  assert.deepEqual(asked, [armedQueryArgs({ number: "7", repo: "o/r" })]);
  assert.equal(armedFromApi(node), true);
  assert.throws(() => armedNodeOf({ number: "7", repo: "o/r", run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.throws(() => armedNodeOf({ number: "7", repo: "o/r", run: () => "<html>" }));
});

test("#3487 (1): #3460's real timeline reads EJECTED, and the time is the last removal's", () => {
  assert.deepEqual(queueEjectionOf(EJECTED_3460), { ejected: true, removedAt: LAST_REMOVAL });
  assert.deepEqual(readQueueEjection({ number: 3460, repo: "a11ign/a11ign", run: () => JSON.stringify(EJECTED_3460) }), { ejected: true, removedAt: LAST_REMOVAL });
});

/** Each control is #3460's fixture with ONE thing changed. */
const CONTROLS: Record<string, unknown> = {
  "(2) a PullRequestCommit AFTER the last removal": pullRequest([...TIMELINE_3460, COMMIT]),
  "(2) the queue events deleted": pullRequest([COMMIT, COMMIT]),
  "(3) the last removal is a person's dequeue, not failed_checks": pullRequest([...TIMELINE_3460.slice(0, -1), removed(LAST_REMOVAL, "manual")]),
  "it is IN the queue now, whatever the history says": { ...EJECTED_3460, mergeQueueEntry: { state: "QUEUED" } },
};

test("#3487 (2)(3) CONTROLS: a push since, no queue history, another reason and a live queue entry are all NOT ejected", () => {
  assert.ok(Object.keys(CONTROLS).length >= 4, "the controls exist, so the loop below cannot pass by being empty");
  for (const [name, fixture] of Object.entries(CONTROLS)) {
    assert.deepEqual(readQueueEjection({ number: 3460, repo: "a11ign/a11ign", run: () => JSON.stringify(fixture) }), { ejected: false, removedAt: null }, name);
  }
});

test("#3487 (4): an answer with no history is null, never 'not ejected'; a refused or unparseable read THROWS", () => {
  for (const answer of ["null", JSON.stringify({ mergeQueueEntry: null }), JSON.stringify({ timelineItems: {} }), JSON.stringify({ timelineItems: { nodes: "no" } })]) {
    assert.equal(readQueueEjection({ number: 3460, repo: "a11ign/a11ign", run: () => answer }), null, answer);
  }
  assert.throws(() => readQueueEjection({ number: 3460, repo: "a11ign/a11ign", run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.throws(() => readQueueEjection({ number: 3460, repo: "a11ign/a11ign", run: () => "not json" }));
});

test("the ejection query asks the last ten queue and push events of the pull request, and its arguments are armedQueryArgs' shape", () => {
  const args = ejectionQueryArgs({ number: 3460, repo: "a11ign/a11ign" });
  assert.match(args.find((arg) => arg.startsWith("query="))!, /timelineItems\(last:10,itemTypes:\[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT\]\)/);
  assert.deepEqual(args.filter((arg) => /^[orn]=/.test(arg)), ["o=a11ign", "r=a11ign", "n=3460"]);
});
