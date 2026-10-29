// no-token: none -- the sync and the async form of each operation run over the same canned `gh` answers: no GitHub CLI runs
//
// A11-395: the operations the board makes on an event (a merge queue removal, a red check, a branch that fell behind, a stack to merge, a pull request to close) each gain an async form that runs `gh` through
// `deps.execAsync`. Until the code host hands them out (the contract major of step 2) nothing calls them, so what holds them to the sync form is this file: for every pair, the same `gh` calls in the same order,
// and the same answer (or the same refusal), for the success and for each refusal or `null` the sync form's own tests cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import { readCheckLog, readCheckLogAsync, rerunFailedChecks, rerunFailedChecksAsync } from "./check-runs.ts";
import { readCiRun, readCiRunAsync } from "./ci-run.ts";
import { closePull, closePullAsync, commentOnPull, commentOnPullAsync } from "./close-pull.ts";
import { readClosedWork, readClosedWorkAsync } from "./closed-work.ts";
import { readDefaultBranchRed, readDefaultBranchRedAsync } from "./default-branch-checks.ts";
import { GhFailure, type AsyncGh, type Gh } from "./gh.ts";
import { readOrganisationFlows, readOrganisationFlowsAsync, readRepositoryFlows, readRepositoryFlowsAsync } from "./merge-flow.ts";
import { holdPullRequest, holdPullRequestAsync, readQueueFailure, readQueueFailureAsync, releasePullRequest, releasePullRequestAsync } from "./merge-queue.ts";
import { pullsNaming, pullsNamingAsync } from "./ticket-pulls.ts";
import { rerunRuns, rerunRunsAsync } from "./rerun-runs.ts";
import { updateBranch, updateBranchAsync } from "./update-branch.ts";
import { requestStackMerge, requestStackMergeAsync, stackMergeFactsOf, stackMergeFactsOfAsync } from "./stack-merge.ts";

/** What canned `gh` says to a call: the text it prints, or a failure with what it printed on stderr. */
type Say = string | Readonly<{ fail: string }>;

/** The canned `gh`: what it says to the call with these arguments. A call it was not scripted for fails the test. */
type Script = (args: readonly string[]) => Say;

/** What an operation did over the script: the calls it made, in order, and what it answered (`value`) or how it refused (`threw`). */
type Run = Readonly<{ calls: readonly string[]; value?: unknown; threw?: string }>;

const failureOf = (args: readonly string[], say: Readonly<{ fail: string }>): GhFailure => new GhFailure(args, { status: 1, stdout: "", stderr: say.fail });

const syncGh = (script: Script, calls: string[]): Gh => (args) => {
  calls.push(args.join(" "));
  const say = script(args);
  if (typeof say !== "string") throw failureOf(args, say);
  return say;
};

const asyncGh = (script: Script, calls: string[]): AsyncGh => (args) => {
  calls.push(args.join(" "));
  const say = script(args);
  return typeof say === "string" ? Promise.resolve(say) : Promise.reject(failureOf(args, say));
};

/** Runs the sync form over `script` and answers what it did. */
function ranSync(script: Script, operation: (gh: Gh) => unknown): Run {
  const calls: string[] = [];
  try {
    return { calls, value: operation(syncGh(script, calls)) };
  } catch (err) {
    return { calls, threw: (err as Error).message };
  }
}

/** Runs the async form over the same `script` and answers what it did. */
async function ranAsync(script: Script, operation: (gh: AsyncGh) => Promise<unknown>): Promise<Run> {
  const calls: string[] = [];
  try {
    return { calls, value: await operation(asyncGh(script, calls)) };
  } catch (err) {
    return { calls, threw: (err as Error).message };
  }
}

/** Asserts that the two forms made the same calls and gave the same answer over `script`, and that the call was worth comparing: at least `atLeast` calls were made. */
async function sameOver(script: Script, sync: (gh: Gh) => unknown, asynchronous: (gh: AsyncGh) => Promise<unknown>, atLeast = 1): Promise<Run> {
  const expected = ranSync(script, sync);
  const actual = await ranAsync(script, asynchronous);
  assert.deepEqual(actual, expected, "the async form made the same calls in the same order, and answered the same");
  assert.ok(expected.calls.length >= atLeast, `at least ${atLeast} gh call(s) were compared, saw ${expected.calls.length}`);
  return expected;
}

