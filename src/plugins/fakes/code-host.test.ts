// no-token: none -- the fake code host holds pull requests in memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodeHostConformance } from "../conformance/code-host.ts";
import { ContractError } from "../conformance/suite.ts";
import type { CodeHost } from "../contracts/code-host.ts";
import { createFakeCodeHost, fakePullUrl } from "./code-host.ts";

function seeded() {
  const host = createFakeCodeHost("fake-worker");
  const { url, ref } = host.seedPull("owner/repo", 7, { feedback: { authors: ["a-person", "fake-worker"] } });
  return { host, probe: { pull: url, repository: "owner/repo", missing: fakePullUrl("owner/repo", 999), self: "fake-worker", change: ref } };
}

test("the fake code host passes the code host contract suite, and the checks that ran are the ones asserted", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, probe);
  assert.deepEqual(passed, [
    "shape", "readOwnLogin names the account or answers null", "readPullFeedback reads a pull request", "readPullFeedback answers null for a pull request it cannot read",
    "readPullState names the state or answers null", "readReviewState reads the head, the reviews and whether the checks settled", "openPullUrlsOf lists a repository's open pull requests",
    "sweepRetargets keeps the note of a pull request it cannot read", "sweepRetargets with no pull requests has no notes", "subscribe returns the function that cancels it",
    "readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed",
  ]);
  assert.deepEqual(skipped, []);
});

test("without a change in the probe the port's reads are skipped with the reason, not passed", async () => {
  const { host, probe } = seeded();
  const { passed, skipped } = await runCodeHostConformance(host, { ...probe, change: undefined });
  assert.deepEqual(skipped.map(({ check }) => check), ["readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed"]);
  assert.ok(skipped.every(({ reason }) => /the probe names no change/.test(reason)));
  assert.ok(!passed.includes("armMerge arms the merge and says it is armed"));
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
