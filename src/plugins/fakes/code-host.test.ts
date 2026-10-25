// no-token: none -- the fake code host holds pull requests in memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodeHostConformance } from "../conformance/code-host.ts";
import { ContractError } from "../conformance/suite.ts";
import { DEPENDENCY_PULL_AUTHOR, type CodeHost, type WrapperInputs } from "../contracts/code-host.ts";
import { createFakeCodeHost, fakePullUrl, queueFailureKey } from "./code-host.ts";

/** The inputs a wrapper is asked about: a place outside any temporary directory, and the workers' role an App. */
const INPUTS: WrapperInputs = {
  place: { binDir: "/opt/host/bin", tool: "/opt/agent-org", checkout: "/opt/project", stateEntry: (name) => `/opt/state/${name}` }, accounts: { workers: "/opt/workers", leads: "/opt/leads" },
  identity: { scheduler: { mode: "user-accounts" }, workers: { mode: "github-apps", appId: "1", keyPath: "/opt/workers.pem" }, managers: { mode: "user-accounts" }, reviewer: { mode: "user-accounts" } },
};

/** The forms a checkout's `origin` takes for `owner/repo`, which the group maps to the one repository. */
const REMOTE = { urls: ["https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo"], repository: { name: "repo", fullName: "owner/repo" } };

