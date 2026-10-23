// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 4): THE FAKE CODE HOST'S `rows`. It passes the contract suite (`code-host.test.ts`), and these cases hold what core's tests of row mode rely on: rows with labels, comments, the board and
 * blockers; incidents; windows; pull requests and the arming seat; the merge queue; and an operation whose answer is GitHub's own throwing by name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const SCOPE = "fake/tracker";
const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  for (const number of [1, 2, 3]) world.rows.set(number, fakeRow(world, number, { createdAt: `2026-10-0${number}T00:00:00.000Z` }));
  return { host, world, rows: host.rows! };
}

test("the port over the world: state and flags are the labels the port's vocabulary names, and a change that changes nothing says false", () => {
  const { world, rows } = seeded();
  world.rows.get(1)!.labels.push("ready", "lane:any", "answer:ceo", "hold");
  const port = rows.ticketAdapter({ run: refused, scope: SCOPE });
  const ref = { tracker: "github", scope: SCOPE, id: 1 };
  const item = port.readItem(ref)!;
  assert.equal(item.state, "ready");
  assert.deepEqual([...item.flags].sort(), ["answer-owed:ceo", "hold", "lane:any"]);
  assert.equal(port.readItem({ ...ref, scope: "other/repo" }), null, "an item of another scope is not this port's");
  assert.equal(port.readItem({ ...ref, id: 99 }), null, "an item the fake holds none of is one it cannot read: null, never an empty item");
  assert.equal(port.changeState(ref, { state: "in-progress", removeFlags: ["lane:any"], addFlags: ["priority"] }), true);
  assert.deepEqual(world.rows.get(1)!.labels.sort(), ["answer:ceo", "hold", "in-progress", "priority"], "the old state label leaves with the new one's arrival");
  assert.equal(port.changeState(ref, { state: "in-progress" }), false, "to the state it is in: nothing changes");
  assert.equal(port.changeState(ref, {}), false, "an empty change is no change");
  const id = port.postDecision(ref, { role: "ceo", runId: "r1", kind: "ruling", text: "Ruled.\n" });
  assert.equal(world.rows.get(1)!.comments.at(-1)?.body.endsWith("<!-- decided-by: ceo run: r1 -->"), true);
  assert.equal(String(world.rows.get(1)!.comments.at(-1)?.id), id);
  port.addBlocker(ref, { tracker: "github", scope: SCOPE, id: 2 });
  assert.deepEqual(port.readItem(ref)!.relations.blockedBy.map(({ id: blocker }) => blocker), [2]);
  const heard: string[] = [];
  const cancel = port.subscribe({ kinds: ["state-changed"] }, (event) => heard.push(event.kind));
  port.publish({ kind: "flag-added", ref, at: "t", actor: null });
  port.publish({ kind: "state-changed", ref, at: "t", actor: null });
  cancel();
  port.publish({ kind: "state-changed", ref, at: "t", actor: null });
  assert.deepEqual(heard, ["state-changed"]);
});

test("the open items name whether each is on the board, and tell the caller the budget the world holds", () => {
  const { world, rows } = seeded();
  world.rows.get(2)!.onBoard = true;
  world.rows.get(3)!.state = "CLOSED";
  world.budget = { account: "a", resource: "graphql", remaining: 10, limit: 20, resetAt: null };
  const told: unknown[] = [];
  const items = rows.ticketAdapter({ run: refused, scope: SCOPE }).readOpenItems({ onBudget: (budget) => told.push(budget) });
  assert.deepEqual(items?.map(({ ref, onBoard }) => [ref.id, onBoard]), [[1, false], [2, true]]);
  assert.deepEqual(told, [world.budget]);
});