const PULL = "https://github.com/owner/repo/pull/7";
const REFUSED: Say = { fail: "HTTP 403: Resource not accessible by integration\nsecond line" };
const NOT_FOUND: Say = { fail: "gh: Not Found (HTTP 404)" };
const SHA = "a".repeat(40);

// merge-queue.ts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const RUNS = JSON.stringify({ workflow_runs: [{ id: 11, html_url: "https://github.com/owner/repo/actions/runs/11", conclusion: "failure" }, { id: 12, html_url: "https://github.com/owner/repo/actions/runs/12", conclusion: "success" }, { id: 13, html_url: "https://github.com/owner/repo/actions/runs/13", conclusion: "timed_out" }] });
const JOBS = (id: number) => JSON.stringify({ jobs: [{ id: id * 10, name: `job ${id}`, conclusion: "failure", steps: [{ name: "late", conclusion: "failure", number: 3 }, { name: "early", conclusion: "failure", number: 2 }] }, { id: id * 10 + 1, name: "fine", conclusion: "success" }] });

function queueScript(overrides: Partial<Record<"runs" | "jobs", Say>> = {}): Script {
  return (args) => {
    const call = args.join(" ");
    if (call.includes("/actions/runs?event=merge_group")) return overrides.runs ?? RUNS;
    const run = /actions\/runs\/(\d+)\/jobs/.exec(call);
    if (run !== null) return overrides.jobs ?? JOBS(Number(run[1]));
    throw new Error(`unscripted: ${call}`);
  };
}

test("A11-395: readQueueFailureAsync reads the merge group's runs and each failed run's jobs, one run at a time, as readQueueFailure does", async () => {
  const run = await sameOver(queueScript(), (gh) => readQueueFailure(PULL, SHA, gh), (gh) => readQueueFailureAsync(PULL, SHA, gh), 3);
  assert.deepEqual((run.value as { jobs: { name: string }[] }).jobs.map((job) => job.name), ["job 11", "job 13"], "the failed runs' failed jobs, in order");
});

test("A11-395: readQueueFailureAsync answers null where readQueueFailure does: no pull request, no commit, no run, a refused read, a shape it does not know", async () => {
  await sameOver(queueScript(), (gh) => readQueueFailure("https://example.com/x", SHA, gh), (gh) => readQueueFailureAsync("https://example.com/x", SHA, gh), 0);
  await sameOver(queueScript(), (gh) => readQueueFailure(PULL, "not-a-commit", gh), (gh) => readQueueFailureAsync(PULL, "not-a-commit", gh), 0);
  await sameOver(queueScript({ runs: JSON.stringify({ workflow_runs: [] }) }), (gh) => readQueueFailure(PULL, SHA, gh), (gh) => readQueueFailureAsync(PULL, SHA, gh));
  await sameOver(queueScript({ runs: REFUSED }), (gh) => readQueueFailure(PULL, SHA, gh), (gh) => readQueueFailureAsync(PULL, SHA, gh));
  const jobsRefused = await sameOver(queueScript({ jobs: REFUSED }), (gh) => readQueueFailure(PULL, SHA, gh), (gh) => readQueueFailureAsync(PULL, SHA, gh), 2);
  assert.equal(jobsRefused.value, null, "a refused read of the jobs is no reading of the failure");
  await sameOver(queueScript({ jobs: JSON.stringify({ jobs: "none" }) }), (gh) => readQueueFailure(PULL, SHA, gh), (gh) => readQueueFailureAsync(PULL, SHA, gh), 2);
});

function holdScript(overrides: Partial<Record<"label" | "put" | "delete", Say>> = {}, labels: readonly string[] = ["hold:board"]): Script {
  return (args) => {
    const call = args.join(" ");
    if (call.startsWith("label create")) return overrides.label ?? "";
    if (call.includes("-X POST")) return overrides.put ?? "[]";
    if (call.includes("-X DELETE")) return overrides.delete ?? "";
    if (call.includes("/labels?per_page")) return JSON.stringify(labels.map((name) => ({ name })));
    throw new Error(`unscripted: ${call}`);
  };
}