function seeded() {
  const host = createFakeCodeHost("fake-worker");
  const { url, ref } = host.seedPull("owner/repo", 7, { feedback: { authors: ["a-person", "fake-worker"] } });
  const merged = host.seedPull("owner/repo", 8, { state: "merged", findings: { title: "feat: replay", number: 8, body: "What it found", sections: [{ file: "docs/spike.md", heading: "### Scripted replay", text: "Cookie dialogs drop pages." }] } });
  const check = { detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/2", log: "Error: the build failed" };
  host.checksAndClaims.logs.set(check.detailsUrl, `2026-10-22T10:00:00Z ${check.log}\n`);
  const claim = { repository: "owner/repo", head: "c".repeat(40), environment: { GH_CONFIG_DIR: "/opt/reviewer/gh" } };
  // A pull request in a stack with the arm bot's refusal on it, and a hand-back the fake refuses (contract 1.16).
  const stacked = host.seedPull("owner/repo", 9, { head: "d".repeat(40) });
  host.stackMerges.facts.set(stacked.url, { stacked: true, refusal: { head: "d".repeat(40), reason: "a member below has changes requested" } });
  host.stackMerges.requestRefusal = "Resource not accessible by integration (HTTP 403)";
  // A workflow run the fake holds, halfway through (contract 1.17).
  host.ciRuns.runs.set("owner/repo#31", { status: "in_progress", conclusion: null, url: "https://github.com/owner/repo/actions/runs/31", name: "ci", jobs: { done: 1, total: 3 } });
  // A pull request whose body names a ticket (contract 1.18), and one that does not.
  const named = host.seedPull("owner/repo", 10, { state: "merged", body: "Refs A11-240\n\nPartial: step 1 of 2: the first half" });
  host.seedPull("owner/repo", 11, { body: "Refs A11-2401" });
  // A pull request the dependency bot opened, and one a person opened with the same title (contract 1.19).
  const bot = host.seedPull("owner/repo", 12, { body: "Release notes", dependency: { title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", author: DEPENDENCY_PULL_AUTHOR } });
  const foreign = host.seedPull("owner/repo", 13, { dependency: { title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "someone/bump", author: "someone" } });
  // A pull request closed without merging that still holds two commits (contract 1.20).
  const closed = host.seedPull("owner/repo", 20, { state: "closed", closedWork: { branch: "admin/a11-229-x", commits: [{ sha: "e".repeat(40), subject: "feat: one" }, { sha: "f".repeat(40), subject: "feat: two" }], files: ["src/a.ts", "src/b.ts"] } });
  // The failing `merge_group` run behind a removal of pull request 7 from the merge queue (contract 1.21).
  const queueFailure = { groupCommit: "b".repeat(40), job: "middleware" };
  host.queues.failures.set(queueFailureKey(url, queueFailure.groupCommit), { runId: 55, runUrl: "https://github.com/owner/repo/actions/runs/55", jobs: [{ name: queueFailure.job, step: "The Dependabot config is what the toolchain generates", detailsUrl: "https://github.com/owner/repo/actions/runs/55/job/56" }] });
  const stackRefusal = { pull: stacked.url, head: "d".repeat(40), reason: "a member below has changes requested" };
  return { host, probe: { pull: url, repository: "owner/repo", missing: fakePullUrl("owner/repo", 999), self: "fake-worker", change: ref, wrapper: INPUTS, merged: merged.url, closed: closed.url, queueFailure, check, claim, remote: REMOTE, stackRefusal, stackRequestRefused: { repo: "owner/repo", number: 9 }, ciRun: { repository: "owner/repo", runId: 31 }, named: { key: "A11-240", repository: "owner/repo", url: named.url, state: "merged" as const }, dependency: { repository: "owner/repo", url: bot.url, foreign: foreign.url } } };
}

/**
 * The checks of the optional `rows` group that need a `run` to refuse: the fake's rows act on its own state and ignore `run`, so they are skipped with their reason and never counted as passed (contract 1.11).
 * The other four checks of the group run on the fake's rows and pass.
 */
const ROWS_CHECKS = [
  "a read the rows could not make answers null or throws, never an empty answer", "a write the rows could not make throws, so no caller reads it as done",
  "a read the rows could not make for arming, the merge guard and the queue throws, never an empty answer", "a write the rows could not make for arming, the merge and the queue throws, so no caller reads it as done",
  "a read the rows could not make for the work gate throws or answers null, never an empty answer", "a write the rows could not make for the work gate throws, so no caller reads it as done",
  "a read the rows could not make for wake throws or answers null, never an empty answer", "a write the rows could not make for wake throws, so no caller reads it as done",
  "a read the rows could not make for the claim throws or answers null, never an empty answer", "a write the rows could not make for the claim throws, so no caller reads it as done",
  "a read the rows could not make for the filing of rows throws or answers null, never an empty answer", "a write the rows could not make for the filing of rows throws, so no caller reads it as done",
  "a read the rows could not make for the claim's rules throws or answers null, never an empty answer", "a write the rows could not make for the claim's rules throws, so no caller reads it as done",
  "a read the rows could not make for the other claim and row files throws or answers null, never an empty answer", "a write the rows could not make for the other claim and row files throws, so no caller reads it as done",
  "a read the rows could not make for the board, the health and retro readings, the DORA reader and the trace throws, never an empty answer", "a write the rows could not make for the board throws, so no caller reads it as done",
  "an async read or write the rows could not make rejects, so no caller reads it as done",
  "a read the rows could not make for opening a pull request throws, never an empty answer", "a read the rows could not make for a hold answers null, never nobody holds it", "a read the rows could not make for the branch tools and the Stop hook throws, never an empty listing", "a write the rows could not make for a hold, the sweep and the daily post throws, so no caller reads it as done", "a read the rows could not make for the audit, the retro's stock count and the un-park throws, never an empty answer", "a write the rows could not make for the tick's heartbeat throws, so no caller reads it as done", "a read the rows could not make for the close of a merged pull request throws, never an empty answer", "a read the rows could not make for the checks on a row's claim throws, never an empty answer", "a write the rows could not make for the close of a merged pull request throws, so no caller reads it as done", "a read the rows could not make for the classes section throws, never an empty answer", "a write the rows could not make for the classes section throws, so no caller reads it as done", "an answer that is JSON and not a comment is never a comment's body", "a read the rows could not make for the trunk, the queue table and the red-trunk reading throws, never an empty answer", "a write the rows could not make for the trunk sweep throws, so no caller reads it as done", "a read the rows could not make for the read-only reporters throws, never an empty answer", "a read the rows could not make for the tool-version agreement, the host check and the review eval throws, never an empty answer",
];
const ROWS_PASSED = ["the rows are the operations row mode asks of the code host", "the rows' pure helpers answer as the callers that sweep approvals and fold pages expect",
  "the repository and job a check's details address names are read without asking the code host", "the GraphQL pool's probe is a list of arguments the caller sends through a runner of its own",
  "the rows' rules for arming answer as the callers that arm and guard expect"];

test("the fake code host passes the code host contract suite, and the checks that ran are the ones asserted", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, probe);
  assert.deepEqual(passed, [
    "shape", "readOwnLogin names the account or answers null", "repoViewArgs and repoCloneArgs name the repository they are asked about", "readPullFeedback reads a pull request", "readPullFeedback answers null for a pull request it cannot read", "readReplies answers a list of replies, and null for a pull request it cannot read",
    "readPullState names the state or answers null", "readReviewState reads the head, the reviews and whether the checks settled", "openPullUrlsOf lists a repository's open pull requests",
    "sweepRetargets keeps the note of a pull request it cannot read", "sweepRetargets with no pull requests has no notes",
    "readCheckLog answers null for an address that names no job", "rerunFailedChecks of no checks reruns nothing and says so", "readReviewClaims answers the entries of a head, or why it could not", "subscribe returns the function that cancels it",
    ...ROWS_PASSED,
    "readCheckLog reads the log behind a failing check", "a claim written on a head is read back from it", "the verdict door is a file the plugin ships, with the program that installs it",
    "readMergedFindings reads what a merged pull request found, and answers null for one it cannot read or that has not merged", "readClosedWork answers null for a pull request it cannot read or that is open, and reads what a closed one still held",
    "readDefaultBranchRed answers the checks failing on a default branch's head, and null for a repository it cannot read", "readQueueFailure answers null for what it cannot read, and reads the failing job behind a removal", "holdFromQueue puts the hold on a pull request and takes it off, and throws for one it cannot read", "updateBranch refuses an address that is no pull request, and never throws", "stackMergeFactsOf answers null for a pull request it cannot read, and says a pull request in no stack is not stacked", "stackMergeFactsOf reads the refusal of the stack merge that the arm bot left on a stacked pull request", "requestStackMerge throws when the request is refused, so no caller reads it as made", "readCiRun answers null for a run it cannot read", "readCiRun reads a workflow run's status, conclusion, address, name and jobs", "pullsNaming answers null for a repository it cannot read", "pullsNaming lists the pull requests that name a key, with their state", "openDependencyPulls answers null for a repository it cannot read", "openDependencyPulls lists the pull requests the dependency bot opened, and no one else's", "readOwners lists the account first, and readRepositories answers null for an owner it cannot ask about", "repositoryOfRemote names the repository of its own remote URLs, and of no other host's", "readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed",
    "the wrapper is an owned file its own text agrees with", "the wrapper keeps its own text, and writes it", "the wrapper answers whether each declared role mints",
  ]);
  assert.deepEqual(skipped.map(({ check }) => check), ROWS_CHECKS, "the fake's rows act on its own state, so a refused run is nothing to them");
  assert.ok(skipped.every(({ reason }) => /the code host has no rows that act through the caller's run \(contract 1\.10\)/.test(reason)));
});

test("without a change in the probe the port's reads are skipped with the reason, not passed", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, { ...probe, change: undefined });
  assert.deepEqual(skipped.map(({ check }) => check), [...ROWS_CHECKS, "readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed"]);
  assert.ok(skipped.filter(({ check }) => !ROWS_CHECKS.includes(check)).every(({ reason }) => /the probe names no change/.test(reason)));
  assert.ok(!passed.includes("armMerge arms the merge and says it is armed"));
});

test("without wrapper inputs in the probe the wrapper's checks are skipped with the reason, not passed", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, { ...probe, wrapper: undefined });
  assert.deepEqual(skipped.map(({ check }) => check), [...ROWS_CHECKS, "the wrapper is an owned file its own text agrees with", "the wrapper keeps its own text, and writes it", "the wrapper answers whether each declared role mints"]);
  assert.ok(skipped.filter(({ check }) => !ROWS_CHECKS.includes(check)).every(({ reason }) => /the code host has no wrapper or the probe names no inputs for one/.test(reason)));
  assert.ok(!passed.some((check) => check.startsWith("the wrapper")));
});