test("rows by label, claimed rows, a window since a time, and the pure helpers a caller folds pages with", () => {
  const { world, rows } = seeded();
  world.rows.get(1)!.labels.push("in-progress");
  world.rows.get(2)!.labels.push("in-progress");
  world.rows.get(2)!.state = "CLOSED";
  assert.deepEqual(rows.readRowsByLabel({ label: "in-progress", state: "OPEN", select: "number", run: refused }).map((node) => node.number), [1]);
  assert.deepEqual(rows.readRowsByLabel({ label: "in-progress", state: "CLOSED", select: "number", run: refused }).map((node) => node.number), [2]);
  assert.deepEqual(rows.readClaimedRows({ run: refused }).map((row) => row.number), [1]);
  const since = rows.readRowsSince({ ask: { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo: SCOPE, select: "number", since: "2026-10-02T00:00:00Z" }, run: refused });
  assert.deepEqual(since.map((node) => node.number), [3], "row 2 is closed, and the window asks for the open ones");
  assert.deepEqual(rows.readRowsSince({ ask: { kind: "issues", states: ["OPEN", "CLOSED"], orderBy: "CREATED_AT", repo: SCOPE, select: "number", since: "2026-10-02T00:00:00Z" }, run: refused }).map((node) => node.number), [3, 2]);
  assert.deepEqual(rows.readRowsSince({ ask: { kind: "issues", states: ["OPEN", "CLOSED"], label: "in-progress", orderBy: "CREATED_AT", repo: SCOPE, select: "number", newest: 5 }, run: refused }).map((node) => node.number), [2, 1], "by label, newest first");
  assert.deepEqual(rows.readRowsSince({ ask: { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo: SCOPE, select: "number", newest: 1 }, run: refused }).map((node) => node.number), [3]);
  assert.equal(rows.readUnlessRefused({ what: "x", run: refused, read: () => 7 }), 7);
  assert.ok(rows.isSinceRead(rows.sincePageArgs({ kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo: SCOPE, select: "number", newest: 1 }, null)));
  assert.throws(() => rows.parsePage("{}", { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo: SCOPE, select: "number", newest: 1 }), /not a connection/);
});