test("A11-395: holdPullRequestAsync makes the label, puts it on and reads the labels back, as holdPullRequest does", async () => {
  const held = await sameOver(holdScript(), (gh) => holdPullRequest(PULL, gh), (gh) => holdPullRequestAsync(PULL, gh), 3);
  assert.equal(held.value, true);
  const missing = await sameOver(holdScript({}, ["other"]), (gh) => holdPullRequest(PULL, gh), (gh) => holdPullRequestAsync(PULL, gh), 3);
  assert.equal(missing.value, false, "labels that do not include the hold read as not held");
});

test("A11-395: holdPullRequestAsync throws GitHub's first line for a refusal, and for an address that is no pull request, as holdPullRequest does", async () => {
  const refused = await sameOver(holdScript({ label: REFUSED }), (gh) => holdPullRequest(PULL, gh), (gh) => holdPullRequestAsync(PULL, gh));
  assert.equal(refused.threw, "HTTP 403: Resource not accessible by integration");
  assert.deepEqual(refused.calls.length, 1, "the label is not put on after the label could not be made");
  const address = await sameOver(holdScript(), (gh) => holdPullRequest("https://example.com/x", gh), (gh) => holdPullRequestAsync("https://example.com/x", gh), 0);
  assert.match(address.threw ?? "", /is not a GitHub pull request address/);
});

test("A11-395: releasePullRequestAsync takes the label off, finds it already gone as a label that is off, and throws any other refusal, as releasePullRequest does", async () => {
  const lifted = await sameOver(holdScript({}, []), (gh) => releasePullRequest(PULL, gh), (gh) => releasePullRequestAsync(PULL, gh), 2);
  assert.equal(lifted.value, true);
  const gone = await sameOver(holdScript({ delete: NOT_FOUND }, []), (gh) => releasePullRequest(PULL, gh), (gh) => releasePullRequestAsync(PULL, gh), 2);
  assert.equal(gone.value, true, "a label GitHub says is not there is a label that is off");
  const stays = await sameOver(holdScript({}, ["hold:board"]), (gh) => releasePullRequest(PULL, gh), (gh) => releasePullRequestAsync(PULL, gh), 2);
  assert.equal(stays.value, false, "labels that still hold it read as not lifted");
  const refused = await sameOver(holdScript({ delete: REFUSED }), (gh) => releasePullRequest(PULL, gh), (gh) => releasePullRequestAsync(PULL, gh));
  assert.equal(refused.threw, "HTTP 403: Resource not accessible by integration");
});