const STACK_CHECKS = ["stackMergeFactsOf reads the refusal of the stack merge that the arm bot left on a stacked pull request", "requestStackMerge throws when the request is refused, so no caller reads it as made"];

test("without a stacked pull request and a refused request in the probe the stack merge's two checks are skipped with the reason, not passed (contract 1.16)", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, { ...probe, stackRefusal: undefined, stackRequestRefused: undefined });
  assert.deepEqual(skipped.map(({ check }) => check).filter((check) => STACK_CHECKS.includes(check)), STACK_CHECKS);
  assert.ok(skipped.filter(({ check }) => STACK_CHECKS.includes(check)).every(({ reason }) => /the probe names no/.test(reason)));
  assert.ok(!passed.some((check) => STACK_CHECKS.includes(check)));
});

test("a code host that reads a pull request it cannot read as not stacked, drops a refusal, or swallows a refused request fails each by name", async () => {
  const { host, probe } = seeded();
  const failures = async (candidate: CodeHost) => runCodeHostConformance(candidate, probe).then(() => [], (error: unknown) => (error instanceof ContractError ? error.failures.map(({ check }) => check) : [String(error)]));
  const reads = host.stackMergeFactsOf!;
  assert.deepEqual(await failures({ ...host, stackMergeFactsOf: (url) => reads(url) ?? { stacked: false, base: "main", defaultBranch: "main", head: "x", settled: null, refusal: null } }),
    ["stackMergeFactsOf answers null for a pull request it cannot read, and says a pull request in no stack is not stacked"]);
  assert.deepEqual(await failures({ ...host, stackMergeFactsOf: (url) => (reads(url) === null ? null : { ...reads(url)!, refusal: null }) }), [STACK_CHECKS[0]]);
  assert.deepEqual(await failures({ ...host, requestStackMerge: () => undefined }), [STACK_CHECKS[1]]);
});

test("a wrapper that refuses to write its own text fails by name", async () => {
  const { host, probe } = seeded();
  host.wrapperState.refusal = "no";
  await assert.rejects(runCodeHostConformance(host, probe), (error: unknown) => error instanceof ContractError && error.failures.map(({ check }) => check).join() === "the wrapper keeps its own text, and writes it");
});

test("a wrapper that answers an empty reason for a role that cannot mint fails by name", async () => {
  const { host, probe } = seeded();
  host.wrapperState.mintFailures.workers = "";
  await assert.rejects(runCodeHostConformance(host, probe), (error: unknown) => error instanceof ContractError && error.failures.map(({ check }) => check).join() === "the wrapper answers whether each declared role mints");
});

