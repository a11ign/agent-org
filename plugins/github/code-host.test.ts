// no-token: none -- `exec` answers from a recorded table: no GitHub CLI runs
//
// THE CODE HOST AS CORE USES IT (A11-160): what the plugin does that the contract suite does not ask of every code host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import { REVIEW_PULL_FIELDS, settledGreenOf, unrequiredRedOf } from "../../src/work-gate/pr-orders.ts";
import { createCodeHost } from "./code-host.ts";
import { VIEW_FIELDS } from "./reviews.ts";

const URL = "https://github.com/netboxlabs/nbl-ui-netbox/pull/806";
const HEAD = "b".repeat(40);
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;

/** The pull request at `HEAD` as the snapshot's query answers it, with these reviews and comments, and the repository's list of open pull requests that holds it. */
const pullNode = (over: Record<string, unknown> = {}) => ({
  number: 806, state: "OPEN", url: URL, title: "t", body: "", isDraft: false, isCrossRepository: false, headRefName: "admin/x", headRefOid: HEAD, baseRefName: "main", author: { login: "someone", __typename: "User" },
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] }, baseRef: null, ...over,
});

/** The answer of the snapshot's query (`pull-snapshot.ts`) for a repository whose open pull requests are `nodes`. */
const listAnswer = (nodes: unknown[], repository: { isPrivate?: boolean; bot?: unknown } = {}) => JSON.stringify({ data: { repository: { isPrivate: false, bot: null, ...repository, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });

/** The answer of GitHub's snapshot query for a pull request at `HEAD` with these reviews and comments. */
const feedbackAnswer = (reviews: unknown[], comments: unknown[] = []) => listAnswer([pullNode({ reviews: { nodes: reviews }, comments: { nodes: comments } })]);

const review = (state: string, minute: number, login: string) => ({ state, submittedAt: at(minute), author: { login }, commit: { oid: HEAD } });

test("a read of feedback leaves out the accounts the board is told to ignore, as well as its own: the reviewer's verdict never moves feedbackAt or approves the head", () => {
  const reviews = [review("COMMENTED", 10, "alice"), review("CHANGES_REQUESTED", 30, "a11ign-reviewer"), review("APPROVED", 20, "a11ign-reviewer")];
  const comments = [{ createdAt: at(40), author: { login: "a11ign-reviewer" } }, { createdAt: at(15), author: { login: "worker-bot" } }];
  const host = createCodeHost(fakePluginDeps({ exec: () => ({ status: 0, stdout: feedbackAnswer(reviews, comments), stderr: "" }) }));
  const withReviewer = host.readPullFeedback(URL, "worker-bot");
  assert.deepEqual([withReviewer?.feedbackAt, withReviewer?.authors, withReviewer?.approvedAtHead], [Date.parse(at(40)), ["a11ign-reviewer", "alice"], false],
    "without the list, the reviewer's own comment is the newest feedback, and its newest verdict on the head is changes requested");
  const without = host.readPullFeedback(URL, "worker-bot", ["a11ign-reviewer"]);
  assert.deepEqual([without?.feedbackAt, without?.authors, without?.approvedAtHead], [Date.parse(at(10)), ["alice"], false],
    "with it, only alice's is feedback, and the reviewer's approval does not approve the head");
  const approved = createCodeHost(fakePluginDeps({ exec: () => ({ status: 0, stdout: feedbackAnswer([review("APPROVED", 20, "a11ign-reviewer"), review("APPROVED", 25, "alice")]), stderr: "" }) }));
  assert.equal(approved.readPullFeedback(URL, "worker-bot", ["alice"])?.approvedAtHead, true, "the ignored accounts are the caller's to name: here the reviewer approved and alice is ignored");
  assert.equal(approved.readPullFeedback(URL, "worker-bot", ["a11ign-reviewer", "alice"])?.approvedAtHead, false);
});

test("a read of a pull request's review state is judged by the policy from the pull request in the snapshot, in the shape `gh pr view` gave it", () => {
  const asked: string[][] = [];
  const node = pullNode({ author: { login: "dependabot", __typename: "Bot" }, isCrossRepository: true, reviews: { nodes: [{ author: { login: "a11ign-reviewer" }, state: "APPROVED", body: "ok", commit: { oid: HEAD }, submittedAt: at(5) }] } });
  const judged: Record<string, any>[] = [];
  const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author", trustOf: (pr) => { judged.push(pr); return pr.isCrossRepository === true ? "outside" : "inside"; }, settledOf: (pr) => pr.statusCheckRollup.length === 0, unrequiredRedOf: () => [] }));
  const host = createCodeHost(fakePluginDeps({ policy, exec: (_file, args) => { asked.push([...args]); return { status: 0, stdout: listAnswer([node]), stderr: "" }; } }));
  const state = host.readReviewState(URL);
  assert.equal(asked.length, 1, "one call: the repository's snapshot");
  assert.deepEqual(asked[0].slice(0, 2), ["api", "graphql"]);
  assert.deepEqual([state?.head, state?.trust, state?.settled, state?.reviews, state?.view.number], [HEAD, "outside", true, [{ author: "a11ign-reviewer", state: "APPROVED", commit: HEAD, at: Date.parse(at(5)) }], 806]);
  assert.deepEqual(state?.view.reviews, [{ author: { login: "a11ign-reviewer" }, state: "APPROVED", body: "ok", commit: { oid: HEAD }, submittedAt: at(5) }], "the reviews of the view carry their text, which the stand-off reads the reviewer's block from");
  assert.deepEqual(judged[0].author, { login: "app/dependabot", is_bot: true }, "a bot author is spelled as `gh pr view --json author` spells it, which the org's declared identities are written for");
});

test("A11-365: the rollup is given to the policy as `gh pr view` printed it: a run in flight has an empty conclusion and the zero time, a commit status its context and the time it was created", () => {
  const judged: Record<string, any>[] = [];
  const policy = corePolicy(() => ({ fields: "headRefOid,statusCheckRollup", trustOf: () => "inside", settledOf: (pr) => { judged.push(pr); return true; }, unrequiredRedOf: () => [] }));
  const rollup = [{ __typename: "CheckRun", name: "suite", status: "IN_PROGRESS", conclusion: null, startedAt: at(3), completedAt: null, detailsUrl: "https://github.com/netboxlabs/nbl-ui-netbox/actions/runs/5/job/6" },
    { __typename: "StatusContext", context: "netlify", state: "SUCCESS", createdAt: at(4), targetUrl: "https://example.com/deploy" }];
  const host = createCodeHost(fakePluginDeps({ policy, exec: () => ({ status: 0, stdout: listAnswer([pullNode({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: rollup } } } }] } })]), stderr: "" }) }));
  host.readReviewState(URL);
  assert.deepEqual(judged[0].statusCheckRollup, [
    { __typename: "CheckRun", name: "suite", status: "IN_PROGRESS", conclusion: "", startedAt: at(3), completedAt: "0001-01-01T00:00:00Z", detailsUrl: "https://github.com/netboxlabs/nbl-ui-netbox/actions/runs/5/job/6" },
    { __typename: "StatusContext", context: "netlify", state: "SUCCESS", startedAt: at(4), targetUrl: "https://example.com/deploy" },
  ]);
});

