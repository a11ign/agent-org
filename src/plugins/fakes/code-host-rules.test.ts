// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 7): THE FAKE CODE HOST'S OPERATIONS FOR THE CLAIM'S RULES. Core's tests of `src/row-claim/*-rule.ts` seed the world and call the lookup with no `run`; these cases hold what they rely on: a held row's
 * shape, the pull requests that close a row or cross-reference it, the open pull requests with their files, a refused read, and the writes of the review-dispute escalation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow, type FakeRowPull } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

const pull = (number: number, over: Partial<FakeRowPull> = {}): FakeRowPull => ({ number, body: "", headRefName: `branch-${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-01T00:00:00Z", comments: [], ...over });

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.rows.set(7, fakeRow(world, 7, { body: "## Region\n- a.ts", labels: ["in-progress"], blockedBy: [8] }));
  world.rows.set(8, fakeRow(world, 8, { state: "CLOSED" }));
  return { world, rows: host.rows! };
}

test("a held row's shape: body, labels, the blocked-by edge with each blocker's state, and its sub-issues", () => {
  const { world, rows } = seeded();
  world.rules.subIssues.set(7, 2);
  const repo = world.repo;
  assert.deepEqual(rows.rowShapeFactsOf({ repo, number: 7, run: refused }), { body: "## Region\n- a.ts", labels: [{ name: "in-progress" }], blockedBy: { nodes: [{ number: 8, state: "CLOSED" }] }, subIssues: 2 });
  assert.deepEqual(rows.blockedByOf({ repo, number: 7, run: refused }), { blockedBy: { nodes: [{ number: 8, state: "CLOSED" }] } });
  assert.deepEqual(rows.bodyAndLabelsOf({ repo, number: 7, run: refused }), { body: "## Region\n- a.ts", labels: [{ name: "in-progress" }] });
  assert.equal(rows.rowCarriesLabel({ repo, number: 7, label: "in-progress", run: refused }), true);
  assert.equal(rows.rowCarriesLabel({ repo, number: 7, label: "answer:ceo", run: refused }), false);
  assert.throws(() => rows.blockedByOf({ repo, number: 99, run: refused }), /holds no row/, "a row the fake holds none of cannot be read");
  world.rules.bodyless.add(7);
  assert.deepEqual(rows.bodyAndLabelsOf({ repo, number: 7, run: refused }), { labels: [{ name: "in-progress" }] }, "a row can be made to answer with no body key at all");
  assert.deepEqual(world.calls.filter((call) => call.startsWith("bodyAndLabelsOf")), [`bodyAndLabelsOf ${repo}#7`, `bodyAndLabelsOf ${repo}#7`], "the world records the calls it answered");
});

test("another repository's rows are the foreign ones, and its pull requests are `rules.otherRepos`", () => {
  const { world, rows } = seeded();
  world.foreignRows.set("a11ign/nvda-worker#3", fakeRow(world, 3, { body: "keyed" }));
  world.rules.otherRepos.set("a11ign/nvda-worker", new Map([[5, pull(5, { files: ["x.ts"] })]]));
  assert.equal(rows.bodyAndLabelsOf({ repo: "a11ign/nvda-worker", number: 3, run: refused }).body, "keyed");
  assert.deepEqual(rows.openPullsWithFilesOf({ repo: "a11ign/nvda-worker", run: refused }).map((one) => one.number), [5]);
  assert.deepEqual(rows.openPullsWithFilesOf({ repo: world.repo, run: refused }), [], "the world's own repository holds none of that repository's pull requests");
});

test("the closing pull requests are derived from the rows each pull request closes, oldest first, in the state they are in", () => {
  const { world, rows } = seeded();
  world.pulls.set(20, pull(20, { closes: [{ number: 7, labels: [] }], closedAt: "2026-10-02T00:00:00Z" }));
  world.pulls.set(21, pull(21, { closes: [{ number: 7, labels: [] }, { number: 8, labels: [] }], merged: true, mergedAt: "2026-10-03T00:00:00Z", headRefOid: "abc" }));
  world.pulls.set(22, pull(22, { closes: [{ number: 9, labels: [] }] }));
  assert.deepEqual(rows.closingPullsOf({ repo: world.repo, number: 7, run: refused }), [{ number: 20, state: "CLOSED", headRefOid: "head-20" }, { number: 21, state: "MERGED", headRefOid: "abc" }]);
  assert.deepEqual(rows.closingPullsOf({ repo: world.repo, number: 5, run: refused }), [], "a row nothing closes has no closing pull request: the read WORKED");
});

