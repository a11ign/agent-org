// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9): THE FAKE CODE HOST'S OPERATIONS FOR THE PULL-REQUEST WORK OF `pr-open`, `pr-hold`, `carry-branch`, `stranded-branches`, THE WORKER'S `Stop` HOOK AND THE ROUTE GUARD'S POST. Core's tests of those callers seed
 * the world and ask without a `run`; these cases hold what they rely on: the labels and auto-merge of a pull request, the rows a hold waits on, the listings, the writes of the sweep, the epic's daily comment, and the
 * login, the labels and the branches a test seeds beyond the world.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";
import { fakePull } from "./code-host-pulls.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "a11ign/a11ign";
  world.rows.set(7, fakeRow(world, 7, { title: "the row", body: "## Region\n", labels: ["in-progress"], comments: [{ id: 1, body: "first", createdAt: "2026-10-10T08:00:00Z" }] }));
  world.rows.set(4627, fakeRow(world, 4627, { title: "the epic" }));
  fakePull(world, 10, { headRefName: "agent/one", createdAt: "2026-10-10T09:00:00Z", labels: ["hold:worker-1"], armed: true, closes: [{ number: 7, labels: [] }] });
  fakePull(world, 11, { headRefName: "agent/two", createdAt: "2026-10-10T10:00:00Z" });
  fakePull(world, 12, { headRefName: "agent/merged", createdAt: "2026-10-10T11:00:00Z", merged: true, mergedAt: "2026-10-10T12:00:00Z" });
  return { world, rows: host.rows! };
}

test("the builders answer fake argument lists that name the step and the facts it was asked for", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.pullWriteArgs("create", ["--draft"]), ["fake-pull-write", "create", "--draft"]);
  assert.deepEqual(rows.armArgsAfterCreate({ rest: ["--head", "agent/x"], branch: "agent/y" }), [["fake-arm", "agent/y", "--head", "agent/x"]]);
  assert.deepEqual(rows.labelArgsAfterCreate({ rest: ["--head", "agent/x"], branch: null, label: "session:ceo" }), [["fake-label", "session:ceo", "", "--head", "agent/x"]]);
  assert.deepEqual(rows.labelCreateArgs({ name: "session:ceo", description: "d", repo: "o/r" }), ["fake-label-create", "session:ceo", "d", "o/r"]);
});

test("what pr-open reads: the pull request's head, a row's body and label names (in this repository or another), the label the repository holds, the commit of a branch, and the login", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.pullHeadForOpening({ repo: world.repo, number: "10", run: refused }), { ref: "agent/one", oid: "" });
  assert.throws(() => rows.pullHeadForOpening({ repo: world.repo, number: "99", run: refused }), /no pull request #99/);
  assert.equal(rows.rowBodyForOpening({ repo: world.repo, number: 7, run: refused }), "## Region\n");
  assert.deepEqual(rows.restLabelNamesOf({ repo: world.repo, number: 7, run: refused }), ["in-progress"]);
  world.foreignRows.set("a11ign/second#3", fakeRow(world, 3, { body: "elsewhere", labels: ["ready"] }));
  assert.equal(rows.rowBodyForOpening({ repo: "a11ign/second", number: 3, run: refused }), "elsewhere");
  assert.deepEqual(rows.restLabelNamesOf({ repo: "a11ign/second", number: 3, run: refused }), ["ready"]);
  assert.throws(() => rows.rowBodyForOpening({ repo: "a11ign/second", number: 4, run: refused }), /no row a11ign\/second#4/);
  assert.equal(rows.labelExistsForOpening({ name: "anything", run: refused }), true, "a repository that holds every label");
  world.tail.pullwork.repoLabels = new Set(["session:ceo"]);
  assert.deepEqual([rows.labelExistsForOpening({ name: "session:ceo", run: refused }), rows.labelExistsForOpening({ name: "session:x", run: refused })], [true, false]);
  assert.equal(rows.branchHeadForOpening({ repo: world.repo, branch: "agent/one", run: refused }), null, "a branch the repository does not hold");
  world.tail.pullwork.branches.set(`${world.repo}:agent/one`, "deadbeef");
  assert.equal(rows.branchHeadForOpening({ repo: world.repo, branch: "agent/one", run: refused }), "deadbeef");
  assert.deepEqual(rows.authoringLoginOf({ run: refused }), { failures: ["`gh api user`: the fake was given no login"] }, "no login seeded: why none was read, never a login");
  world.tail.pullwork.login = "a11ign-ai-workers";
  assert.deepEqual(rows.authoringLoginOf({ run: refused }), { login: "a11ign-ai-workers" });
});