test("creating a row, commenting, editing a comment, closing a row and boarding a filed one", () => {
  const { world, rows } = seeded();
  const number = rows.createRow({ repo: SCOPE, title: "Tick record", labels: ["lane:ceo"], body: "b", run: refused });
  assert.deepEqual([world.rows.get(number)!.title, world.rows.get(number)!.labels], ["Tick record", ["lane:ceo"]]);
  rows.postRowComment({ repo: SCOPE, row: number, body: "marker one", run: refused });
  rows.commentOnIssue({ repo: SCOPE, issue: number, body: "another", run: refused });
  const [first] = rows.keyedCommentsOf({ repo: SCOPE, row: number, marker: "marker", since: "2000-01-01T00:00:00Z", run: refused });
  assert.equal(first?.body, "marker one");
  rows.editComment({ repo: SCOPE, id: first!.id, body: "marker two", run: refused });
  assert.equal(rows.keyedCommentsOf({ repo: SCOPE, row: number, marker: "marker two", since: "2000-01-01T00:00:00Z", run: refused }).length, 1);
  assert.equal(rows.commentsSince({ repo: SCOPE, since: 0, run: () => null })?.length, 2, "every comment of the repository since the time");
  assert.equal(rows.isIssueOnBoard(number, { read: refused }), false);
  rows.boardFiledRow({ repo: SCOPE, number, owner: "o", projectNumber: 1, status: "Ready", labels: ["ready"], run: refused });
  assert.deepEqual([rows.isIssueOnBoard(number, { read: refused }), world.rows.get(number)!.boardStatus, world.rows.get(number)!.labels], [true, "Ready", ["lane:ceo", "ready"]]);
  rows.closeRowWithComment({ row: number, repo: SCOPE, comment: "Done.", run: refused });
  assert.equal(world.rows.get(number)!.state, "CLOSED");
  assert.throws(() => rows.closeRowWithComment({ row: 999, repo: SCOPE, comment: "x", run: refused }), /holds no row #999/, "a close of a row it holds none of is a refusal, never done");
  rows.ensureTriageLabel({ repo: SCOPE, label: "triage", description: "d", run: refused });
  rows.ensureTriageLabel({ repo: SCOPE, label: "triage", description: "d", run: refused });
  assert.deepEqual(world.labelsCreated, ["triage"], "a second create is harmless");
});

test("incidents are the rows labelled `incident`: open and closed ones are told apart, filing adds one and closing leaves a comment", () => {
  const { world, rows } = seeded();
  rows.createIncident(SCOPE, { title: "Release failed", body: "kind: release" }, refused);
  const [open] = rows.openIncidentsOf(SCOPE, refused)!;
  assert.deepEqual([open!.title, open!.body], ["Release failed", "kind: release"]);
  assert.deepEqual(rows.closedIncidentsOf(SCOPE, refused), []);
  rows.closeIncident(SCOPE, open!.number, "Fixed.", refused);
  assert.deepEqual(rows.openIncidentsOf(SCOPE, refused), []);
  assert.deepEqual(rows.closedIncidentsOf(SCOPE, refused)?.map((row) => row.number), [open!.number]);
  assert.equal(world.rows.get(open!.number)!.comments.at(-1)?.body, "Fixed.");
});

test("pull requests: the fields asked, the open heads, arming, readiness, the chairman's brief and the merge queue", () => {
  const { world, rows } = seeded();
  world.pulls.set(7, { number: 7, body: "Closes #1", headRefName: "agent/row-1", labels: [], isDraft: true, armed: true, merged: false, mergedAt: null, createdAt: "2026-10-05T00:00:00Z", comments: [] });
  world.pulls.set(8, { number: 8, body: "", headRefName: "agent/row-2", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-06T00:00:00Z", createdAt: "2026-10-05T00:00:00Z", comments: [] });
  assert.deepEqual(rows.openPullFieldsOf({ repo: SCOPE, fields: "number,isDraft", run: refused }), [{ number: 7, isDraft: true }]);
  assert.deepEqual(rows.openPullBodiesOf(SCOPE, refused), [{ number: 7, body: "Closes #1" }]);
  assert.deepEqual(rows.readOpenPullHeads(SCOPE, refused, 10), { read: true, pulls: [{ number: 7, url: "https://github.com/fake/pull/7", headRefName: "agent/row-1", labels: [] }] });
  assert.equal(rows.readOpenPullHeads(SCOPE, refused, 1).read, false, "a list that fills its limit may be cut short, so it is no reading");
  assert.equal(rows.pullRequestFieldsOf({ repo: SCOPE, number: 99, fields: "number", run: refused }), null, "a pull request it holds none of cannot be read");
  rows.readyPullRequest({ number: 7, repo: SCOPE, run: refused });
  assert.equal(world.pulls.get(7)!.isDraft, false);
  rows.readyPullRequest({ number: 7, repo: SCOPE, run: refused, undo: true });
  assert.equal(world.pulls.get(7)!.isDraft, true);
  assert.equal(rows.readDisarmSeat({ number: "7", repo: SCOPE, run: refused }).armed, true);
  rows.disableAutoMergeOf({ number: "7", repo: SCOPE, run: refused });
  assert.equal(rows.readDisarmSeat({ number: "7", repo: SCOPE, run: refused }).armed, false);
  rows.briefChairmanOnPull({ repo: SCOPE, number: 7, label: "needs:chairman", body: "Brief.", run: refused });
  assert.deepEqual([world.pulls.get(7)!.labels, world.pulls.get(7)!.comments], [["needs:chairman"], ["Brief."]]);
  assert.deepEqual(rows.readMergedPullRequests({ repo: SCOPE, select: "number", run: refused, window: { newest: 5 } }).map((pull) => pull.number), [8]);
  world.queue.entries = [{ state: "AWAITING_CHECKS", enqueuedAt: "t", position: 1, headSha: "abc", pull: 7, pullId: "PR_node_7" }];
  assert.equal(rows.queueEntriesOf({ repo: SCOPE, branch: "main", run: refused }).length, 1);
  assert.equal(rows.readDisarmSeat({ number: "7", repo: SCOPE, run: refused }).queued, true);
  assert.equal(rows.mergeGroupRunCountOf({ repo: SCOPE, sha: "abc", run: refused }), 1, "a group with no run seeded has one");
  world.queue.runs.set("abc", 0);
  assert.equal(rows.mergeGroupRunCountOf({ repo: SCOPE, sha: "abc", run: refused }), 0);
  world.queue.dequeueRefusal = "not in the queue";
  assert.throws(() => rows.dequeuePullRequestOf({ pullId: "PR_node_7", run: refused }), /not in the queue/);
  assert.deepEqual(world.queue.dequeued, ["PR_node_7"], "a dequeue that was asked for is recorded even when it is refused");
  world.queue.entries = new Error("HTTP 502");
  assert.throws(() => rows.queueEntriesOf({ repo: SCOPE, branch: "main", run: refused }), /HTTP 502/);
});

test("an operation whose answer is GitHub's own throws, naming itself, and is never an empty answer", () => {
  const { rows } = seeded();
  for (const operation of ["approvalFactsOf", "testsFirstReadsOf", "pullTextOf"] as const) {
    assert.throws(() => (rows[operation] as (...args: unknown[]) => unknown)("o/r", 1, refused), new RegExp(`do not model ${operation}`));
  }
});

test("the CI reads the cross-repo-red verdict makes (A11-160, step 5) answer from the world: a head's check runs, a workflow's runs, a run's jobs and failed log, and a row's state; an entry that is an Error throws it", () => {
  const { world, rows } = seeded();
  world.pulls.set(9, { number: 9, body: "", headRefName: "b", labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "t", comments: [], headRefOid: "abc" });
  world.ci.checks.set("abc", { checks: [{ name: "gate", conclusion: "success" }], total: 3 });
  world.ci.runs.set("ci.yml|event=push", [{ id: 5 }]);
  world.ci.jobs.set("5", [{ name: "gate", conclusion: "failure" }]);
  world.ci.logs.set("5", "the log");
  world.ci.rowStates.set("o/r#7", "open");
  assert.equal(rows.headOfChange("o/r", 9, refused), "abc");
  assert.deepEqual(rows.checkRunsOfHead("o/r", "abc", refused), { checks: [{ name: "gate", conclusion: "success" }], total: 3 });
  assert.deepEqual(rows.checkRunsOfHead("o/r", "nope", refused), { checks: [], total: 0 }, "a head nothing ran on has no checks, and says so");
  assert.deepEqual(rows.workflowRunsOf("o/r", "ci.yml", "event=push", refused), [{ id: 5 }]);
  assert.deepEqual(rows.workflowRunsOf("o/r", "ci.yml", "event=schedule", refused), []);
  assert.deepEqual(rows.jobsOfRun("o/r", 5, refused), [{ name: "gate", conclusion: "failure" }]);
  assert.throws(() => rows.jobsOfRun("o/r", 6, refused), /no job list for run 6/, "a run with no jobs seeded is a job list the API did not return");
  assert.equal(rows.failedLogOfRun("o/r", 5, refused), "the log");
  assert.equal(rows.failedLogOfRun("o/r", 6, refused), "", "a run with no log seeded has an empty one");
  assert.equal(rows.stateOfRow("o/r", 7, refused), "OPEN");
  assert.throws(() => rows.stateOfRow("o/r", 8, refused), /Could not resolve to an issue/);
  world.ci.logs.set("5", new Error("HTTP 502"));
  assert.throws(() => rows.failedLogOfRun("o/r", 5, refused), /HTTP 502/);
});