test("the open pull requests with their files: the listing's first page and the paged list apart, a closed one left out, and a refused repository", () => {
  const { world, rows } = seeded();
  world.pulls.set(30, pull(30, { files: ["a.ts", "b.ts"], labels: ["hold:x"], body: "Closes #7" }));
  world.pulls.set(31, pull(31, { files: ["c.ts", "d.ts", "e.ts"] }));
  world.pulls.set(32, pull(32, { files: ["z.ts"], merged: true }));
  world.rules.listings.set(31, { listed: ["c.ts"], changedFiles: 3 });
  const listed = rows.openPullsWithFilesOf({ repo: world.repo, run: refused });
  assert.deepEqual(listed.map((one) => [one.number, one.changedFiles, one.files.map((file) => file.path)]), [[30, 2, ["a.ts", "b.ts"]], [31, 3, ["c.ts"]]]);
  assert.deepEqual(listed[0].labels, [{ name: "hold:x" }]);
  assert.deepEqual(rows.pullFilePathsOf({ repo: world.repo, number: 31, run: refused }), ["c.ts", "d.ts", "e.ts"]);
  world.rules.pagedFilesRefused.set(31, new Error("HTTP 502 on the page"));
  assert.throws(() => rows.pullFilePathsOf({ repo: world.repo, number: 31, run: refused }), /HTTP 502 on the page/);
  world.rules.listRefused.set(world.repo, new Error("HTTP 502"));
  assert.throws(() => rows.openPullsWithFilesOf({ repo: world.repo, run: refused }), /HTTP 502/);
});

test("the review-health reads: the open pull requests with their decision, reviews and author, bounded by the limit, and a pull request's commits", () => {
  const { world, rows } = seeded();
  world.pulls.set(40, pull(40, { headRefOid: "h40", reviewDecision: "CHANGES_REQUESTED", author: "worker" }));
  world.pulls.set(41, pull(41, { merged: true }));
  world.pulls.set(42, pull(42));
  world.rules.reviews.set(40, { reviews: [{ state: "APPROVED", commit: { oid: "h40" } }] });
  world.rules.commits.set(40, [{ messageHeadline: "fix" }]);
  const health = rows.openPullReviewsOf({ repo: world.repo, limit: 10, run: refused });
  assert.deepEqual(health, [{ number: 40, headRefOid: "h40", reviewDecision: "CHANGES_REQUESTED", reviews: [{ state: "APPROVED", commit: { oid: "h40" } }], author: { login: "worker" } }, { number: 42, headRefOid: undefined, reviewDecision: null, reviews: [] }]);
  assert.equal(rows.openPullReviewsOf({ repo: world.repo, limit: 1, run: refused }).length, 1);
  assert.deepEqual(rows.commitsOfPull({ repo: world.repo, number: 40, run: refused }), [{ messageHeadline: "fix" }]);
  assert.deepEqual(rows.commitsOfPull({ repo: world.repo, number: 42, run: refused }), []);
});

test("the delivery reads: a row's cross-references (a refused timeline is that row's alone) and the paths a pull request changes", () => {
  const { world, rows } = seeded();
  world.rules.crossReferences.set(`${world.repo}#7`, [{ number: 50, state: "OPEN", body: "Delivers: #7" }, {}]);
  world.rules.crossReferences.set(`${world.repo}#8`, new Error("HTTP 500"));
  world.pulls.set(50, pull(50, { files: ["a.ts"] }));
  assert.deepEqual(rows.crossReferencingPullsOf({ repo: world.repo, number: 7, run: refused }), [{ number: 50, state: "OPEN", body: "Delivers: #7" }, {}]);
  assert.throws(() => rows.crossReferencingPullsOf({ repo: world.repo, number: 8, run: refused }), /HTTP 500/);
  assert.deepEqual(rows.crossReferencingPullsOf({ repo: world.repo, number: 9, run: refused }), [], "a row nothing cross-references has an empty timeline");
  assert.deepEqual(rows.changedPathsOfPull({ repo: world.repo, number: 50, run: refused }), ["a.ts"]);
});

test("the writes land on the world: a label created once, a label put on a row once, and a compare that answers by sha or cannot say", () => {
  const { world, rows } = seeded();
  rows.ensureLabelIn({ repo: world.repo, name: "answer:ceo", run: refused });
  rows.ensureLabelIn({ repo: world.repo, name: "answer:ceo", run: refused });
  rows.addLabelToRowIn({ repo: world.repo, number: 7, label: "answer:ceo", run: refused });
  rows.addLabelToRowIn({ repo: world.repo, number: 7, label: "answer:ceo", run: refused });
  assert.deepEqual(world.labelsCreated, ["answer:ceo"]);
  assert.deepEqual(world.rows.get(7)!.labels, ["in-progress", "answer:ceo"]);
  world.rules.compare.set("abc", { status: "ahead", files: ["src/row-claim.ts"] });
  assert.deepEqual(rows.compareShaWithMain({ repo: "a11ign/agent-org", sha: "abc", run: refused }), { status: "ahead", files: ["src/row-claim.ts"] });
  assert.equal(rows.compareShaWithMain({ repo: "a11ign/agent-org", sha: "unknown", run: refused }), null);
});