test("a policy that reads a field of the pull request the snapshot does not hold refuses the read by name, rather than judge a pull request without it", () => {
  const policy = corePolicy(() => ({ fields: "headRefOid,reviews,labels", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));
  const host = createCodeHost(fakePluginDeps({ policy, exec: () => ({ status: 0, stdout: listAnswer([pullNode()]), stderr: "" }) }));
  assert.throws(() => host.readReviewState(URL), /reads labels of a pull request, which the snapshot of its repository does not hold/);
});

test("the fields core's own reviewer policy reads are all fields the snapshot supplies", () => {
  assert.deepEqual(REVIEW_PULL_FIELDS.split(",").filter((field) => !VIEW_FIELDS.includes(field)), []);
});

test("a host whose reviewer gate does not load refuses the read by the gate's own words before it asks GitHub anything", () => {
  let asked = 0;
  const refusing = corePolicy(() => { throw new Error("no primary project is declared"); });
  const host = createCodeHost(fakePluginDeps({ policy: refusing, exec: () => { asked += 1; return { status: 0, stdout: "{}", stderr: "" }; } }));
  assert.throws(() => host.readReviewState(URL), /no primary project is declared/);
  assert.equal(asked, 0);
  assert.equal(host.readPullState(URL), null, "a read that needs no judging is still answered (here: gh answered no state)");
});

test("a pull request GitHub does not say is null, never a reading: no head, an address that is none, and a refused gh", () => {
  const policy = corePolicy(() => ({ fields: "headRefOid", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));
  const answering = (stdout: string, status = 0) => createCodeHost(fakePluginDeps({ policy, exec: () => ({ status, stdout, stderr: status === 0 ? "" : "gh: boom" }) }));
  assert.equal(answering(listAnswer([pullNode({ headRefOid: undefined })])).readReviewState(URL), null, "no head is no reading");
  assert.equal(answering("{}", 1).readReviewState(URL), null);
  assert.equal(answering("{}").readReviewState("https://linear.app/x/issue/NBF-1"), null);
  assert.equal(answering(listAnswer([pullNode({ state: "REOPENED" })])).readPullState(URL), null, "a state that is none of OPEN, MERGED, CLOSED is unread");
  assert.equal(answering("[]", 1).openPullUrlsOf("a/b"), null);
  assert.equal(answering("not json").openPullUrlsOf("a/b"), null);
  assert.deepEqual(answering(listAnswer([pullNode({ number: 3, url: "https://github.com/a/b/pull/3" })])).openPullUrlsOf("a/b"), ["https://github.com/a/b/pull/3"]);
});

test("the port's operations that ticket mode does not call are honest: no change is read, no review requested, and a subscription delivers nothing", () => {
  const host = createCodeHost(fakePluginDeps());
  const ref = { host: "github", id: URL };
  assert.equal(host.readChange(ref), null, "could not ask: a caller acts on no guess");
  assert.throws(() => host.requestReview(ref, "a-person"), /does not request a review yet/);
  const cancel = host.subscribe({}, () => assert.fail("a subscription is not delivered an event"));
  assert.equal(typeof cancel, "function");
  cancel();
});

/** A code host over a scripted `gh`: `answer` gets the arguments of each call and answers its stdout, or throws as `gh` fails. */
function hostAnswering(answer: (args: readonly string[]) => string) {
  const asked: string[][] = [];
  const host = createCodeHost(fakePluginDeps({ exec: (_file, args) => {
    asked.push([...args]);
    try {
      return { status: 0, stdout: answer(args), stderr: "" };
    } catch (cause) {
      return { status: 1, stdout: "", stderr: (cause as Error).message };
    }
  } }), { sleep: () => undefined, error: () => undefined });
  return { host, asked };
}

const ARM_REF = { host: "github", id: "a11ign/agent-org#7" };
const armedNode = (over: object = {}) => JSON.stringify({ merged: false, autoMergeRequest: null, mergeQueueEntry: null, ...over });

test("armMerge arms the merge and reads the pull request back: true once it is armed", () => {
  const { host, asked } = hostAnswering((args) => (args[0] === "pr" ? "" : armedNode({ autoMergeRequest: { enabledAt: "2026-10-23T10:00:00Z" } })));
  assert.equal(host.armMerge(ARM_REF), true);
  assert.deepEqual(asked[0], ["pr", "merge", "--auto", "--merge", "7", "--repo", "a11ign/agent-org"], "the arm is auto-merge with a merge commit, aimed at the repository the change names");
  assert.deepEqual(asked[1].slice(0, 2), ["api", "graphql"], "and the pull request is read back, because the exit of the arm is not the evidence that it took");
});

test("armMerge says false for an arm that exited well and did not take, and true for a pull request that merged or queued meanwhile", () => {
  const exitedWell = hostAnswering((args) => (args[0] === "pr" ? "" : armedNode()));
  assert.equal(exitedWell.host.armMerge(ARM_REF), false, "an arm that took nothing is not armed (#1022)");
  const refusedThenMerged = hostAnswering((args) => {
    if (args[0] === "pr" && args[1] === "merge") throw new Error("GraphQL: Merge already in progress");
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "MERGED" });
    return armedNode({ merged: true });
  });
  assert.equal(refusedThenMerged.host.armMerge(ARM_REF), true, "a refused arm on a pull request that merged meanwhile has nothing left to arm, and reads as armed");
});