// default-branch-checks.ts -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const POLICY: CodeHostPolicy = corePolicy(() => ({ fields: "headRefOid,reviews", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));
const MAIN = (nodes: unknown[]) => JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main", target: { __typename: "Commit", oid: SHA, statusCheckRollup: { contexts: { nodes } } } } } } });
const CHECKS = [
  { __typename: "CheckRun", name: "build", conclusion: "FAILURE", startedAt: "2026-10-29T10:00:00Z", completedAt: "2026-10-29T10:05:00Z", detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/2" },
  { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", startedAt: "2026-10-29T10:00:00Z", completedAt: "2026-10-29T10:01:00Z", detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/3" },
];

test("A11-395: readDefaultBranchRedAsync reads the head of the default branch once and answers what readDefaultBranchRed does", async () => {
  const red = await sameOver(() => MAIN(CHECKS), (gh) => readDefaultBranchRed("owner/repo", gh, POLICY), (gh) => readDefaultBranchRedAsync("owner/repo", gh, POLICY));
  assert.deepEqual((red.value as { failing: string[] }).failing, ["build"]);
  await sameOver(() => MAIN([]), (gh) => readDefaultBranchRed("owner/repo", gh, POLICY), (gh) => readDefaultBranchRedAsync("owner/repo", gh, POLICY));
});

test("A11-395: readDefaultBranchRedAsync answers null where readDefaultBranchRed does: not owner/name, a refusal, no branch, a shape it does not know", async () => {
  await sameOver(() => MAIN(CHECKS), (gh) => readDefaultBranchRed("no-slash", gh, POLICY), (gh) => readDefaultBranchRedAsync("no-slash", gh, POLICY), 0);
  await sameOver(() => REFUSED, (gh) => readDefaultBranchRed("owner/repo", gh, POLICY), (gh) => readDefaultBranchRedAsync("owner/repo", gh, POLICY));
  await sameOver(() => JSON.stringify({ data: { repository: { defaultBranchRef: null } } }), (gh) => readDefaultBranchRed("owner/repo", gh, POLICY), (gh) => readDefaultBranchRedAsync("owner/repo", gh, POLICY));
  await sameOver(() => "not json", (gh) => readDefaultBranchRed("owner/repo", gh, POLICY), (gh) => readDefaultBranchRedAsync("owner/repo", gh, POLICY));
});

// merge-flow.ts ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const NODE = (name: string, over: Record<string, unknown> = {}) => ({ name, isArchived: false, autoMergeAllowed: true, isPrivate: false, defaultBranchRef: { name: "main" }, object: { __typename: "Blob" }, bot: null, rulesets: { nodes: [] }, ...over });
const PAGE = (nodes: unknown[], next: string | null) => JSON.stringify({ data: { organization: { repositories: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } });

test("A11-395: readOrganisationFlowsAsync lists an organisation page by page, as readOrganisationFlows does", async () => {
  const pages: Script = (args) => (args.join(" ").includes('after: "c1"') ? PAGE([NODE("two", { isArchived: true })], null) : PAGE([NODE("one")], "c1"));
  const listed = await sameOver(pages, (gh) => readOrganisationFlows("owner", gh), (gh) => readOrganisationFlowsAsync("owner", gh), 2);
  assert.deepEqual((listed.value as { repository: string }[]).map(({ repository }) => repository), ["owner/one", "owner/two"]);
});

test("A11-395: a cursor that happens to read 'end' is a cursor: both forms go on to the next page", async () => {
  const pages: Script = (args) => (args.join(" ").includes('after: "end"') ? PAGE([NODE("two")], null) : PAGE([NODE("one")], "end"));
  const listed = await sameOver(pages, (gh) => readOrganisationFlows("owner", gh), (gh) => readOrganisationFlowsAsync("owner", gh), 2);
  assert.deepEqual((listed.value as { repository: string }[]).map(({ repository }) => repository), ["owner/one", "owner/two"]);
});

test("A11-395: readOrganisationFlowsAsync answers 'not an organisation' and null where readOrganisationFlows does", async () => {
  const person: Say = JSON.stringify({ data: { organization: null } });
  const notOrganisation = await sameOver(() => person, (gh) => readOrganisationFlows("owner", gh), (gh) => readOrganisationFlowsAsync("owner", gh));
  assert.equal(notOrganisation.value, "not an organisation");
  await sameOver(() => ({ fail: "HTTP 502" }), (gh) => readOrganisationFlows("owner", gh), (gh) => readOrganisationFlowsAsync("owner", gh));
  await sameOver(() => PAGE([{ isArchived: false }], null), (gh) => readOrganisationFlows("owner", gh), (gh) => readOrganisationFlowsAsync("owner", gh));
  await sameOver(() => PAGE([NODE("one")], "c1"), (gh) => readOrganisationFlows("owner", gh), (gh) => readOrganisationFlowsAsync("owner", gh), 5);
  await sameOver(() => "{}", (gh) => readOrganisationFlows("a/b", gh), (gh) => readOrganisationFlowsAsync("a/b", gh), 0);
});

test("A11-395: readRepositoryFlowsAsync reads the named repositories in one call, as readRepositoryFlows does", async () => {
  const answer: Script = () => JSON.stringify({ data: { r0: NODE("one"), r1: null } });
  const flows = await sameOver(answer, (gh) => readRepositoryFlows(["owner/one", "owner/two", "not-named"], gh), (gh) => readRepositoryFlowsAsync(["owner/one", "owner/two", "not-named"], gh));
  assert.equal(flows.calls.length, 1);
  assert.equal((flows.value as Record<string, unknown>)["owner/two"], null);
  await sameOver(() => REFUSED, (gh) => readRepositoryFlows(["owner/one"], gh), (gh) => readRepositoryFlowsAsync(["owner/one"], gh));
  await sameOver(() => REFUSED, (gh) => readRepositoryFlows(["no-slash"], gh), (gh) => readRepositoryFlowsAsync(["no-slash"], gh), 0);
});

// closed-work.ts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const CLOSED = JSON.stringify({ number: 7, state: "CLOSED", baseRefName: "main", headRefName: "feature", headRefOid: SHA });
const COMPARE = 'T 2\nC {"sha":"s1","subject":"one"}\nC {"sha":"s2","subject":"two"}\nF "a.ts"\nF "b.ts"\n';

function closedScript(overrides: Partial<Record<"pull" | "compare", Say>> = {}): Script {
  return (args) => (args[0] === "pr" ? overrides.pull ?? CLOSED : overrides.compare ?? COMPARE);
}

test("A11-395: readClosedWorkAsync reads the pull request, then the compare against its head commit, as readClosedWork does", async () => {
  const work = await sameOver(closedScript(), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh), 2);
  assert.deepEqual((work.value as { files: string[] }).files, ["a.ts", "b.ts"]);
  await sameOver(closedScript({ compare: "T 0\n" }), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh), 2);
});