test("a hold: a pull request's labels (null for one the fake was never given), a label added, made on demand and taken off, and a refusal by name", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.heldPullLabelsOf({ repo: world.repo, number: 10, run: refused }), ["hold:worker-1"]);
  assert.equal(rows.heldPullLabelsOf({ repo: world.repo, number: 99, run: refused }), null, "could not ask is null, never nobody holds it");
  rows.editHeldPullLabel({ repo: world.repo, number: 11, label: "hold:worker-2", how: "add", run: refused });
  assert.deepEqual(world.pulls.get(11)?.labels, ["hold:worker-2"]);
  rows.editHeldPullLabel({ repo: world.repo, number: 11, label: "hold:worker-2", how: "add", run: refused });
  assert.deepEqual(world.pulls.get(11)?.labels, ["hold:worker-2"], "adding twice is adding once");
  rows.editHeldPullLabel({ repo: world.repo, number: 11, label: "hold:worker-2", how: "remove", run: refused });
  assert.deepEqual(world.pulls.get(11)?.labels, []);
  world.tail.pullwork.repoLabels = new Set();
  assert.throws(() => rows.editHeldPullLabel({ repo: world.repo, number: 11, label: "rearm-on-release", how: "add", run: refused }), /'rearm-on-release' not found/, "a label the repository lacks is refused as gh refuses it");
  rows.editHeldPullLabel({ repo: world.repo, number: 11, label: "hold:worker-3", how: "add", createdWith: "d", run: refused });
  assert.deepEqual(world.pulls.get(11)?.labels, ["hold:worker-3"], "and made, when the caller says what to make it with");
  assert.equal(world.tail.pullwork.repoLabels.has("hold:worker-3"), true);
  world.failures.set("editHeldPullLabel", new Error("HTTP 403"));
  assert.throws(() => rows.editHeldPullLabel({ repo: world.repo, number: 11, label: "x", how: "add", run: refused }), /HTTP 403/);
});

test("a hold's auto-merge: read with its state, armed and disarmed, and refused as the pull request says", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.autoMergeOfHeldPull({ repo: world.repo, number: 10, run: refused })?.state, "OPEN");
  assert.notEqual(rows.autoMergeOfHeldPull({ repo: world.repo, number: 10, run: refused })?.autoMergeRequest, null, "armed");
  assert.deepEqual(rows.autoMergeOfHeldPull({ repo: world.repo, number: 12, run: refused })?.state, "MERGED");
  assert.equal(rows.autoMergeOfHeldPull({ repo: world.repo, number: 99, run: refused }), null);
  rows.disarmHeldPull({ number: 10, run: refused });
  assert.equal(rows.autoMergeRequestOfHeldPull({ number: 10, run: refused }).autoMergeRequest, null, "disarmed");
  rows.armHeldPull({ number: 10, run: refused });
  assert.notEqual(rows.autoMergeRequestOfHeldPull({ number: 10, run: refused }).autoMergeRequest, null);
  world.pulls.get(11)!.armRefusal = "Pull request is in clean status";
  assert.throws(() => rows.armHeldPull({ number: 11, run: refused }), /clean status/);
  world.pulls.get(11)!.armRefusal = null;
  world.pulls.get(11)!.armTakes = false;
  rows.armHeldPull({ number: 11, run: refused });
  assert.equal(world.pulls.get(11)?.armed, false, "an arm that exits 0 and does nothing is the asymmetry the hold reads back for");
  assert.throws(() => rows.autoMergeRequestOfHeldPull({ number: 99, run: refused }), /no pull request #99/);
});

