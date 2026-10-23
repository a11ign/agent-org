// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * agent-org#1278 (A11-160, step 5): THE READ AND THE WRITES BEHIND DISARMING A RED LEG'S PULL REQUEST, what `arm-pr` asks of GitHub when a `cross-repo-red` verdict refuses a pull request. The DECISION (which state is
 * disarmed, which is stuck, what the comment's first line says) is core's and its tests run on the fake code host (`cross-repo-red-disarms.test.ts`); the arguments each operation sends and the answers it refuses are here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { disableAutoMergeOf, readDisarmSeat } from "./auto-merge-disarm.ts";
import { dequeuePullRequestOf } from "./queue-entry-reads.ts";

const REPO = "a11ign/lab";

function recording(answer: unknown | Error) {
  const asked: string[][] = [];
  const run = (args: string[]): string => {
    asked.push(args);
    if (answer instanceof Error) throw answer;
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };
  return { run, asked };
}

test("#1278: the seat is one GraphQL read: the node id, whether it merged, whether auto-merge is on, and whether it sits in the merge queue", () => {
  const seat = (over: object) => ({ id: "PR_kwDOlab81", merged: false, autoMergeRequest: null, mergeQueueEntry: null, ...over });
  const armed = recording(seat({ autoMergeRequest: { enabledAt: "2026-10-13T10:00:00Z" } }));
  assert.deepEqual(readDisarmSeat({ number: "81", repo: REPO, run: armed.run }), { id: "PR_kwDOlab81", merged: false, armed: true, queued: false });
  assert.ok(armed.asked[0]!.includes("o=a11ign") && armed.asked[0]!.includes("r=lab") && armed.asked[0]!.includes("n=81"), armed.asked[0]!.join(" "));
  assert.match(armed.asked[0]!.find((arg) => arg.startsWith("query="))!, /pullRequest\(number:\$n\)\{id merged autoMergeRequest\{enabledAt\} mergeQueueEntry\{state\}\}/);
  assert.deepEqual(readDisarmSeat({ number: "81", repo: REPO, run: recording(seat({ mergeQueueEntry: { state: "QUEUED" }, autoMergeRequest: { enabledAt: "t" } })).run }), { id: "PR_kwDOlab81", merged: false, armed: true, queued: true });
  assert.deepEqual(readDisarmSeat({ number: "81", repo: REPO, run: recording(seat({ merged: true })).run }), { id: "PR_kwDOlab81", merged: true, armed: false, queued: false });
});

test("#1278: an answer that is not a seat THROWS -- 'unread' must not look like 'disarmed' -- and so does a refused read", () => {
  for (const answer of ["null", "{}", JSON.stringify({ id: "x" }), JSON.stringify({ id: 4, merged: false })]) {
    assert.throws(() => readDisarmSeat({ number: "81", repo: REPO, run: recording(answer).run }), /no pull request/, answer);
  }
  assert.throws(() => readDisarmSeat({ number: "81", repo: REPO, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("#1278: the disarm is `--disable-auto` aimed at the repository, and its exit is not the evidence: a refused write THROWS and a write that exits well is read back by the caller", () => {
  const write = recording("");
  disableAutoMergeOf({ number: "81", repo: REPO, run: write.run });
  assert.deepEqual(write.asked, [["pr", "merge", "81", "--repo", REPO, "--disable-auto"]]);
  assert.throws(() => disableAutoMergeOf({ number: "81", repo: REPO, run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
});

test("#1278: the dequeue removes a pull request from the merge queue by its node id, and an answer with `errors` THROWS even when gh printed it as a success", () => {
  const ok = recording({ data: { dequeuePullRequest: { mergeQueueEntry: null } } });
  dequeuePullRequestOf({ pullId: "PR_kwDOlab81", run: ok.run });
  assert.deepEqual(ok.asked[0]!.slice(0, 2), ["api", "graphql"]);
  assert.ok(ok.asked[0]!.includes("id=PR_kwDOlab81"));
  assert.match(ok.asked[0]!.find((arg) => arg.startsWith("query="))!, /dequeuePullRequest\(input:\{id:\$id\}\)/);
  assert.throws(() => dequeuePullRequestOf({ pullId: "PR_kwDOlab81", run: recording({ errors: [{ message: "the pull request is not in the queue" }] }).run }), /the dequeue was refused: the pull request is not in the queue/);
  assert.throws(() => dequeuePullRequestOf({ pullId: "PR_kwDOlab81", run: recording("not json").run }));
});
