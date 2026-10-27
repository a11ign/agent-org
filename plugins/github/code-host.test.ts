// no-token: none -- `exec` answers from a recorded table: no GitHub CLI runs
//
// THE CODE HOST AS CORE USES IT (A11-160): what the plugin does that the contract suite does not ask of every code host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import { settledGreenOf, unrequiredRedOf } from "../../src/work-gate/pr-orders.ts";
import { createCodeHost } from "./code-host.ts";

const URL = "https://github.com/netboxlabs/nbl-ui-netbox/pull/806";
const HEAD = "b".repeat(40);
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;

/** The answer of GitHub's feedback query for a pull request at `HEAD` with these reviews and comments. */
const feedbackAnswer = (reviews: unknown[], comments: unknown[] = []) => JSON.stringify({ data: { repository: { pullRequest: {
  state: "OPEN", headRefOid: HEAD, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "main", files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  reviews: { nodes: reviews }, comments: { nodes: comments }, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
} } } });

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

test("a read of a pull request's review state asks GitHub for the fields the policy names, and the policy judges what it read", () => {
  const asked: string[][] = [];
  const pull = { headRefOid: HEAD, reviews: [{ author: { login: "a11ign-reviewer" }, state: "APPROVED", commit: { oid: HEAD }, submittedAt: at(5) }], author: { login: "someone" }, isCrossRepository: true, statusCheckRollup: [] };
  const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author", trustOf: (pr) => (pr.isCrossRepository === true ? "outside" : "inside"), settledOf: (pr) => pr.statusCheckRollup.length === 0, unrequiredRedOf: () => [] }));
  const host = createCodeHost(fakePluginDeps({ policy, exec: (_file, args) => { asked.push([...args]); return { status: 0, stdout: JSON.stringify(pull), stderr: "" }; } }));
  const state = host.readReviewState(URL);
  assert.deepEqual(asked, [["pr", "view", "806", "--repo", "netboxlabs/nbl-ui-netbox", "--json", "headRefOid,reviews,author"]]);
  assert.deepEqual([state?.head, state?.trust, state?.settled, state?.reviews, state?.view.number], [HEAD, "outside", true, [{ author: "a11ign-reviewer", state: "APPROVED", commit: HEAD, at: Date.parse(at(5)) }], 806]);
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
  assert.equal(answering("{}").readReviewState(URL), null, "no head is no reading");
  assert.equal(answering("{}", 1).readReviewState(URL), null);
  assert.equal(answering("{}").readReviewState("https://linear.app/x/issue/NBF-1"), null);
  assert.equal(answering(JSON.stringify({ state: "REOPENED" })).readPullState(URL), null, "a state that is none of OPEN, MERGED, CLOSED is unread");
  assert.equal(answering("[]", 1).openPullUrlsOf("a/b"), null);
  assert.equal(answering("not json").openPullUrlsOf("a/b"), null);
  assert.equal(answering(JSON.stringify(Array.from({ length: 200 }, (_unused, index) => ({ number: index + 1, body: "" })))).openPullUrlsOf("a/b"), null, "a list at the limit may be cut short, so it is no reading");
  assert.deepEqual(answering(JSON.stringify([{ number: 3, body: "Closes #1" }])).openPullUrlsOf("a/b"), ["https://github.com/a/b/pull/3"]);
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

test("readPullState reads a pull request's state as GitHub names it, and null for one it cannot read", () => {
  const answers: (string | Error)[] = [JSON.stringify({ state: "MERGED" }), JSON.stringify({ state: "OPEN" }), JSON.stringify({ state: "CLOSED" }), JSON.stringify({}), new Error("gh exited 1")];
  const host = createCodeHost(fakePluginDeps({ exec: (_file, args) => {
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    const answer = answers.shift()!;
    return answer instanceof Error ? { status: 1, stdout: "", stderr: answer.message } : { status: 0, stdout: answer, stderr: "" };
  } }));
  assert.equal(host.readPullState(PR_URL), "MERGED");
  assert.equal(host.readPullState(PR_URL), "OPEN");
  assert.equal(host.readPullState(PR_URL), "CLOSED");
  assert.equal(host.readPullState(PR_URL), null, "an answer with no state is unread");
  assert.equal(host.readPullState(PR_URL), null, "a refused read is unread");
  assert.equal(host.readPullState("https://example.com/not-a-pull"), null, "a url that is no pull request is unread");
});

test("A11-119: a repository's open pull request urls are listed, and an unanswered or cut-short list is no reading", () => {
  const listed = (answer: () => { status: number; stdout: string; stderr: string }) => createCodeHost(fakePluginDeps({ exec: (_file, args) => {
    assert.deepEqual(args.slice(0, 5), ["pr", "list", "--repo", "a11ign/control", "--state"]);
    return answer();
  } })).openPullUrlsOf("a11ign/control");
  const ok = (stdout: string) => () => ({ status: 0, stdout, stderr: "" });
  assert.deepEqual(listed(ok(JSON.stringify([{ number: 119, body: "" }]))), ["https://github.com/a11ign/control/pull/119"]);
  assert.deepEqual(listed(ok("[]")), [], "none open is a reading");
  assert.equal(listed(() => ({ status: 1, stdout: "", stderr: "gh exited 1" })), null, "a refused gh is no reading");
  assert.equal(listed(ok("not json")), null);
  assert.equal(listed(ok(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ number: i, body: "" }))))), null, "a list at the limit may be cut short");
});

