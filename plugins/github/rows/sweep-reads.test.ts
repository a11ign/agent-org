// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 5): THE GITHUB READS BEHIND THE AUTO-ARM SWEEP. What the sweep DECIDES (which candidates, whether a hold or a refusal stands, the exit codes) is core's and its tests run on the fake
 * code host; what it ASKS OF GITHUB is here. Moved from `auto-arm-sweep-parity.test.ts`, `outside-arm.test.ts` and `outside-arm-refusals.test.ts`, whose `run` stubs answered these reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isArmedPull, isCrossRepositoryPull, isMergedPull, openPullRequestsQueryArgs, readOpenPullNodes, readOutsideArmListed, readSweepFacts } from "./sweep-reads.ts";
import { recording } from "./recording-run.test.support.ts";

const REPO = "a11ign/agent-org";

test("#2004: the candidate read is one GraphQL list of the open pull requests against main, 100 at most, with every field the armed rule decides on", () => {
  const args = openPullRequestsQueryArgs(REPO);
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("o=a11ign") && args.includes("r=agent-org") && args.includes("b=main") && args.includes("limit=100"), args.join(" "));
  assert.match(args.find((arg) => arg.startsWith("query="))!, /states:OPEN,baseRefName:\$b,first:\$limit\)\{nodes\{number isDraft merged autoMergeRequest\{enabledAt\} mergeQueueEntry\{state\}\}\}/,
    "dropping mergeQueueEntry makes the rule answer false for every pull request in the queue (#2004)");
  assert.deepEqual(args.slice(-2), ["--jq", ".data.repository.pullRequests.nodes"]);
});

test("the candidates are read through the run the caller hands, and a refused or unparseable read THROWS", () => {
  const read = recording([{ number: 4, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: null }]);
  assert.deepEqual(readOpenPullNodes({ repo: REPO, run: read.run }), [{ number: 4, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: null }]);
  assert.deepEqual(read.asked, [openPullRequestsQueryArgs(REPO)]);
  assert.throws(() => readOpenPullNodes({ repo: REPO, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  assert.throws(() => readOpenPullNodes({ repo: REPO, run: recording("<html>").run }));
});

test("#1306: whether a pull request merged is one REST read of `merged`, true only for the literal true; and whether it is armed is the armed rule over one GraphQL read", () => {
  const merged = recording({ merged: true });
  assert.equal(isMergedPull({ repo: REPO, number: "7", run: merged.run }), true);
  assert.deepEqual(merged.asked, [["api", `repos/${REPO}/pulls/7`, "--jq", "{merged: .merged}"]]);
  for (const answer of [{ merged: false }, { merged: "true" }, {}, null]) assert.equal(isMergedPull({ repo: REPO, number: "7", run: recording(answer).run }), false, JSON.stringify(answer));
  assert.throws(() => isMergedPull({ repo: REPO, number: "7", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);

  assert.equal(isArmedPull({ repo: REPO, number: "7", run: recording({ merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "QUEUED" } }).run }), true, "a pull request in the merge queue is armed (#1729)");
  assert.equal(isArmedPull({ repo: REPO, number: "7", run: recording({ merged: false, autoMergeRequest: null, mergeQueueEntry: null }).run }), false);
  assert.throws(() => isArmedPull({ repo: REPO, number: "7", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("a candidate's facts are five reads in order: labels, author, body, head, and the head's check-run count; each text is trimmed", () => {
  const answers: Record<string, string> = { labels: JSON.stringify(["ready", "session:a"]), author: "worker-1\n", body: "Closes #5\n", headRefOid: "11aa53a\n" };
  const { run, asked } = recording((args: string[]) => (args[0] === "api" ? "9\n" : answers[args[args.indexOf("--json") + 1]!]));
  assert.deepEqual(readSweepFacts({ repo: REPO, number: "3460", run }), { labels: ["ready", "session:a"], author: "worker-1", prBody: "Closes #5", head: "11aa53a", checkRunCount: 9 });
  assert.deepEqual(asked, [
    ["pr", "view", "3460", "--repo", REPO, "--json", "labels", "-q", "[.labels[].name]"],
    ["pr", "view", "3460", "--repo", REPO, "--json", "author", "-q", ".author.login"],
    ["pr", "view", "3460", "--repo", REPO, "--json", "body", "-q", ".body"],
    ["pr", "view", "3460", "--repo", REPO, "--json", "headRefOid", "-q", ".headRefOid"],
    ["api", `repos/${REPO}/commits/11aa53a/check-runs`, "--jq", ".total_count"],
  ]);
});

test("a candidate that cannot be read whole THROWS, whichever of the five reads was refused", () => {
  for (const refused of ["labels", "author", "body", "headRefOid", "check-runs"]) {
    const run = (args: string[]): string => {
      if (args.join(" ").includes(refused)) throw new Error(`HTTP 502 on ${refused}`);
      return args[0] === "api" ? "1" : args.includes("labels") ? "[]" : "x";
    };
    assert.throws(() => readSweepFacts({ repo: REPO, number: "3460", run }), new RegExp(`HTTP 502 on ${refused}`), refused);
  }
});

test("#1573: whether the head is in a fork is true, false or null, and only a boolean is a reading", () => {
  const view = recording({ isCrossRepository: false });
  assert.equal(isCrossRepositoryPull({ repo: REPO, number: "7", run: view.run }), false);
  assert.deepEqual(view.asked, [["pr", "view", "7", "--repo", REPO, "--json", "isCrossRepository"]]);
  assert.equal(isCrossRepositoryPull({ repo: REPO, number: "7", run: recording({ isCrossRepository: true }).run }), true);
  assert.equal(isCrossRepositoryPull({ repo: REPO, number: "7", run: recording({}).run }), null, "an answer with no field is unread, which a caller treats as a fork");
  assert.equal(isCrossRepositoryPull({ repo: REPO, number: "7", run: recording(new Error("HTTP 502")).run }), null, "a refused read is unread");
});

test("#1573: the outside home's list is `pr list` of the open pull requests with the policy fields, at most the limit", () => {
  const list = recording([{ number: 1 }]);
  assert.deepEqual(readOutsideArmListed({ repo: REPO, limit: 100, run: list.run }), [{ number: 1 }]);
  assert.deepEqual(list.asked, [["pr", "list", "--repo", REPO, "--state", "open", "--limit", "100", "--json", "number,state,isDraft,baseRefName,isCrossRepository,reviewDecision,labels"]]);
  assert.throws(() => readOutsideArmListed({ repo: REPO, limit: 100, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});