test("armMerge throws a refusal nothing explains, and an address that is no change", () => {
  const unexplained = hostAnswering((args) => {
    if (args[0] === "pr" && args[1] === "merge") throw new Error("GraphQL: Pull request is not mergeable");
    if (args[0] === "pr") return JSON.stringify({ state: "OPEN" });
    return armedNode();
  });
  assert.throws(() => unexplained.host.armMerge(ARM_REF), /not mergeable/, "open, not armed and refused is a refusal to name, not to swallow");
  assert.throws(() => hostAnswering(() => "").host.armMerge({ host: "github", id: "no-number" }), /owner\/name#number/);
});

const PR_URL = "https://github.com/a11ign/agent-org/pull/7";

/** The answer of the snapshot's query for `a11ign/agent-org`, which holds pull request 7. */
const agentOrgPull = (state = "OPEN") => pullNode({ number: 7, state, url: PR_URL });

test("readPullState reads a pull request's state as GitHub names it, and null for one it cannot read", () => {
  const stateOf = (stdout: string, status = 0) => createCodeHost(fakePluginDeps({ exec: () => ({ status, stdout, stderr: status === 0 ? "" : "gh exited 1" }) })).readPullState(PR_URL);
  assert.equal(stateOf(listAnswer([agentOrgPull("OPEN")])), "OPEN");
  const byNumber = (state: string) => createCodeHost(fakePluginDeps({ exec: (_file, args) => ({ status: 0, stdout: args.some((arg) => arg.includes("pullRequests(states: OPEN")) ? listAnswer([]) : JSON.stringify({ data: { repository: { isPrivate: false, bot: null, pullRequest: agentOrgPull(state) } } }), stderr: "" }) })).readPullState(PR_URL);
  assert.equal(byNumber("MERGED"), "MERGED", "a pull request that is not open is read by its number");
  assert.equal(byNumber("CLOSED"), "CLOSED");
  assert.equal(stateOf(listAnswer([pullNode({ number: 7, state: undefined })])), null, "an answer with no state is unread");
  assert.equal(stateOf("", 1), null, "a refused read is unread");
  assert.equal(createCodeHost(fakePluginDeps()).readPullState("https://example.com/not-a-pull"), null, "a url that is no pull request is unread");
});

test("A11-119: a repository's open pull request urls are listed, and an unanswered or cut-short list is no reading", () => {
  const listed = (answer: () => { status: number; stdout: string; stderr: string }) => createCodeHost(fakePluginDeps({ exec: (_file, args) => {
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    assert.ok(args.includes("owner=a11ign") && args.includes("repo=control"));
    return answer();
  } })).openPullUrlsOf("a11ign/control");
  const ok = (stdout: string) => () => ({ status: 0, stdout, stderr: "" });
  assert.deepEqual(listed(ok(listAnswer([pullNode({ number: 119 })]))), ["https://github.com/a11ign/control/pull/119"]);
  assert.deepEqual(listed(ok(listAnswer([]))), [], "none open is a reading");
  assert.equal(listed(() => ({ status: 1, stdout: "", stderr: "gh exited 1" })), null, "a refused gh is no reading");
  assert.equal(listed(ok("not json")), null);
  const cut = JSON.stringify({ data: { repository: { isPrivate: false, bot: null, pullRequests: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [pullNode({ number: 1 })] } } } });
  assert.equal(listed(ok(cut)), null, "a list that goes on past the pages read is cut short, so it is no reading");
});