test("A11-395: readClosedWorkAsync answers null where readClosedWork does: an open pull request, a compare cut short, a refusal, a line it cannot read, a stray address", async () => {
  await sameOver(closedScript({ pull: JSON.stringify({ ...JSON.parse(CLOSED), state: "OPEN" }) }), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh));
  await sameOver(closedScript({ compare: "T 3\nC {\"sha\":\"s1\",\"subject\":\"one\"}\n" }), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh), 2);
  await sameOver(closedScript({ pull: REFUSED }), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh));
  await sameOver(closedScript({ compare: REFUSED }), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh), 2);
  await sameOver(closedScript({ compare: "X what\n" }), (gh) => readClosedWork(PULL, gh), (gh) => readClosedWorkAsync(PULL, gh), 2);
  await sameOver(closedScript(), (gh) => readClosedWork("https://example.com/x", gh), (gh) => readClosedWorkAsync("https://example.com/x", gh), 0);
});

// ticket-pulls.ts --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const FOUND = (title: string, body: string, state = "open") => ({ url: `https://github.com/owner/repo/pull/${title.length}`, repository: { nameWithOwner: "owner/repo" }, state, title, body });

test("A11-395: pullsNamingAsync searches once and narrows to the pull requests that name the key, as pullsNaming does", async () => {
  const search: Script = () => JSON.stringify([FOUND("fix A11-395", ""), FOUND("A11-3950 other", "", "merged"), FOUND("unrelated", "Refs a11-395 in the body", "closed")]);
  const found = await sameOver(search, (gh) => pullsNaming("A11-395", ["owner/repo", "owner/other"], gh), (gh) => pullsNamingAsync("A11-395", ["owner/repo", "owner/other"], gh));
  assert.equal((found.value as unknown[]).length, 2, "a longer key is not the key");
  const none = await sameOver(search, (gh) => pullsNaming("A11-395", [], gh), (gh) => pullsNamingAsync("A11-395", [], gh), 0);
  assert.deepEqual(none.value, []);
});

test("A11-395: pullsNamingAsync answers null where pullsNaming does: a refusal, a list at the limit, a state it does not know, an answer that is no list", async () => {
  await sameOver(() => REFUSED, (gh) => pullsNaming("A11-395", ["owner/repo"], gh), (gh) => pullsNamingAsync("A11-395", ["owner/repo"], gh));
  await sameOver(() => JSON.stringify(Array.from({ length: 100 }, (_, n) => FOUND(`A11-395 ${n}`, ""))), (gh) => pullsNaming("A11-395", ["owner/repo"], gh), (gh) => pullsNamingAsync("A11-395", ["owner/repo"], gh));
  await sameOver(() => JSON.stringify([FOUND("A11-395", "", "draft")]), (gh) => pullsNaming("A11-395", ["owner/repo"], gh), (gh) => pullsNamingAsync("A11-395", ["owner/repo"], gh));
  await sameOver(() => "{}", (gh) => pullsNaming("A11-395", ["owner/repo"], gh), (gh) => pullsNamingAsync("A11-395", ["owner/repo"], gh));
});

