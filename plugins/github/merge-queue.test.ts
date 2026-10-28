// no-token: gh -- the reads and writes are handed a stub `gh` that answers what GitHub answered for a11ign/announcement-emulator#18 (A11-232) on 2026-10-25; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import { GhFailure } from "./gh.ts";
import { HOLD_LABEL, holdPullRequest, readQueueFailure, releasePullRequest } from "./merge-queue.ts";
import { readPullFeedback } from "./pull-feedback.ts";

const REPO = "a11ign/announcement-emulator";
const URL = `https://github.com/${REPO}/pull/18`;
const HEAD = "c3f2b457e09fb02e0e46763028d538694c498674";
/** The merge groups the queue removed the pull request from, as the timeline's `beforeCommit` names them: each is the `head_sha` of one `merge_group` run. */
const GROUPS = ["3a79176dacf2b6c34571d8c490daf1cb946dee88", "a2aa4d8cc7e64b33c6946186251f6c881f8bced8", "79fda13836b308534d7d3672e7cc859d75bad1f3"];
const LAST_RUN = 40192667644;

/** The timeline GitHub gave for the pull request at head `c3f2b457`: three commits, then three removals for failed checks by the merge queue (recorded 2026-10-25). */
const removal = (createdAt: string, oid: string, over: Record<string, unknown> = {}) =>
  ({ __typename: "RemovedFromMergeQueueEvent", createdAt, reason: "failed_checks", actor: { login: "github-merge-queue" }, beforeCommit: { oid }, ...over });
const RECORDED = [{ __typename: "PullRequestCommit" }, { __typename: "PullRequestCommit" }, { __typename: "PullRequestCommit" },
  removal("2026-10-25T11:59:08Z", GROUPS[0]), removal("2026-10-25T12:19:35Z", GROUPS[1]), removal("2026-10-25T12:21:15Z", GROUPS[2])];

/** The feedback read of the pull request, over a timeline and a queue entry. */
async function read(nodes: unknown, entry: unknown = null) {
  const pr = { state: "OPEN", headRefOid: HEAD, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "main", mergeQueueEntry: entry,
    ...(nodes === undefined ? {} : { timelineItems: { nodes } }), files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, reviews: { nodes: [] }, comments: { nodes: [] },
    reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] } };
  const calls: string[][] = [];
  const feedback = await readPullFeedback(URL, "worker-bot", async (args) => { calls.push(args); return JSON.stringify({ data: { repository: { pullRequest: pr } } }); }, corePolicy());
  return { feedback, calls };
}

test("A11-264: the removals since the head last moved are read from the one query the watch makes, with their reason, actor and merge group", async () => {
  const { feedback, calls } = await read(RECORDED);
  assert.deepEqual(feedback?.queue, { queued: false, removals: [
    { at: Date.parse("2026-10-25T11:59:08Z"), reason: "failed_checks", actor: "github-merge-queue", groupCommit: GROUPS[0] },
    { at: Date.parse("2026-10-25T12:19:35Z"), reason: "failed_checks", actor: "github-merge-queue", groupCommit: GROUPS[1] },
    { at: Date.parse("2026-10-25T12:21:15Z"), reason: "failed_checks", actor: "github-merge-queue", groupCommit: GROUPS[2] },
  ] });
  assert.equal(calls.length, 1, "no call beyond the one the watch already made");
  const query = calls[0].find((arg) => arg.startsWith("query="))!;
  assert.match(query, /mergeQueueEntry \{ state \}/);
  assert.match(query, /itemTypes: \[REMOVED_FROM_MERGE_QUEUE_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT\]/);
  assert.match(query, /on RemovedFromMergeQueueEvent \{ createdAt reason actor \{ login \} beforeCommit \{ oid \} \}/);
});

test("A11-264: a commit or a force-push ends the run of removals, so only the ones since the head last moved are listed", async () => {
  const pushed = async (type: string) => (await read([...RECORDED, { __typename: type }])).feedback?.queue;
  assert.deepEqual(await pushed("PullRequestCommit"), { queued: false, removals: [] }, "a commit after the removals");
  assert.deepEqual(await pushed("HeadRefForcePushedEvent"), { queued: false, removals: [] }, "a force-push after them");
  const before = (await read([removal("2026-10-25T10:00:00Z", "f".repeat(40)), { __typename: "PullRequestCommit" }, ...RECORDED.slice(3)])).feedback?.queue;
  assert.equal(before?.removals.length, 3, "a removal before the last commit is not counted");
});