test("the fake's wrapper is stale when the installed text is not its own, and says what the roles are", () => {
  const { host } = seeded();
  const { wrapper } = host;
  const { target, expected } = wrapper!.file(INPUTS);
  assert.equal(target, "/opt/host/bin/gh");
  assert.deepEqual(wrapper!.appRoles(INPUTS), ["workers"]);
  assert.equal(wrapper!.identityStale(INPUTS, expected!), false);
  assert.equal(wrapper!.identityStale(INPUTS, "#!/bin/sh\n"), true);
  assert.equal(wrapper!.divergence(INPUTS, { target, installed: "#!/bin/sh\n" }), "/opt/host/bin/gh is not the fake's wrapper");
  assert.equal(wrapper!.divergence(INPUTS, { target, installed: null }), "there is no gh wrapper at /opt/host/bin/gh");
});

test("the fake leaves out what the caller's own login wrote, as the contract says", () => {
  const { host, probe } = seeded();
  assert.deepEqual(host.readPullFeedback(probe.pull, "fake-worker")?.authors, ["a-person"]);
  assert.deepEqual(host.readPullFeedback(probe.pull, "someone-else")?.authors, ["a-person", "fake-worker"]);
});

test("a code host that answers an empty reading for a pull request it cannot read fails by name", async () => {
  const { host, probe } = seeded();
  const lying: CodeHost = { ...host, readPullFeedback: (url, self) => host.readPullFeedback(url, self) ?? { state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: false, head: null, approvedAtHead: false, base: null, files: [], filesComplete: true } };
  await assert.rejects(runCodeHostConformance(lying, probe), (error: unknown) => error instanceof ContractError && error.concern === "codeHost"
    && error.failures.map(({ check }) => check).join() === "readPullFeedback answers null for a pull request it cannot read");
});

test("a sweep that drops the note of a pull request it cannot read fails by name", async () => {
  const { host, probe } = seeded();
  const dropping: CodeHost = { ...host, sweepRetargets: () => ({}) };
  await assert.rejects(runCodeHostConformance(dropping, probe), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join() === "sweepRetargets keeps the note of a pull request it cannot read");
});

test("the fake retargets a stacked pull request whose base merged, and says nothing of one that is not stacked", () => {
  const host = createFakeCodeHost();
  host.seedPull("owner/repo", 1, { head: "feature/base", state: "merged" });
  const { url } = host.seedPull("owner/repo", 2, { base: "feature/base", head: "feature/top" });
  const lines: string[] = [];
  const notes = host.sweepRetargets({ urls: [url], previous: {}, stacked: new Set(["feature/base"]), defaults: new Map(), log: (line) => lines.push(line) });
  assert.deepEqual(notes, {});
  assert.deepEqual(host.retargets, [{ url, base: "main" }]);
  assert.equal(host.pullAt(url)?.base, "main");
  const other = host.seedPull("owner/repo", 3, { base: "feature/elsewhere" });
  host.sweepRetargets({ urls: [other.url], previous: {}, stacked: new Set(["feature/base"]), defaults: new Map(), log: () => undefined });
  assert.equal(host.pullAt(other.url)?.base, "feature/elsewhere", "a base that is not one the run stacked on is none of the board's to move");
});

test("a subscription is called for the events it names and no longer once cancelled", () => {
  const { host, probe } = seeded();
  const seen: string[] = [];
  const cancel = host.subscribe({ kinds: ["head-moved"], ref: probe.change }, (event) => seen.push(event.kind));
  host.emit({ kind: "head-moved", ref: probe.change, at: "t", actor: null });
  host.emit({ kind: "review-posted", ref: probe.change, at: "t", actor: null });
  cancel();
  host.emit({ kind: "head-moved", ref: probe.change, at: "t", actor: null });
  assert.deepEqual(seen, ["head-moved"]);
});

test("the fake says a pull request is approved at its head only for an approval by someone else on the head it holds", () => {
  const host = createFakeCodeHost();
  const review = (author: string, commit: string) => ({ author, state: "APPROVED", commit, at: 1 });
  const { url } = host.seedPull("owner/repo", 5, { head: "h5", reviews: [review("a-person", "h5"), review("fake-worker", "h5"), review("a-person", "older")] });
  assert.equal(host.readPullFeedback(url, "someone-else")?.approvedAtHead, true);
  const own = host.seedPull("owner/repo", 6, { head: "h6", reviews: [review("fake-worker", "h6"), review("a-person", "older")] });
  assert.equal(host.readPullFeedback(own.url, "fake-worker")?.approvedAtHead, false, "the caller's own approval, and one on an earlier head, are not approval of this head");
  assert.deepEqual([host.readPullFeedback(url, "x")?.head, host.readPullFeedback(url, "x")?.mergeable], ["h5", true]);
});

