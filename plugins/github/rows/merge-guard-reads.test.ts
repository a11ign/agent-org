// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 5): THE GITHUB READS BEHIND THE MERGE GUARD AND THE MERGE QUEUE'S DISPATCHER. The RULES (what is red, what is stale, what an approval covers) are core's, pure, and tested there; what the
 * guard ASKS OF GITHUB, and how it reads the answer, is here. Moved from `merge-guard-lookups.test.ts`, `merge-guard.test.ts`, `merge-guard-checks-rule.test.ts` and `merge-queue.test.ts`, whose `gh`
 * stubs answered these reads for the guard itself. A read that could not be made THROWS here, and core's `lookup` turns the throw into `null`: "could not ask" is never an empty answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  behindByOf, checkRunsOfCommit, closingIssuesOf, compareWithMain, deleteBranchOf, mainTipDateOf, mergeQueuedPull, openPullsForQueue, openPullsOfBranch, pullForCiGate, pullForGuard,
  pullOutcomeOf, recentClosesPrsOf, requiredContextsOf,
} from "./merge-guard-reads.ts";
import { recording } from "./recording-run.test.support.ts";

const REPO = "a11ign/agent-org";
const HEAD = "d5c2436601abcdef";

const refused = (): never => { throw new Error("HTTP 502"); };

test("#2331: the required contexts are read from `branches/main`, and a protected branch that shows no list is null, never 'nothing is required'", () => {
  const read = recording({ protection: { required_status_checks: { contexts: ["gate", "ts"] } } });
  assert.deepEqual(requiredContextsOf({ repo: REPO, run: read.run }), ["gate", "ts"]);
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/branches/main`]]);
  for (const answer of [{ protected: true }, { protection: {} }, { protection: { required_status_checks: { contexts: "gate" } } }]) {
    assert.equal(requiredContextsOf({ repo: REPO, run: recording(answer).run }), null, JSON.stringify(answer));
  }
  assert.throws(() => requiredContextsOf({ repo: REPO, run: refused }), /HTTP 502/);
});

/** `branches/main` as measured 2026-09-24 for `a11ign-ai-workers`, which is not an admin. */
const PROTECTED_WITH_GATE = { name: "main", protected: true,
  protection: { enabled: true, required_status_checks: { contexts: ["gate"], enforcement_level: "everyone" } } };
/** Protected, but no list to read -- what a default would paper over. */
const PROTECTED_WITHOUT_LIST = { name: "main", protected: true, protection: { enabled: true } };

/** A `run` that plays a NON-ADMIN credential: every `branches/main/protection*` path is a 404, as GitHub answers `a11ign-ai-workers`, and `branches/main` answers `body`. It logs every request. */
function nonAdmin(body: object) {
  return recording((args: string[]) => {
    if (args[1]!.includes("branches/main/protection")) throw new Error("gh: Not Found (HTTP 404)");
    if (args[1]!.endsWith("branches/main")) return body;
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  });
}

test("#2331: the required checks are read with the ADMIN endpoint answering 404, and that endpoint is never asked for (moved from merge-guard-lookups.test.ts)", () => {
  const credential = nonAdmin(PROTECTED_WITH_GATE);
  assert.deepEqual(requiredContextsOf({ repo: REPO, run: credential.run }), ["gate"]);
  assert.ok(credential.asked.length > 0, "the read reached the run at all");
  assert.ok(credential.asked.every((args) => !args.join(" ").includes("branches/main/protection")), `no request may name the admin-only endpoint; saw ${JSON.stringify(credential.asked)}`);
});

test("#2331 control: a protected branch showing no list is null, not a default (moved from merge-guard-lookups.test.ts)", () => {
  assert.equal(requiredContextsOf({ repo: REPO, run: nonAdmin(PROTECTED_WITHOUT_LIST).run }), null, "without this, the test above is satisfied by a read that returns [\"gate\"] unconditionally");
});

test("#902: a commit's check runs are read whole, with their ids, and named in the guard's own fields", () => {
  const read = recording({ check_runs: [{ id: 5, name: "gate", status: "completed", conclusion: "success", completed_at: "2026-09-07T00:45:35Z" }, { id: 6, name: "ts", status: "in_progress", conclusion: null, completed_at: null }] });
  assert.deepEqual(checkRunsOfCommit({ repo: REPO, sha: HEAD, run: read.run }), [
    { id: 5, name: "gate", status: "completed", conclusion: "success", completedAt: "2026-09-07T00:45:35Z" },
    { id: 6, name: "ts", status: "in_progress", conclusion: null, completedAt: null },
  ]);
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/commits/${HEAD}/check-runs`, "--paginate"]]);
  assert.throws(() => checkRunsOfCommit({ repo: REPO, sha: HEAD, run: recording({}).run }), "an answer with no `check_runs` list THROWS: nothing ran is a finding, an unread list is not");
  assert.throws(() => checkRunsOfCommit({ repo: REPO, sha: HEAD, run: refused }), /HTTP 502/);
});