test("A11-264: a pull request in the queue now is queued, and an answer with no timeline says nothing of the queue, which is not no removals", async () => {
  assert.equal((await read(RECORDED, { state: "QUEUED" })).feedback?.queue?.queued, true);
  assert.equal((await read(RECORDED, null)).feedback?.queue?.queued, false);
  assert.equal((await read(undefined)).feedback?.queue, undefined, "no timeline: the host did not say");
  assert.deepEqual((await read([])).feedback?.queue, { queued: false, removals: [] }, "an empty timeline is a host that said there were none");
});

test("A11-264: a removal keeps the host's own reason, a person's name as its actor, and no merge group when GitHub names none", async () => {
  const { feedback } = await read([{ __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-10-25T13:00:00Z", reason: "manual", actor: { login: "a-person" }, beforeCommit: null },
    { __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-10-25T13:05:00Z", reason: "merge_conflict", actor: null, beforeCommit: { oid: GROUPS[0] } }]);
  assert.deepEqual(feedback?.queue?.removals.map(({ reason, actor, groupCommit }) => [reason, actor, groupCommit]), [["manual", "a-person", null], ["merge_conflict", null, GROUPS[0]]]);
});

// The `merge_group` run of the last removal and its jobs, as GitHub answered them (recorded 2026-10-25): `middleware` failed at the step that checks the Dependabot config, and the roll-up `gate` failed behind it.
const RUNS = { workflow_runs: [{ id: LAST_RUN, html_url: `https://github.com/${REPO}/actions/runs/${LAST_RUN}`, conclusion: "failure", event: "merge_group", head_sha: GROUPS[2], name: "ci" }] };
const JOBS = { jobs: [
  { id: 121166812239, name: "middleware", conclusion: "failure", steps: [{ name: "Set up job", number: 1, conclusion: "success" }, { name: "Run pnpm install --frozen-lockfile", number: 5, conclusion: "success" },
    { name: "The Dependabot config is what the toolchain generates", number: 6, conclusion: "failure" }, { name: "Run pnpm run build", number: 7, conclusion: "skipped" }] },
  { id: 121166812419, name: "python", conclusion: "success", steps: [{ name: "Set up job", number: 1, conclusion: "success" }] },
  { id: 121166918201, name: "gate", conclusion: "failure", steps: [{ name: "Set up job", number: 1, conclusion: "success" }, { name: "Every job ran, and ran clean", number: 2, conclusion: "failure" }] },
] };

/** A `gh` that answers the run and its jobs, and records each call. */
function ghAnswering(runs: unknown = RUNS, jobs: unknown = JOBS) {
  const calls: string[][] = [];
  return { calls, gh: (args: string[]) => { calls.push(args); return JSON.stringify(args[1].includes("/jobs") ? jobs : runs); } };
}

test("A11-264: the failing run is found by the merge group's commit, and every job of it that failed is listed with its first failing step", () => {
  const { gh, calls } = ghAnswering();
  assert.deepEqual(readQueueFailure(URL, GROUPS[2], gh), { runId: LAST_RUN, runUrl: `https://github.com/${REPO}/actions/runs/${LAST_RUN}`, jobs: [
    { name: "middleware", step: "The Dependabot config is what the toolchain generates", detailsUrl: `https://github.com/${REPO}/actions/runs/${LAST_RUN}/job/121166812239` },
    { name: "gate", step: "Every job ran, and ran clean", detailsUrl: `https://github.com/${REPO}/actions/runs/${LAST_RUN}/job/121166918201` },
  ] });
  assert.deepEqual(calls, [["api", `repos/${REPO}/actions/runs?event=merge_group&head_sha=${GROUPS[2]}&per_page=100`], ["api", `repos/${REPO}/actions/runs/${LAST_RUN}/jobs?filter=latest&per_page=100`]]);
});

test("A11-264: a run that cannot be found, a commit that is no commit, an address that is no pull request and a refused read are null, never no failing job", () => {
  assert.equal(readQueueFailure(URL, GROUPS[0], ghAnswering({ workflow_runs: [] }).gh), null, "no run for that merge group");
  assert.equal(readQueueFailure(URL, GROUPS[2], ghAnswering({ message: "Not Found" }).gh), null, "an answer of another shape");
  assert.equal(readQueueFailure(URL, GROUPS[2], ghAnswering(RUNS, { message: "Not Found" }).gh), null, "jobs of another shape");
  const calls = ghAnswering();
  assert.equal(readQueueFailure(URL, "main", calls.gh), null, "a branch name is not a merge group's commit");
  assert.equal(readQueueFailure("https://github.com/a11ign/x/issues/3", GROUPS[2], calls.gh), null);
  assert.deepEqual(calls.calls, [], "and nothing was asked");
  assert.equal(readQueueFailure(URL, GROUPS[2], (args) => { throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: HTTP 403\n" }); }), null);
});

test("A11-264: a run that did not fail has no failing job, and a job that timed out is one", () => {
  const passed = { workflow_runs: [{ ...RUNS.workflow_runs[0], conclusion: "success" }] };
  assert.deepEqual(readQueueFailure(URL, GROUPS[2], ghAnswering(passed).gh)?.jobs, [], "the removal came from a run that did not fail: nothing is named");
  const timedOut = { jobs: [{ id: 5, name: "suite", conclusion: "timed_out", steps: [{ name: "Run pnpm test", number: 3, conclusion: "cancelled" }] }, { id: 6, name: "lint", conclusion: "cancelled", steps: [] }] };
  assert.deepEqual(readQueueFailure(URL, GROUPS[2], ghAnswering(RUNS, timedOut).gh)?.jobs.map(({ name, step }) => [name, step]), [["suite", null]], "a cancelled job is not a failure, and a job with no failing step has none named");
});

/** A `gh` for the hold: the labels it keeps are what the read-back lists, and each call is recorded. */
function labelling(over: { refuse?: (args: string[]) => string | null } = {}) {
  const labels: string[] = [];
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const refused = over.refuse?.(args) ?? null;
    if (refused !== null) throw new GhFailure(args, { status: 1, stdout: "", stderr: refused });
    if (args[0] === "api" && args.includes("POST")) labels.push(HOLD_LABEL);
    if (args[0] === "api" && args.includes("DELETE")) labels.splice(0, labels.length);
    return args[0] === "api" && args.length === 2 ? JSON.stringify(labels.map((name) => ({ name }))) : "[]";
  };
  return { gh, calls, labels };
}

test("A11-264: the hold makes the label first, puts it on the pull request, and reads the labels back", () => {
  const { gh, calls, labels } = labelling();
  assert.equal(holdPullRequest(URL, gh), true);
  assert.deepEqual(calls, [
    ["label", "create", "hold:board", "--force", "--description", calls[0][5], "--color", "d93f0b", "-R", REPO],
    ["api", "-X", "POST", `repos/${REPO}/issues/18/labels`, "-f", "labels[]=hold:board"],
    ["api", `repos/${REPO}/issues/18/labels?per_page=100`],
  ]);
  assert.match(calls[0][5], /three times on one head.*lifts it on the next push/);
  assert.deepEqual(labels, ["hold:board"]);
});

test("A11-264: lifting the hold deletes the label from the pull request, reads back, and counts a label that is not there as done", () => {
  const { gh, calls } = labelling();
  holdPullRequest(URL, gh);
  calls.length = 0;
  assert.equal(releasePullRequest(URL, gh), true);
  assert.deepEqual(calls, [["api", "-X", "DELETE", `repos/${REPO}/issues/18/labels/hold%3Aboard`], ["api", `repos/${REPO}/issues/18/labels?per_page=100`]]);
  const gone = labelling({ refuse: (args) => (args.includes("DELETE") ? "gh: Label does not exist (HTTP 404)\n" : null) });
  assert.equal(releasePullRequest(URL, gone.gh), true, "a label that was never on is off");
});

test("A11-264: a hold GitHub refuses throws in GitHub's first line, and a label that is not as asked on read-back is false", () => {
  const refused = labelling({ refuse: (args) => (args.includes("POST") ? "gh: Resource not accessible by integration (HTTP 403)\nsecond line\n" : null) });
  assert.throws(() => holdPullRequest(URL, refused.gh), { message: "gh: Resource not accessible by integration (HTTP 403)" });
  const stuck = labelling({ refuse: (args) => (args.includes("DELETE") ? "gh: Server Error (HTTP 500)\n" : null) });
  assert.throws(() => releasePullRequest(URL, stuck.gh), { message: "gh: Server Error (HTTP 500)" }, "a delete that fails for another reason than a missing label is a refusal");
  const ignored = (args: string[]) => (args[0] === "api" && args.length === 2 ? "[]" : "[]");
  assert.equal(holdPullRequest(URL, ignored), false, "the POST went through but the label is not on the pull request");
  assert.throws(() => holdPullRequest("https://github.com/a11ign/x/issues/3", labelling().gh), /is not a GitHub pull request address/);
});