test("without a check or a head to claim in the probe, their checks are skipped with the reason, not passed", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, { ...probe, check: undefined, claim: undefined });
  assert.deepEqual(skipped.map(({ check }) => check), [...ROWS_CHECKS, "readCheckLog reads the log behind a failing check", "a claim written on a head is read back from it"]);
  assert.deepEqual(skipped.filter(({ check }) => !ROWS_CHECKS.includes(check)).map(({ reason }) => reason.replace(/, so .*/, "")), ["the probe names no check", "the probe names no head to claim"]);
  assert.ok(!passed.includes("readCheckLog reads the log behind a failing check") && !passed.includes("a claim written on a head is read back from it"));
});

test("a code host that reads no log, or that loses the claim it wrote, fails by name", async () => {
  const noLog = seeded();
  noLog.host.checksAndClaims.logs.clear();
  await assert.rejects(runCodeHostConformance(noLog.host, noLog.probe), (error: unknown) => error instanceof ContractError && error.failures.map(({ check }) => check).join() === "readCheckLog reads the log behind a failing check");
  const lost = seeded();
  lost.host.writeReviewClaim = () => null;
  await assert.rejects(runCodeHostConformance(lost.host, lost.probe), (error: unknown) => error instanceof ContractError && error.failures.map(({ check }) => check).join() === "a claim written on a head is read back from it");
});

test("a code host that answers neither the entries nor a reason fails by name", async () => {
  const { host, probe } = seeded();
  host.readReviewClaims = () => ({ unreadable: "" });
  await assert.rejects(runCodeHostConformance(host, probe), (error: unknown) => error instanceof ContractError && error.failures.some(({ check }) => check === "readReviewClaims answers the entries of a head, or why it could not"));
});

test("the fake keeps the claims it is told to write, in order, for the head they were written on, and refuses as it is told to", () => {
  const { host } = seeded();
  const state = host.checksAndClaims;
  state.now = () => 1_000;
  const write = (head: string, description: string) => host.writeReviewClaim({ repository: "owner/repo", head, description, environment: { GH_CONFIG_DIR: "/r" } });
  assert.equal(write("h1", "claimed by a"), null);
  assert.equal(write("h1", "released by a"), null);
  assert.equal(write("h2", "claimed by b"), null);
  assert.deepEqual(host.readReviewClaims("owner/repo", "h1"), { entries: [{ id: 1, description: "claimed by a", created: 1_000 }, { id: 2, description: "released by a", created: 1_000 }] });
  assert.deepEqual(host.readReviewClaims("owner/repo", "h3"), { entries: [] }, "a head nobody claimed has no entries, which is not a failure to read");
  state.claimWriteRefusal = "HTTP 403";
  assert.equal(write("h2", "claimed by c"), "HTTP 403");
  assert.equal(state.claimWrites.length, 3, "a refused write is not kept");
  state.claimReadRefusal = "HTTP 502";
  assert.deepEqual(host.readReviewClaims("owner/repo", "h1"), { unreadable: "HTTP 502" });
});

test("the fake reruns what it is asked to and refuses when told to, and reads only the logs it holds", () => {
  const { host } = seeded();
  assert.equal(host.rerunFailedChecks(["u1", "u2"]), null);
  assert.deepEqual(host.checksAndClaims.reruns, [["u1", "u2"]]);
  host.checksAndClaims.rerunRefusal = "Command failed: gh run rerun";
  assert.equal(host.rerunFailedChecks(["u3"]), "Command failed: gh run rerun");
  assert.deepEqual(host.checksAndClaims.reruns, [["u1", "u2"]], "a refused rerun is not recorded as made");
  assert.equal(host.readCheckLog("https://github.com/owner/repo/actions/runs/9/job/9"), null);
});

test("A11-175: the fake reports the unrequired red checks it is told of, and the contract suite takes a host that reports them as a list of names, and refuses one that does not", async () => {
  const { host, probe } = seeded();
  assert.equal(host.readReviewState(probe.pull)?.unrequiredRed, undefined, "a pull request with none names none");
  const named = createFakeCodeHost("fake-worker");
  const { url } = named.seedPull("owner/repo", 8, { unrequiredRed: ["checks (cross-repo)"] });
  assert.deepEqual(named.readReviewState(url)?.unrequiredRed, ["checks (cross-repo)"]);
  const liar = { ...host, readReviewState: (pull: string) => ({ ...host.readReviewState(pull)!, unrequiredRed: "checks (cross-repo)" as unknown as readonly string[] }) };
  await assert.rejects(runCodeHostConformance(liar, probe), (error: unknown) => error instanceof ContractError
    && error.failures.some(({ check }) => check === "readReviewState reads the head, the reviews and whether the checks settled"));
});

test("A11-215: the fake answers an update of a branch as the test says, records each one asked, and refuses a pull request it does not hold", () => {
  const { host } = seeded();
  const held = fakePullUrl("owner/repo", 7);
  assert.deepEqual(host.updateBranch!(held, "h7"), { kind: "updated" }, "a held pull request updates unless the test says otherwise");
  host.branchUpdates.answers.set(held, { kind: "conflict" });
  assert.deepEqual(host.updateBranch!(held, "h7"), { kind: "conflict" });
  const missing = fakePullUrl("owner/repo", 999);
  assert.equal(host.updateBranch!(missing, "h").kind, "refused");
  assert.deepEqual(host.branchUpdates.asked.map(({ url, expectedHead }) => [url, expectedHead]), [[held, "h7"], [held, "h7"], [missing, "h"]]);
  assert.ok(host.calls.includes(`updateBranch ${held} h7`), "and it is in the calls");
});