// stack-merge.ts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const STACK_PULL = (over: Record<string, unknown> = {}) => JSON.stringify({ stack: { number: 3 }, base: { ref: "feature/base", repo: { default_branch: "main" } }, head: { sha: SHA }, ...over });
const REFUSAL_COMMENT = JSON.stringify(`<!-- agent-org:stack-merge head=${SHA} -->\nGitHub refused the stack merge of #7: not mergeable`);

function stackScript(pull: Say, armed: Say = JSON.stringify({ merged: false, autoMergeRequest: null, mergeQueueEntry: null }), comments: Say = `${REFUSAL_COMMENT}\n`): Script {
  return (args) => (args.includes("graphql") ? armed : args.some((arg) => arg.endsWith("/comments")) ? comments : pull);
}

test("A11-395: stackMergeFactsOfAsync reads a stacked, open pull request's queue seat and arm bot comments in the order stackMergeFactsOf does", async () => {
  const open = await sameOver(stackScript(STACK_PULL()), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 3);
  assert.deepEqual((open.value as { settled: unknown; refusal: unknown }).refusal, { head: SHA, reason: "not mergeable" });
  const queued = await sameOver(stackScript(STACK_PULL(), JSON.stringify({ merged: false, mergeQueueEntry: { state: "QUEUED" } }), ""), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 3);
  assert.equal((queued.value as { settled: unknown }).settled, "queued");
});

test("A11-395: stackMergeFactsOfAsync stops reading where stackMergeFactsOf does: a pull request that is merged, one not in a stack, one the queue says is merged", async () => {
  const merged = await sameOver(stackScript(STACK_PULL({ merged: true })), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 1);
  assert.equal(merged.calls.length, 1);
  const alone = await sameOver(stackScript(STACK_PULL({ stack: null })), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 1);
  assert.equal(alone.calls.length, 1);
  const landed = await sameOver(stackScript(STACK_PULL(), JSON.stringify({ merged: true })), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 2);
  assert.deepEqual([landed.calls.length, (landed.value as { settled: unknown }).settled], [2, "merged"], "the comments are not read of a pull request the queue merged");
});

test("A11-395: stackMergeFactsOfAsync answers null where stackMergeFactsOf does: a refusal at any of the three reads, an answer that names no base, a stray address", async () => {
  await sameOver(stackScript(REFUSED), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh));
  await sameOver(stackScript(STACK_PULL(), REFUSED), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 2);
  await sameOver(stackScript(STACK_PULL(), undefined, REFUSED), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 3);
  await sameOver(stackScript(STACK_PULL(), "null"), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh), 2);
  await sameOver(stackScript(JSON.stringify({ stack: null })), (gh) => stackMergeFactsOf(PULL, gh), (gh) => stackMergeFactsOfAsync(PULL, gh));
  await sameOver(stackScript(STACK_PULL()), (gh) => stackMergeFactsOf("https://example.com/x", gh), (gh) => stackMergeFactsOfAsync("https://example.com/x", gh), 0);
});

test("A11-395: requestStackMergeAsync dispatches the arm bot's job, and throws GitHub's first line for a refusal, as requestStackMerge does", async () => {
  const request = { repo: "owner/repo", number: 7 };
  await sameOver(() => "", (gh) => requestStackMerge(request, gh), (gh) => requestStackMergeAsync(request, gh));
  const refused = await sameOver(() => REFUSED, (gh) => requestStackMerge(request, gh), (gh) => requestStackMergeAsync(request, gh));
  assert.equal(refused.threw, "HTTP 403: Resource not accessible by integration");
});

// ci-run.ts, check-runs.ts, rerun-runs.ts ---------------------------------------------------------------------------------------------------------------------------------------------------------

const RUN = (over: Record<string, unknown> = {}) => JSON.stringify({ status: "completed", conclusion: "success", url: "https://github.com/owner/repo/actions/runs/9", name: "ci", jobs: [{ status: "completed" }, { status: "in_progress" }], ...over });