// A11-175: a head is settled when the checks the base REQUIRES have settled green. The snapshot names which are required from the base's rulesets and protection (`baseRef`), and core's judge decides.
const lab = (name: string, conclusion: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, completedAt: at(1) });
const LAB_ROLLUP = [lab("gate", "SUCCESS"), lab("refusalOwners", "SUCCESS"), lab("checks (own)", "SUCCESS"), lab("checks (cross-repo)", "FAILURE")];

/** The base branch's rules as the snapshot's query answers them: a ruleset requiring `required`, or no rules at all when `required` is empty. */
const baseRefRequiring = (required: string[]) => ({ rules: { nodes: required.length === 0 ? [] : [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: required.map((context) => ({ context })) } }] }, branchProtectionRule: null });

/** The answer of the query for the merge bot's file on a pull request's head (`merge-flow.ts`, A11-344): held or not. */
const headBotAnswer = (headBot: boolean) => JSON.stringify({ data: { r0: { headBot: headBot ? { __typename: "Blob" } : null } } });

/**
 * A code host over a scripted `gh`: the snapshot's query answers a repository whose one open pull request has this `rollup` and a base that requires `required`, in a repository that is `private` and holds the merge bot (`mergeBot`) or not, and
 * the query for the head's file answers whether the pull request's head holds the merge bot (`headBot`, default no).
 */