// A11-175: a head is settled when the checks the base REQUIRES have settled green. The plugin reads which are required from GitHub (`isRequired`), only when the rollup is not all green, and core's judge decides.
const lab = (name: string, conclusion: string) => ({ name, status: "COMPLETED", conclusion, completedAt: at(1) });
const LAB_ROLLUP = [lab("gate", "SUCCESS"), lab("refusalOwners", "SUCCESS"), lab("checks (own)", "SUCCESS"), lab("checks (cross-repo)", "FAILURE")];
const requiredAnswer = (required: string[], all: string[], hasNextPage = false) => JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes:
  all.map((name) => ({ __typename: "CheckRun", name, isRequired: required.includes(name) })) } } } }] } } } } });

/** The answer of the merge flow query (`merge-flow.ts`) for one repository: auto-merge off, no arm workflow, the merge bot held or not. */
const mergeFlowAnswer = ({ private: isPrivate, mergeBot }: { private: boolean; mergeBot: boolean }) => JSON.stringify({ data: { r0: {
  autoMergeAllowed: false, isPrivate, defaultBranchRef: { name: "main" }, object: null, bot: mergeBot ? { __typename: "Blob" } : null } } });

/** A code host over a scripted `gh`: `pr view` answers the pull request, `api graphql` answers which of its checks are required (or fails when `required` is null). */
function hostWithChecks(rollup: unknown[], required: string[] | null, hasNextPage = false, flow?: { private: boolean; mergeBot: boolean }) {
  const asked: string[][] = [];
  const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author,statusCheckRollup", trustOf: () => "inside", settledOf: settledGreenOf, unrequiredRedOf }));
  const pull = { headRefOid: HEAD, reviews: [], author: { login: "someone" }, statusCheckRollup: rollup };
  const exec = (_file: string, args: readonly string[]) => {
    asked.push([...args]);
    if (args[0] === "pr") return { status: 0, stdout: JSON.stringify(pull), stderr: "" };
    if (args.some((arg) => arg.includes(".github/workflows/merge-bot.yml"))) {
      return flow === undefined ? { status: 1, stdout: "", stderr: "gh: HTTP 502" } : { status: 0, stdout: mergeFlowAnswer(flow), stderr: "" };
    }
    return required === null ? { status: 1, stdout: "", stderr: "gh: HTTP 502" } : { status: 0, stdout: requiredAnswer(required, rollup.map((check) => (check as { name: string }).name), hasNextPage), stderr: "" };
  };
  return { host: createCodeHost(fakePluginDeps({ policy, exec })), asked };
}

