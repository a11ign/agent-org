// no-token: none -- the fake code host holds pull requests in memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodeHostConformance } from "../conformance/code-host.ts";
import { ContractError } from "../conformance/suite.ts";
import type { CodeHost, WrapperInputs } from "../contracts/code-host.ts";
import { createFakeCodeHost, fakePullUrl } from "./code-host.ts";

/** The inputs a wrapper is asked about: a place outside any temporary directory, and the workers' role an App. */
const INPUTS: WrapperInputs = {
  place: { binDir: "/opt/host/bin", tool: "/opt/agent-org", checkout: "/opt/project", stateEntry: (name) => `/opt/state/${name}` }, accounts: { workers: "/opt/workers", leads: "/opt/leads" },
  identity: { scheduler: { mode: "user-accounts" }, workers: { mode: "github-apps", appId: "1", keyPath: "/opt/workers.pem" }, managers: { mode: "user-accounts" }, reviewer: { mode: "user-accounts" } },
};

function seeded() {
  const host = createFakeCodeHost("fake-worker");
  const { url, ref } = host.seedPull("owner/repo", 7, { feedback: { authors: ["a-person", "fake-worker"] } });
  const merged = host.seedPull("owner/repo", 8, { state: "merged", findings: { title: "feat: replay", number: 8, body: "What it found", sections: [{ file: "docs/spike.md", heading: "### Scripted replay", text: "Cookie dialogs drop pages." }] } });
  const check = { detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/2", log: "Error: the build failed" };
  host.checksAndClaims.logs.set(check.detailsUrl, `2026-10-22T10:00:00Z ${check.log}\n`);
  const claim = { repository: "owner/repo", head: "c".repeat(40), environment: { GH_CONFIG_DIR: "/opt/reviewer/gh" } };
  return { host, probe: { pull: url, repository: "owner/repo", missing: fakePullUrl("owner/repo", 999), self: "fake-worker", change: ref, wrapper: INPUTS, merged: merged.url, check, claim } };
}

/** The checks of the optional `rows` group: the fake serves ticket mode only, so they are skipped with their reason and never counted as passed (contract 1.7). */
const ROWS_CHECKS = [
  "the rows are the operations row mode asks of the code host", "a read the rows could not make answers null or throws, never an empty answer", "a write the rows could not make throws, so no caller reads it as done",
  "the rows' pure helpers answer as the callers that sweep approvals and fold pages expect",
];

test("the fake code host passes the code host contract suite, and the checks that ran are the ones asserted", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, probe);
  assert.deepEqual(passed, [
    "shape", "readOwnLogin names the account or answers null", "readPullFeedback reads a pull request", "readPullFeedback answers null for a pull request it cannot read", "readReplies answers a list of replies, and null for a pull request it cannot read",
    "readPullState names the state or answers null", "readReviewState reads the head, the reviews and whether the checks settled", "openPullUrlsOf lists a repository's open pull requests",
    "sweepRetargets keeps the note of a pull request it cannot read", "sweepRetargets with no pull requests has no notes",
    "readCheckLog answers null for an address that names no job", "rerunFailedChecks of no checks reruns nothing and says so", "readReviewClaims answers the entries of a head, or why it could not", "subscribe returns the function that cancels it",
    "readCheckLog reads the log behind a failing check", "a claim written on a head is read back from it", "the verdict door is a file the plugin ships, with the program that installs it",
    "readMergedFindings reads what a merged pull request found, and answers null for one it cannot read or that has not merged",
    "readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed",
    "the wrapper is an owned file its own text agrees with", "the wrapper keeps its own text, and writes it", "the wrapper answers whether each declared role mints",
  ]);
  assert.deepEqual(skipped.map(({ check }) => check), ROWS_CHECKS, "the fake has no rows, which are optional: it serves ticket mode only");
  assert.ok(skipped.every(({ reason }) => /the code host has no rows, which are optional \(contract 1\.7\)/.test(reason)));
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