function hostWithChecks(rollup: unknown[], required: string[], hasNextPage = false, flow: { private: boolean; mergeBot: boolean; headBot?: boolean } = { private: false, mergeBot: false }) {
  const asked: string[][] = [];
  const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author,statusCheckRollup", trustOf: () => "inside", settledOf: settledGreenOf, unrequiredRedOf }));
  const node = pullNode({ baseRef: baseRefRequiring(required), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes: rollup } } } }] } });
  const exec = (_file: string, args: readonly string[]) => {
    asked.push([...args]);
    if (args.some((arg) => arg.includes("refs/pull/") && arg.includes(".github/workflows/merge-bot.yml"))) return { status: 0, stdout: headBotAnswer(flow.headBot === true), stderr: "" };
    return { status: 0, stdout: listAnswer([node], { isPrivate: flow.private, bot: flow.mergeBot ? { __typename: "Blob" } : null }), stderr: "" };
  };
  return { host: createCodeHost(fakePluginDeps({ policy, exec })), asked };
}

test("A11-175: readReviewState is settled when the required checks are green and an unrequired one is red, and names the red one", () => {
  const { host, asked } = hostWithChecks(LAB_ROLLUP, ["gate", "refusalOwners", "checks (own)"]);
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, ["checks (cross-repo)"]], "lab#144: the required checks are green, the red one is named and holds nothing");
  assert.equal(asked.length, 1, "which checks are required came with the pull request: GitHub's own answer for the pull request's base, as the board's failing checks read it");

  const requiredRed = hostWithChecks(LAB_ROLLUP, ["gate", "checks (cross-repo)"]).host.readReviewState(URL);
  assert.deepEqual([requiredRed?.settled, requiredRed?.unrequiredRed], [false, undefined], "a required check that failed holds the start");

  const pending = hostWithChecks([lab("gate", "SUCCESS"), { __typename: "CheckRun", name: "checks (cross-repo)", status: "IN_PROGRESS", conclusion: null }], ["gate"]).host.readReviewState(URL);
  assert.deepEqual([pending?.settled, pending?.unrequiredRed], [true, undefined], "an unrequired check still running holds nothing either");
});

test("A11-175: an all-green rollup is settled, names no unrequired check, and takes one call", () => {
  const { host, asked } = hostWithChecks(LAB_ROLLUP.map((check) => ({ ...check, conclusion: "SUCCESS" })), []);
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, undefined]);
  assert.equal(asked.length, 1);
});

test("A11-175: a branch that requires nothing counts every check, and a rollup of more than one page is never settled, so the reviewer waits as it did", () => {
  const none = hostWithChecks(LAB_ROLLUP, []).host.readReviewState(URL);
  assert.deepEqual([none?.settled, none?.unrequiredRed], [false, undefined], "a branch that requires nothing counts every check");
  const cut = hostWithChecks(LAB_ROLLUP.map((check) => ({ ...check, conclusion: "SUCCESS" })), ["gate"], true).host.readReviewState(URL);
  assert.deepEqual([cut?.settled, cut?.unrequiredRed, cut?.head], [false, undefined, HEAD], "a head with more checks than one page holds is not read in full: the green ones seen say nothing of the ones past the page");
});

test("A11-341: in a merge-bot repository with no required check, the reviewer waits on `gate` alone, and a red check that is not the merge condition is named and holds nothing", () => {
  const rollup = [lab("gate", "SUCCESS"), lab("capture", "FAILURE")];
  const { host, asked } = hostWithChecks(rollup, [], false, { private: true, mergeBot: true });
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, ["capture"]], "gate is green: the reviewer starts, and capture is reported as unrequired red");
  assert.equal(asked.length, 1, "the repository's flow came with the snapshot");

  const gateRed = hostWithChecks([lab("gate", "FAILURE"), lab("capture", "SUCCESS")], [], false, { private: true, mergeBot: true }).host.readReviewState(URL);
  assert.deepEqual([gateRed?.settled, gateRed?.unrequiredRed], [false, undefined], "a red gate holds the start");

  const gateMissing = hostWithChecks([lab("capture", "FAILURE")], [], false, { private: true, mergeBot: true }).host.readReviewState(URL);
  assert.deepEqual([gateMissing?.settled, gateMissing?.unrequiredRed], [false, ["capture"]], "a gate that has not reported is not settled");
});