const CI_CHECKS = ["readCiRun answers null for a run it cannot read", "readCiRun reads a workflow run's status, conclusion, address, name and jobs"];

test("without a workflow run in the probe the read of one is skipped with the reason, not passed (contract 1.17)", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, { ...probe, ciRun: undefined });
  assert.deepEqual(skipped.map(({ check }) => check).filter((check) => CI_CHECKS.includes(check)), [CI_CHECKS[1]]);
  assert.ok(skipped.filter(({ check }) => check === CI_CHECKS[1]).every(({ reason }) => /the probe names no workflow run/.test(reason)));
  assert.ok(passed.includes(CI_CHECKS[0]) && !passed.includes(CI_CHECKS[1]));
});

test("a code host that reads a run it cannot read as unfinished, or a run in a shape the board cannot judge, fails each by name", async () => {
  const { host, probe } = seeded();
  const failures = async (candidate: CodeHost) => runCodeHostConformance(candidate, probe).then(() => [], (error: unknown) => (error instanceof ContractError ? error.failures.map(({ check }) => check) : [String(error)]));
  const reads = host.readCiRun!;
  const unfinished = { status: "in_progress", conclusion: null, url: "u", name: "n", jobs: null } as const;
  assert.deepEqual(await failures({ ...host, readCiRun: (repository, runId) => reads(repository, runId) ?? unfinished }), [CI_CHECKS[0]]);
  assert.deepEqual(await failures({ ...host, readCiRun: (repository, runId) => (reads(repository, runId) === null ? null : { ...unfinished, status: "completed" }) }), [CI_CHECKS[1]], "a completed run with no conclusion");
  assert.deepEqual(await failures({ ...host, readCiRun: (repository, runId) => (reads(repository, runId) === null ? null : { ...unfinished, jobs: { done: 4, total: 3 } }) }), [CI_CHECKS[1]], "more jobs done than there are");
  assert.deepEqual(await failures({ ...host, readCiRun: (repository, runId) => (reads(repository, runId) === null ? null : { ...unfinished, jobs: { done: 0, total: 0 } }) }), [CI_CHECKS[1]], "an empty list of jobs is null, not zero of zero");
  assert.deepEqual(await failures({ ...host, readCiRun: (repository, runId) => (reads(repository, runId) === null ? null : { ...unfinished, status: "completed", conclusion: "" }) }), [CI_CHECKS[1]], "an empty conclusion is none");
});

test("the fake says which runs it was asked about, and answers null for one it was given none for", () => {
  const { host } = seeded();
  assert.equal(host.readCiRun!("owner/repo", 31)?.jobs?.total, 3);
  assert.equal(host.readCiRun!("owner/repo", 32), null);
  assert.deepEqual(host.ciRuns.asked, ["owner/repo#31", "owner/repo#32"]);
});

test("a code host of contract 1.16, with no readCiRun, still passes the suite: both of the run's checks are skipped with the reason", async () => {
  const { host, probe } = seeded();
  const { readCiRun, ...older } = host;
  assert.equal(typeof readCiRun, "function");
  const { passed, skipped } = await runCodeHostConformance(older, probe);
  assert.deepEqual(skipped.map(({ check }) => check).filter((check) => CI_CHECKS.includes(check)), CI_CHECKS);
  assert.ok(skipped.filter(({ check }) => CI_CHECKS.includes(check)).every(({ reason }) => /the code host has no readCiRun/.test(reason)));
  assert.ok(!passed.some((check) => CI_CHECKS.includes(check)));
});

const NAMING_CHECKS = ["pullsNaming answers null for a repository it cannot read", "pullsNaming lists the pull requests that name a key, with their state"];

/** Runs the suite over `candidate` and says which of `checks` it skipped, with the reason, and which it passed. */
async function ranChecks(candidate: CodeHost, probe: Parameters<typeof runCodeHostConformance>[1], checks: readonly string[]) {
  const { passed, skipped } = await runCodeHostConformance(candidate, probe);
  return { skipped: skipped.filter(({ check }) => checks.includes(check)), passed: passed.filter((check) => checks.includes(check)) };
}

test("a code host of contract 1.17, with no pullsNaming, still passes the suite: both of the listing's checks are skipped with the reason", async () => {
  const { host, probe } = seeded();
  const { pullsNaming, ...older } = host;
  assert.equal(typeof pullsNaming, "function");
  const ran = await ranChecks(older, probe, NAMING_CHECKS);
  assert.deepEqual(ran.skipped.map(({ check }) => check), NAMING_CHECKS);
  assert.ok(ran.skipped.every(({ reason }) => /the code host has no pullsNaming/.test(reason)));
  assert.deepEqual(ran.passed, []);
});