test("A11-395: readCiRunAsync reads a run and answers null where readCiRun does", async () => {
  const done = await sameOver(() => RUN(), (gh) => readCiRun("owner/repo", 9, gh), (gh) => readCiRunAsync("owner/repo", 9, gh));
  assert.deepEqual((done.value as { jobs: unknown }).jobs, { done: 1, total: 2 });
  const waiting = await sameOver(() => RUN({ status: "waiting", conclusion: "" }), (gh) => readCiRun("owner/repo", 9, gh), (gh) => readCiRunAsync("owner/repo", 9, gh));
  assert.equal((waiting.value as { status: string }).status, "queued");
  await sameOver(() => RUN({ status: "completed", conclusion: "" }), (gh) => readCiRun("owner/repo", 9, gh), (gh) => readCiRunAsync("owner/repo", 9, gh));
  await sameOver(() => RUN({ status: "strange" }), (gh) => readCiRun("owner/repo", 9, gh), (gh) => readCiRunAsync("owner/repo", 9, gh));
  await sameOver(() => REFUSED, (gh) => readCiRun("owner/repo", 9, gh), (gh) => readCiRunAsync("owner/repo", 9, gh));
});

const JOB_URL = "https://github.com/owner/repo/actions/runs/5/job/6";

test("A11-395: readCheckLogAsync reads the log of the job an address names, and logs why it could not, as readCheckLog does", async () => {
  const lines: string[] = [];
  const asyncLines: string[] = [];
  const log = await sameOver(() => "line one\nline two", (gh) => readCheckLog(JOB_URL, gh, (line) => lines.push(line)), (gh) => readCheckLogAsync(JOB_URL, gh, (line) => asyncLines.push(line)));
  assert.equal(log.value, "line one\nline two");
  assert.deepEqual([lines, asyncLines], [[], []]);
  lines.length = 0;
  const refused = await sameOver(() => REFUSED, (gh) => readCheckLog(JOB_URL, gh, (line) => lines.push(line)), (gh) => readCheckLogAsync(JOB_URL, gh, (line) => asyncLines.push(line)));
  assert.equal(refused.value, null);
  assert.deepEqual(asyncLines, lines, "the same reason is logged");
  assert.equal(lines.length, 1);
  await sameOver(() => "x", (gh) => readCheckLog("https://github.com/owner/repo/runs/1", gh, () => undefined), (gh) => readCheckLogAsync("https://github.com/owner/repo/runs/1", gh, () => undefined), 0);
});

const JOB_URLS = [JOB_URL, "https://github.com/owner/repo/actions/runs/5/job/7", "https://github.com/owner/other/actions/runs/8/job/9", "https://github.com/owner/repo/runs/1"];

test("A11-395: rerunFailedChecksAsync reruns each run once, in order, and stops at the first refusal, as rerunFailedChecks does", async () => {
  const rerun = await sameOver(() => "", (gh) => rerunFailedChecks(JOB_URLS, gh), (gh) => rerunFailedChecksAsync(JOB_URLS, gh), 2);
  assert.deepEqual([rerun.value, rerun.calls.length], [null, 2], "the two runs the addresses name, and none for the address that names no job");
  const stopped = await sameOver((args) => (args[2] === "5" ? REFUSED : ""), (gh) => rerunFailedChecks(JOB_URLS, gh), (gh) => rerunFailedChecksAsync(JOB_URLS, gh), 1);
  assert.deepEqual([stopped.value, stopped.calls.length], ["Command failed: gh run rerun 5 --failed -R owner/repo", 1], "the first line of the refusal, and the second run is not asked after the first was refused");
});

test("A11-395: rerunRunsAsync reruns each whole run once, in order, and stops at the first refusal, as rerunRuns does", async () => {
  const rerun = await sameOver(() => "", (gh) => rerunRuns(JOB_URLS, gh), (gh) => rerunRunsAsync(JOB_URLS, gh), 2);
  assert.ok(rerun.calls.every((call) => !call.includes("--failed")), "the whole run, not its failed jobs");
  const stopped = await sameOver((args) => (args[2] === "5" ? REFUSED : ""), (gh) => rerunRuns(JOB_URLS, gh), (gh) => rerunRunsAsync(JOB_URLS, gh), 1);
  assert.equal(stopped.calls.length, 1);
  const none = await sameOver(() => "", (gh) => rerunRuns([], gh), (gh) => rerunRunsAsync([], gh), 0);
  assert.equal(none.value, null);
});