test("the row a hold waits on: its state, labels, the open pull requests that close it, and the row itself; null for one the fake does not hold", () => {
  const { world, rows } = seeded();
  const target = rows.holdTargetRowOf({ repo: world.repo, number: 7, run: refused });
  assert.deepEqual([target?.state, target?.labels, target?.openPullRequests], ["open", ["in-progress"], [{ number: 10, repo: world.repo }]]);
  assert.equal(target?.row.body, "## Region\n");
  assert.deepEqual(target?.row.comments, [{ body: "first", createdAt: "2026-10-10T08:00:00Z" }]);
  world.pulls.get(10)!.merged = true;
  assert.deepEqual(rows.holdTargetRowOf({ repo: world.repo, number: 7, run: refused })?.openPullRequests, [], "a merged pull request is not an open one that closes it");
  assert.equal(rows.holdTargetRowOf({ repo: world.repo, number: 99, run: refused }), null);
  world.rows.get(7)!.state = "CLOSED";
  assert.equal(rows.holdTargetRowOf({ repo: world.repo, number: 7, run: refused })?.state, "closed");
  world.rows.get(7)!.state = "OPEN";
  world.tail.pullwork.closingUnread = new Map([[`${world.repo}#7`, [{ number: 55, repo: world.repo }]]]);
  assert.deepEqual(rows.holdTargetRowOf({ repo: world.repo, number: 7, run: refused })?.openPullRequests, [{ number: 55, repo: world.repo }], "a closing pull request GitHub lists and the fake holds none of");
  assert.equal(rows.pullRequestFieldsOf({ repo: world.repo, number: 55, fields: "body", run: refused }), null, "is one a read of cannot answer");
});

test("the listings: the open pull request of a branch, the head refs by creation in pages (and a page that is unreadable), the sweep's open pull requests, and the Stop hook's all-state listing", () => {
  const { world, rows } = seeded();
  assert.equal(rows.openPullNumberOfBranch({ repo: world.repo, branch: "agent/two", run: refused }), 11);
  assert.equal(rows.openPullNumberOfBranch({ repo: world.repo, branch: "agent/merged", run: refused }), null, "a merged pull request is not the branch's open one");
  assert.deepEqual(rows.pullHeadRefsPageOf({ repo: world.repo, page: 1, pageSize: 2, run: refused }), { refs: ["agent/one", "agent/two"] });
  assert.deepEqual(rows.pullHeadRefsPageOf({ repo: world.repo, page: 2, pageSize: 2, run: refused }), { refs: ["agent/merged"] });
  world.tail.pullwork.unreadablePages.set(2, "the page was not JSON");
  assert.deepEqual(rows.pullHeadRefsPageOf({ repo: world.repo, page: 2, pageSize: 2, run: refused }), { unreadable: "the page was not JSON" });
  assert.deepEqual(rows.openPullsForSweep({ limit: 400, run: refused }).map((pr) => [pr.number, pr.mergeStateStatus, pr.labels]), [[10, "CLEAN", [{ name: "hold:worker-1" }]], [11, "CLEAN", []]]);
  assert.equal(rows.openPullsForSweep({ limit: 1, run: refused }).length, 1, "the limit is the listing's");
  assert.deepEqual(rows.pullsListedForStop({ repo: world.repo, limit: 100, run: refused }).map((pr) => [pr.number, pr.state]), [[10, "OPEN"], [11, "OPEN"], [12, "MERGED"]]);
});

test("the sweep's writes: a comment on a pull request and a close, noted in order, each refusable by the case and neither touching another pull request", () => {
  const { world, rows } = seeded();
  const refusing: string[] = [];
  world.tail.pullwork.onWrite = (line) => { refusing.push(line); if (line === "closeCheckoutPull #11") throw new Error("HTTP 403"); };
  rows.commentOnCheckoutPull({ number: 11, body: "STALE", run: refused });
  assert.throws(() => rows.closeCheckoutPull({ number: 11, run: refused }), /HTTP 403/);
  assert.equal(world.pulls.get(11)?.closedAt ?? null, null, "a refused close closes nothing");
  world.tail.pullwork.onWrite = null;
  rows.closeCheckoutPull({ number: 11, run: refused });
  assert.deepEqual(world.pulls.get(11)?.comments, ["STALE"]);
  assert.notEqual(world.pulls.get(11)?.closedAt, null);
  assert.deepEqual(world.pulls.get(10)?.comments, []);
  assert.deepEqual(refusing, ["commentOnCheckoutPull #11", "closeCheckoutPull #11"]);
  assert.equal(rows.openPullNumberOfBranch({ repo: world.repo, branch: "agent/two", run: refused }), null, "a closed pull request is no longer the branch's open one");
});