test("A11-341: a repository with neither a ruleset nor the merge bot counts every check, and a ruleset's required checks win over the merge bot's gate", () => {
  const plain = hostWithChecks([lab("gate", "SUCCESS"), lab("capture", "FAILURE")], [], false, { private: false, mergeBot: false }).host.readReviewState(URL);
  assert.deepEqual([plain?.settled, plain?.unrequiredRed], [false, undefined], "no bot: every check counts, as before");
  const bare = hostWithChecks([lab("gate", "SUCCESS"), lab("capture", "FAILURE")], [], false, { private: true, mergeBot: false }).host.readReviewState(URL);
  assert.deepEqual([bare?.settled, bare?.unrequiredRed], [false, undefined], "a private repository without the bot counts every check");
  const rulesetHost = hostWithChecks([lab("gate", "SUCCESS"), lab("capture", "FAILURE")], ["capture"], false, { private: true, mergeBot: true });
  const ruleset = rulesetHost.host.readReviewState(URL);
  assert.equal(rulesetHost.asked.length, 1, "a ruleset's required checks end the read: nothing more is asked");
  assert.deepEqual([ruleset?.settled, ruleset?.unrequiredRed], [false, undefined], "GitHub names capture required: the ruleset decides, and the merge bot is not asked");
});

test("A11-344: the pull request that adds the merge bot is read as a merge-bot pull request: the default branch has none, the head holds it, so `gate` alone is waited on and a red check that is not the merge condition is named and holds nothing", () => {
  const rollup = [lab("gate", "SUCCESS"), lab("capture", "FAILURE")];
  const { host, asked } = hostWithChecks(rollup, [], false, { private: true, mergeBot: false, headBot: true });
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, ["capture"]], "gate is green: the reviewer starts, and capture is reported as unrequired red");
  const headRead = asked.find((args) => args.some((arg) => arg.includes("refs/pull/806/head:.github/workflows/merge-bot.yml")));
  assert.ok(headRead !== undefined, "the head is read by the pull request's own ref");
  host.readReviewState(URL);
  assert.equal(asked.filter((args) => args.some((arg) => arg.includes("refs/pull/"))).length, 1, "and once for the head: a head that holds the bot always does");

  const gateRed = hostWithChecks([lab("gate", "FAILURE"), lab("capture", "SUCCESS")], [], false, { private: true, mergeBot: false, headBot: true }).host.readReviewState(URL);
  assert.deepEqual([gateRed?.settled, gateRed?.unrequiredRed], [false, undefined], "a red gate holds the start on the pull request that adds the bot too");
});

test("A11-344: a private repository with no merge bot on its default branch or its head counts every check, and so does a public one whose head holds it", () => {
  const rollup = [lab("gate", "SUCCESS"), lab("capture", "FAILURE")];
  const neither = hostWithChecks(rollup, [], false, { private: true, mergeBot: false, headBot: false }).host.readReviewState(URL);
  assert.deepEqual([neither?.settled, neither?.unrequiredRed], [false, undefined], "no bot on either: every check counts, as before");
  const publicHead = hostWithChecks(rollup, [], false, { private: false, mergeBot: false, headBot: true }).host.readReviewState(URL);
  assert.deepEqual([publicHead?.settled, publicHead?.unrequiredRed], [false, undefined], "a public repository has a ruleset's way: the bot on a head changes nothing");
  const onDefault = hostWithChecks(rollup, [], false, { private: true, mergeBot: true, headBot: false });
  assert.deepEqual([onDefault.host.readReviewState(URL)?.settled], [true], "the bot on the default branch still covers a pull request whose head is read without it");
  assert.equal(onDefault.asked.some((args) => args.some((arg) => arg.includes("refs/pull/"))), false, "the head is not asked where the default branch already holds the bot");
  const ruleset = hostWithChecks(rollup, ["capture"], false, { private: true, mergeBot: false, headBot: true });
  assert.deepEqual([ruleset.host.readReviewState(URL)?.settled], [false], "a ruleset's required checks win over the bot a head adds");
});