test("the tip of main and how far a head is behind it: a date, a number, or null for an answer that carries neither", () => {
  const tip = recording("2026-09-07T00:41:07Z\n");
  assert.equal(mainTipDateOf({ repo: REPO, run: tip.run }), "2026-09-07T00:41:07Z");
  assert.deepEqual(tip.asked, [["api", `repos/${REPO}/commits/main`, "--jq", ".commit.committer.date"]]);
  assert.equal(mainTipDateOf({ repo: REPO, run: recording("\n").run }), null);
  const compare = recording({ behind_by: 3 });
  assert.equal(behindByOf({ repo: REPO, head: HEAD, run: compare.run }), 3);
  assert.deepEqual(compare.asked, [["api", `repos/${REPO}/compare/main...${HEAD}`]], "oriented main...head, so behind_by is how far the head is behind main (#294)");
  assert.equal(behindByOf({ repo: REPO, head: HEAD, run: recording({}).run }), null);
  assert.equal(behindByOf({ repo: REPO, head: HEAD, run: recording({ behind_by: "3" }).run }), null, "a count that is not a number is unread");
  assert.throws(() => behindByOf({ repo: REPO, head: HEAD, run: refused }), /HTTP 502/);
});

test("#249/#2995: the rows a pull request closes are resolved by GitHub, each with its repository and labels", () => {
  const read = recording({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [
    { number: 12, title: "a row", repository: { nameWithOwner: "a11ign/lab" }, labels: { nodes: [{ name: "in-progress" }, { name: "session:a" }] } },
    { number: 13, title: "other", labels: { nodes: [] } },
  ] } } } } });
  assert.deepEqual(closingIssuesOf({ repo: REPO, number: 148, run: read.run }), [
    { number: 12, repo: "a11ign/lab", title: "a row", labels: ["in-progress", "session:a"] },
    { number: 13, repo: undefined, title: "other", labels: [] },
  ]);
  assert.ok(read.asked[0]!.includes("owner=a11ign") && read.asked[0]!.includes("name=agent-org") && read.asked[0]!.includes("number=148"), read.asked[0]!.join(" "));
  assert.match(read.asked[0]!.find((arg) => arg.startsWith("query="))!, /closingIssuesReferences\(first:20\)/);
  assert.throws(() => closingIssuesOf({ repo: REPO, number: 148, run: recording({ data: { repository: { pullRequest: null } } }).run }), "a pull request GitHub did not return THROWS: no answer is not 'closes nothing'");
});

test("#2810: the newest thirty open and merged pull requests are read with their bodies and the rows GitHub resolved", () => {
  const read = recording({ data: { repository: { pullRequests: { nodes: [{ number: 9, body: null, closingIssuesReferences: { nodes: [{ number: 4 }] } }, { number: 8, body: "Closes #3", closingIssuesReferences: { nodes: [] } }] } } } });
  assert.deepEqual(recentClosesPrsOf({ repo: REPO, run: read.run }), [{ number: 9, body: "", resolved: [4] }, { number: 8, body: "Closes #3", resolved: [] }]);
  assert.ok(read.asked[0]!.includes("count=30"));
  assert.match(read.asked[0]!.find((arg) => arg.startsWith("query="))!, /pullRequests\(states:\[OPEN,MERGED\],first:\$count,orderBy:\{field:CREATED_AT,direction:DESC\}\)/, "#2830: OPEN and MERGED pull requests, newest first by creation, so one open pre-outage PR cannot veto the pass");
  assert.throws(() => recentClosesPrsOf({ repo: REPO, run: refused }), /HTTP 502/);
});

test("#455: the pull request as the readiness check reads it: GraphQL's state word, labels that are strings, the body and the author", () => {
  const read = recording({ number: 148, state: "OPEN", baseRefName: "main", headRefOid: HEAD, headRefName: "feature/x", labels: [{ name: "ready" }, { name: 7 }, {}], body: "Closes #1", author: { login: "worker-1" } });
  assert.deepEqual(pullForGuard({ repo: REPO, number: 148, run: read.run }), {
    pr: { number: 148, state: "OPEN", baseRefName: "main", headRefOid: HEAD, headRefName: "feature/x" }, prLabels: ["ready"], body: "Closes #1", author: "worker-1",
  });
  assert.deepEqual(read.asked, [["pr", "view", "148", "--repo", REPO, "--json", "number,state,baseRefName,headRefOid,headRefName,labels,body,author"]]);
  const bare = pullForGuard({ repo: REPO, number: 148, run: recording({ number: 148, state: "OPEN", baseRefName: "main", headRefOid: HEAD, headRefName: "b" }).run });
  assert.deepEqual([bare.prLabels, bare.body, bare.author], [null, "", null], "an answer with no label list is null: nobody looked, which is not 'unheld'");
});