// update-branch.ts, close-pull.ts -----------------------------------------------------------------------------------------------------------------------------------------------------------------

test("A11-395: updateBranchAsync answers updated, conflict, up-to-date and refused as updateBranch does", async () => {
  const updated = await sameOver(() => "{}", (gh) => updateBranch(PULL, SHA, gh), (gh) => updateBranchAsync(PULL, SHA, gh));
  assert.deepEqual(updated.value, { kind: "updated" });
  const conflict = await sameOver(() => ({ fail: "gh: merge conflict between base and head (HTTP 422)" }), (gh) => updateBranch(PULL, SHA, gh), (gh) => updateBranchAsync(PULL, SHA, gh));
  assert.deepEqual(conflict.value, { kind: "conflict" });
  const current = await sameOver(() => ({ fail: "gh: There are no new commits on the base branch. (HTTP 422)" }), (gh) => updateBranch(PULL, SHA, gh), (gh) => updateBranchAsync(PULL, SHA, gh));
  assert.deepEqual(current.value, { kind: "up-to-date" });
  const refused = await sameOver(() => REFUSED, (gh) => updateBranch(PULL, SHA, gh), (gh) => updateBranchAsync(PULL, SHA, gh));
  assert.deepEqual(refused.value, { kind: "refused", reason: "HTTP 403: Resource not accessible by integration" });
  const stray = await sameOver(() => "{}", (gh) => updateBranch("https://example.com/x", SHA, gh), (gh) => updateBranchAsync("https://example.com/x", SHA, gh), 0);
  assert.deepEqual(stray.value, { kind: "refused", reason: "https://example.com/x is not a GitHub pull request address" });
});

test("A11-395: closePullAsync closes first and comments after, leaves a refused comment unsaid and throws a refused close, as closePull does", async () => {
  const closed = await sameOver(() => "{}", (gh) => closePull(PULL, "closed by agent-org", gh), (gh) => closePullAsync(PULL, "closed by agent-org", gh), 2);
  assert.deepEqual(closed.calls.map((call) => /-X (\w+)/.exec(call)?.[1]), ["PATCH", "POST"], "the close comes before the comment");
  const uncommented = await sameOver((args) => (args.includes("POST") ? REFUSED : "{}"), (gh) => closePull(PULL, "c", gh), (gh) => closePullAsync(PULL, "c", gh), 2);
  assert.equal(uncommented.threw, undefined, "a pull request closed without its comment is closed");
  const refused = await sameOver(() => REFUSED, (gh) => closePull(PULL, "c", gh), (gh) => closePullAsync(PULL, "c", gh), 1);
  assert.deepEqual([refused.threw, refused.calls.length], ["HTTP 403: Resource not accessible by integration", 1], "no comment is posted on a pull request that stayed open");
  const stray = await sameOver(() => "{}", (gh) => closePull("https://example.com/x", "c", gh), (gh) => closePullAsync("https://example.com/x", "c", gh), 0);
  assert.match(stray.threw ?? "", /is not a GitHub pull request address/);
});

test("A11-395: commentOnPullAsync posts one comment, and throws GitHub's first line for a refusal and for a stray address, as commentOnPull does", async () => {
  const posted = await sameOver(() => "{}", (gh) => commentOnPull(PULL, "hello", gh), (gh) => commentOnPullAsync(PULL, "hello", gh));
  assert.equal(posted.threw, undefined);
  const refused = await sameOver(() => REFUSED, (gh) => commentOnPull(PULL, "hello", gh), (gh) => commentOnPullAsync(PULL, "hello", gh));
  assert.equal(refused.threw, "HTTP 403: Resource not accessible by integration");
  const stray = await sameOver(() => "{}", (gh) => commentOnPull("https://example.com/x", "hello", gh), (gh) => commentOnPullAsync("https://example.com/x", "hello", gh), 0);
  assert.match(stray.threw ?? "", /is not a GitHub pull request address/);
});