test("without a pull request that names a key in the probe the listing of one is skipped with the reason, not passed (contract 1.18)", async () => {
  const { host, probe } = seeded();
  const ran = await ranChecks(host, { ...probe, named: undefined }, NAMING_CHECKS);
  assert.deepEqual(ran.skipped.map(({ check }) => check), [NAMING_CHECKS[1]]);
  assert.match(ran.skipped[0]!.reason, /the probe names no pull request that names a key/);
  assert.deepEqual(ran.passed, [NAMING_CHECKS[0]]);
});

test("a code host that reads a repository it cannot read as one that names nothing, or lists a pull request in a state or repository it is not in, fails each by name", async () => {
  const { host, probe } = seeded();
  const failures = async (candidate: CodeHost) => runCodeHostConformance(candidate, probe).then(() => [], (error: unknown) => (error instanceof ContractError ? error.failures.map(({ check }) => check) : [String(error)]));
  const reads = host.pullsNaming!;
  assert.deepEqual(await failures({ ...host, pullsNaming: (key, repositories) => reads(key, repositories) ?? [] }), [NAMING_CHECKS[0]], "none for could not ask");
  assert.deepEqual(await failures({ ...host, pullsNaming: (key, repositories) => reads(key, repositories)?.map((pull) => ({ ...pull, state: "open" as const })) ?? null }), [NAMING_CHECKS[1]], "the wrong state");
  assert.deepEqual(await failures({ ...host, pullsNaming: (key, repositories) => reads(key, repositories)?.map((pull) => ({ ...pull, repo: "other/repo" })) ?? null }), [NAMING_CHECKS[1]], "the wrong repository");
});

test("A11-240: the fake lists the pull requests of the repositories asked about that name the key on word boundaries, in their state, and cannot ask about a repository it does not hold", () => {
  const { host } = seeded();
  assert.deepEqual(host.pullsNaming!("A11-240", ["owner/repo"]), [{ url: fakePullUrl("owner/repo", 10), repo: "owner/repo", state: "merged", body: "Refs A11-240\n\nPartial: step 1 of 2: the first half" }]);
  assert.deepEqual(host.pullsNaming!("a11-2401", ["owner/repo"])?.map(({ url }) => url), [fakePullUrl("owner/repo", 11)], "any case, and not a longer key's prefix");
  assert.equal(host.pullsNaming!("A11-240", ["owner/repo", "owner/unknown"]), null);
  host.seedRepository("owner/empty");
  assert.deepEqual(host.pullsNaming!("A11-240", ["owner/empty"]), [], "a repository it can ask about, with none naming the key");
});

const DEPENDENCY_CHECKS = ["openDependencyPulls answers null for a repository it cannot read", "openDependencyPulls lists the pull requests the dependency bot opened, and no one else's"];

test("a code host of contract 1.18, with no openDependencyPulls, still passes the suite: both of its checks are skipped with the reason", async () => {
  const { host, probe } = seeded();
  const older = Object.fromEntries(Object.entries(host).filter(([name]) => name !== "openDependencyPulls")) as CodeHost;
  assert.equal(typeof host.openDependencyPulls, "function", "POSITIVE CONTROL: the fake has the operation the older host lacks");
  const ran = await ranChecks(older, probe, DEPENDENCY_CHECKS);
  assert.deepEqual([ran.skipped.map(({ check }) => check), ran.passed], [DEPENDENCY_CHECKS, []]);
  assert.equal(ran.skipped.filter(({ reason }) => /the code host has no openDependencyPulls/.test(reason)).length, DEPENDENCY_CHECKS.length, "each says why");
});

const QUEUE_CHECKS = ["readQueueFailure answers null for what it cannot read, and reads the failing job behind a removal", "holdFromQueue puts the hold on a pull request and takes it off, and throws for one it cannot read"];

test("a code host of contract 1.20, with no readQueueFailure or holdFromQueue, still passes the suite: both of the merge queue's checks are skipped with the reason", async () => {
  const { host, probe } = seeded();
  const older = Object.fromEntries(Object.entries(host).filter(([name]) => name !== "readQueueFailure" && name !== "holdFromQueue")) as CodeHost;
  assert.deepEqual([typeof host.readQueueFailure, typeof host.holdFromQueue], ["function", "function"], "POSITIVE CONTROL: the fake has the operations the older host lacks");
  const ran = await ranChecks(older, probe, QUEUE_CHECKS);
  assert.deepEqual([ran.skipped.map(({ check }) => check), ran.passed], [QUEUE_CHECKS, []]);
  assert.deepEqual(ran.skipped.map(({ reason }) => /the code host has no (readQueueFailure|holdFromQueue)/.test(reason)), [true, true], "each says why");
});