test("#298: the CI gate reads the REST pull, where the state is lowercase and a label list with a name that is not text is no list at all", () => {
  const read = recording({ number: 148, state: "open", base: { ref: "main" }, head: { sha: HEAD, ref: "feature/x" }, labels: [{ name: "ready" }], body: null, user: { login: "worker-1" } });
  assert.deepEqual(pullForCiGate({ repo: REPO, number: 148, run: read.run }), {
    pr: { number: 148, state: "open", baseRefName: "main", headRefOid: HEAD, headRefName: "feature/x" }, prLabels: ["ready"], body: "", author: "worker-1",
  });
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/pulls/148`]]);
  const odd = pullForCiGate({ repo: REPO, number: 148, run: recording({ number: 1, state: "open", labels: [{ name: "hold:x" }, { name: 3 }] }).run });
  assert.equal(odd.prLabels, null, "a name left out could be the hold, so the list is unread (#294)");
  assert.throws(() => pullForCiGate({ repo: REPO, number: 148, run: refused }), /HTTP 502/);
});

test("#188: the outcome a verdict is reconciled against is the pull request's state and when it merged or closed", () => {
  const read = recording({ state: "MERGED", mergedAt: "2026-09-07T01:00:00Z", closedAt: "2026-09-07T01:00:00Z" });
  assert.deepEqual(pullOutcomeOf({ repo: REPO, number: 188, run: read.run }), { state: "MERGED", mergedAt: "2026-09-07T01:00:00Z", closedAt: "2026-09-07T01:00:00Z" });
  assert.deepEqual(read.asked, [["pr", "view", "188", "--repo", REPO, "--json", "state,mergedAt,closedAt"]]);
  assert.deepEqual(pullOutcomeOf({ repo: REPO, number: 188, run: recording({ state: "OPEN" }).run }), { state: "OPEN", mergedAt: null, closedAt: null });
});

test("#386/#5526: a branch's open pull request says whether auto-merge is requested, its head, and its review decision (null when the answer has no such field, empty when it is empty)", () => {
  const read = recording([{ number: 7, autoMergeRequest: { enabledAt: "t" }, headRefOid: HEAD, reviewDecision: "APPROVED" }, { number: 8, autoMergeRequest: null, headRefOid: "b", reviewDecision: null }, { number: 9, autoMergeRequest: null, headRefOid: "c" }]);
  assert.deepEqual(openPullsOfBranch({ repo: REPO, branch: "feature/x", run: read.run }), [
    { number: 7, armed: true, headRefOid: HEAD, reviewDecision: "APPROVED" }, { number: 8, armed: false, headRefOid: "b", reviewDecision: "" }, { number: 9, armed: false, headRefOid: "c", reviewDecision: null },
  ]);
  assert.deepEqual(read.asked, [["pr", "list", "--repo", REPO, "--head", "feature/x", "--state", "open", "--json", "number,autoMergeRequest,headRefOid,reviewDecision"]]);
  assert.deepEqual(openPullsOfBranch({ repo: REPO, branch: "none", run: recording([]).run }), [], "a branch with no open pull request is an empty list: that read was made");
  assert.throws(() => openPullsOfBranch({ repo: REPO, branch: "b", run: refused }), /HTTP 502/);
});

test("the merge queue's dispatcher: the open pull requests with what readiness is decided on, the merge, the comparison with main and the deletion of the branch", () => {
  const list = recording([{ number: 3, headRefName: "x", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, statusCheckRollup: [] }]);
  assert.equal(openPullsForQueue({ run: list.run }).length, 1);
  assert.deepEqual(list.asked, [["pr", "list", "--state", "open", "--json", "number,title,headRefName,mergeable,mergeStateStatus,isDraft,statusCheckRollup"]]);
  assert.throws(() => openPullsForQueue({ run: recording("not json").run }));
  const merge = recording("Merged\n");
  assert.equal(mergeQueuedPull({ number: 3, run: merge.run }), "Merged\n", "what gh printed is returned, for the dispatcher to say");
  assert.deepEqual(merge.asked, [["pr", "merge", "3", "--merge"]]);
  assert.throws(() => mergeQueuedPull({ number: 3, run: recording(new Error("not mergeable")).run }), /not mergeable/);
  const compare = recording({ ahead_by: 2, commits: [{ sha: "a".repeat(40), commit: { message: "x\ny" } }] });
  assert.deepEqual(compareWithMain({ repo: REPO, branch: "feature/x", run: compare.run }).ahead_by, 2);
  assert.deepEqual(compare.asked, [["api", `repos/${REPO}/compare/main...feature/x`]]);
  const remove = recording("");
  deleteBranchOf({ repo: REPO, branch: "feature/x", run: remove.run });
  assert.deepEqual(remove.asked, [["api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/feature/x`]]);
  assert.throws(() => deleteBranchOf({ repo: REPO, branch: "feature/x", run: recording(new Error("HTTP 422")).run }), /HTTP 422/);
});