test("A11-175: readReviewState is settled when the required checks are green and an unrequired one is red, and reads isRequired only when the rollup is not green", () => {
  const { host, asked } = hostWithChecks(LAB_ROLLUP, ["gate", "refusalOwners", "checks (own)"]);
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, ["checks (cross-repo)"]], "lab#144: the required checks are green, the red one is named and holds nothing");
  assert.deepEqual(asked.map((args) => args.slice(0, 2)), [["pr", "view"], ["api", "graphql"]]);
  assert.ok(asked[1].some((arg) => arg.includes("isRequired(pullRequestNumber: $number)")), "GitHub's own answer for the pull request's base, as the board's failing checks read it");
  assert.ok(asked[1].includes("number=806") && asked[1].includes("repo=nbl-ui-netbox") && asked[1].includes("owner=netboxlabs"));

  const requiredRed = hostWithChecks(LAB_ROLLUP, ["gate", "checks (cross-repo)"]).host.readReviewState(URL);
  assert.deepEqual([requiredRed?.settled, requiredRed?.unrequiredRed], [false, undefined], "a required check that failed holds the start");

  const pending = hostWithChecks([lab("gate", "SUCCESS"), { name: "checks (cross-repo)", status: "IN_PROGRESS", conclusion: null }], ["gate"]).host.readReviewState(URL);
  assert.deepEqual([pending?.settled, pending?.unrequiredRed], [true, undefined], "an unrequired check still running holds nothing either");
});

test("A11-175: an all-green rollup is settled with the one pull request read, names no unrequired check, and asks GitHub nothing about which checks are required", () => {
  const { host, asked } = hostWithChecks(LAB_ROLLUP.map((check) => ({ ...check, conclusion: "SUCCESS" })), []);
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, undefined]);
  assert.deepEqual(asked.map((args) => args.slice(0, 2)), [["pr", "view"]], "the second call is paid only when something is not green");
});

test("A11-175: a list of required checks GitHub would not give, or that is empty, counts every check, so the reviewer waits as it did", () => {
  const unreadable = hostWithChecks(LAB_ROLLUP, null).host.readReviewState(URL);
  assert.deepEqual([unreadable?.settled, unreadable?.unrequiredRed], [false, undefined], "an unreadable answer is not 'nothing is required'");
  const none = hostWithChecks(LAB_ROLLUP, []).host.readReviewState(URL);
  assert.deepEqual([none?.settled, none?.unrequiredRed], [false, undefined], "a branch that requires nothing counts every check");
  const cut = hostWithChecks(LAB_ROLLUP, ["gate", "refusalOwners", "checks (own)"], true).host.readReviewState(URL);
  assert.deepEqual([cut?.settled, cut?.unrequiredRed], [false, undefined], "a head with more checks than one page holds is not read in full: a required check past the page would be counted as not required");
  const odd = createCodeHost(fakePluginDeps({ policy: corePolicy(() => ({ fields: "headRefOid,reviews,author,statusCheckRollup", trustOf: () => "inside", settledOf: settledGreenOf, unrequiredRedOf })),
    exec: (_file, args) => ({ status: 0, stdout: args[0] === "pr" ? JSON.stringify({ headRefOid: HEAD, reviews: [], statusCheckRollup: LAB_ROLLUP }) : "not json", stderr: "" }) }));
  assert.equal(odd.readReviewState(URL)?.settled, false, "an answer that does not parse counts every check");
});

test("A11-341: in a merge-bot repository with no required check, the reviewer waits on `gate` alone, and a red check that is not the merge condition is named and holds nothing", () => {
  const rollup = [lab("gate", "SUCCESS"), lab("capture", "FAILURE")];
  const { host, asked } = hostWithChecks(rollup, [], false, { private: true, mergeBot: true });
  const state = host.readReviewState(URL);
  assert.deepEqual([state?.settled, state?.unrequiredRed], [true, ["capture"]], "gate is green: the reviewer starts, and capture is reported as unrequired red");
  assert.deepEqual(asked.map((args) => args.slice(0, 2)), [["pr", "view"], ["api", "graphql"], ["api", "graphql"]]);

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
  const unreadable = hostWithChecks([lab("gate", "SUCCESS"), lab("capture", "FAILURE")], []).host.readReviewState(URL);
  assert.deepEqual([unreadable?.settled, unreadable?.unrequiredRed], [false, undefined], "a flow GitHub would not give counts every check");
  const rulesetHost = hostWithChecks([lab("gate", "SUCCESS"), lab("capture", "FAILURE")], ["capture"], false, { private: true, mergeBot: true });
  const ruleset = rulesetHost.host.readReviewState(URL);
  assert.equal(rulesetHost.asked.length, 2, "a ruleset's required checks end the read: the merge flow is not asked");
  assert.deepEqual([ruleset?.settled, ruleset?.unrequiredRed], [false, undefined], "GitHub names capture required: the ruleset decides, and the merge bot is not asked");
});