test("a code host that reads a run it cannot find as one with no failing job, or answers a hold it cannot make as made, fails each by name (contract 1.21)", async () => {
  const { host, probe } = seeded();
  const failures = async (candidate: CodeHost) => runCodeHostConformance(candidate, probe).then(() => [], (error: unknown) => (error instanceof ContractError ? error.failures.map(({ check }) => check) : [String(error)]));
  assert.deepEqual(await failures({ ...host, readQueueFailure: () => ({ runId: 1, runUrl: "https://github.com/owner/repo/actions/runs/1", jobs: [] }) }), [QUEUE_CHECKS[0]], "a run for what it cannot read");
  assert.deepEqual(await failures({ ...host, holdFromQueue: () => true }), [QUEUE_CHECKS[1]], "a hold on a pull request it cannot read");
  assert.deepEqual(await failures({ ...host, holdFromQueue: () => false }), [QUEUE_CHECKS[1]], "a hold that reads back as not asked");
});

test("a code host that reads a repository it cannot read as one the bot opened nothing in, or lists a pull request the bot did not open, fails each by name (contract 1.19)", async () => {
  const { host, probe } = seeded();
  const failures = async (candidate: CodeHost) => runCodeHostConformance(candidate, probe).then(() => [], (error: unknown) => (error instanceof ContractError ? error.failures.map(({ check }) => check) : [String(error)]));
  const reads = host.openDependencyPulls!;
  assert.deepEqual(await failures({ ...host, openDependencyPulls: (repository) => reads(repository) ?? [] }), [DEPENDENCY_CHECKS[0]], "none for could not ask");
  assert.deepEqual(await failures({ ...host, openDependencyPulls: (repository) => reads(repository)?.concat({ url: probe.dependency.foreign, number: 13, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "someone/bump", headSha: "head-13", author: "someone" as never, body: "" }) ?? null }),
    [DEPENDENCY_CHECKS[1]], "a pull request someone else opened");
});

test("the fake lists a bot's open pull request only: not a merged one, not another author's, and not a repository it was never given", () => {
  const { host } = seeded();
  host.seedPull("owner/repo", 14, { state: "merged", dependency: { title: "deps: bump a from 1.0.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/a-2.0.0", author: DEPENDENCY_PULL_AUTHOR } });
  assert.deepEqual(host.openDependencyPulls!("owner/repo")?.map(({ number }) => number), [12]);
  assert.equal(host.openDependencyPulls!("owner/never-given"), null);
});

test("the fake reads a closed pull request's work, with no commits for one that holds nothing, and reads no pull request that is open, merged or never given (contract 1.20)", () => {
  const { host, probe } = seeded();
  const held = host.readClosedWork!(probe.closed);
  assert.deepEqual([held?.number, held?.base, held?.branch, held?.head, held?.commits.map(({ subject }) => subject), held?.files, held?.filesComplete], [20, "main", "admin/a11-229-x", "head-20", ["feat: one", "feat: two"], ["src/a.ts", "src/b.ts"], true]);
  const nothing = host.seedPull("owner/repo", 21, { state: "closed" });
  assert.deepEqual([host.readClosedWork!(nothing.url)?.commits, host.readClosedWork!(nothing.url)?.branch], [[], "branch-21"], "a closed pull request seeded with no work holds none: everything it held is on its base");
  assert.deepEqual([probe.pull, probe.merged, probe.missing].map((url) => host.readClosedWork!(url)), [null, null, null]);
});

test("a code host that reads an open pull request, or one it cannot read, as having held nothing fails the closed-work check by name (contract 1.20)", async () => {
  const { host, probe } = seeded();
  const failures = async (candidate: CodeHost) => runCodeHostConformance(candidate, probe).then(() => [], (error: unknown) => (error instanceof ContractError ? error.failures.map(({ check }) => check) : [String(error)]));
  const reads = host.readClosedWork!;
  const CHECK = "readClosedWork answers null for a pull request it cannot read or that is open, and reads what a closed one still held";
  assert.deepEqual(await failures({ ...host, readClosedWork: (url) => reads(url) ?? { number: 1, url, base: "main", branch: "b", head: "h", commits: [], files: [], filesComplete: true } }), [CHECK], "an empty list for could not ask");
  assert.deepEqual(await failures({ ...host, readClosedWork: (url) => (url === probe.closed ? { ...reads(url)!, commits: [] } : reads(url)) }), [CHECK], "a closed pull request the probe says holds a commit");
});

test("a code host of contract 1.19, with no readClosedWork, still passes the suite: its check is skipped with the reason", async () => {
  const { host, probe } = seeded();
  const older = Object.fromEntries(Object.entries(host).filter(([name]) => name !== "readClosedWork")) as CodeHost;
  const ran = await runCodeHostConformance(older, probe);
  const name = "readClosedWork answers null for a pull request it cannot read or that is open, and reads what a closed one still held";
  assert.ok(!ran.passed.includes(name));
  assert.match(ran.skipped.find(({ check }) => check === name)?.reason ?? "", /the code host has no readClosedWork/);
});
