// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 7): THE FAKE CODE HOST'S OPERATIONS FOR THE CLAIM'S CLOCK, THE PROVENANCE AUDIT, THE REACHABILITY CHECK, THE DUPLICATE-ROW CHECK AND THE LABEL STRIP. Core's tests of those callers seed the world and call them
 * with no `run`; these cases hold what they rely on: a row's label history, the three texts the audit reads (rendered from the rows and events, in the shape the plugin's reads answer), the pull request states, the
 * REST listing of open rows, and the label strip's effect on a row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "a11ign/a11ign";
  world.rows.set(1, fakeRow(world, 1, { title: "open row", body: "## Region\n", labels: ["ready", "session:a"] }));
  world.rows.set(2, fakeRow(world, 2, { title: "closed row", state: "CLOSED", closedAt: "2026-09-09T10:00:00Z", labels: ["was-ready"] }));
  world.rows.set(3, fakeRow(world, 3, { title: "not planned", state: "CLOSED", closedAt: "2026-09-09T11:00:00Z" }));
  world.misc.stateReasons.set(3, "NOT_PLANNED");
  world.gate.events.set(2, [{ event: "labeled", label: "session:a", actor: null, at: "2026-09-09T09:00:00Z" }, { event: "unlabeled", label: "session:a", actor: "x", at: "2026-09-09T10:00:00Z" }]);
  world.pulls.set(10, { number: 10, body: "Closes #2", headRefName: "agent/two", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-09-09T10:00:00Z", createdAt: "2026-09-09T09:30:00Z", comments: [], title: "two" });
  world.pulls.set(11, { number: 11, body: "", headRefName: "agent/one", labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-09-09T09:30:00Z", comments: [] });
  return { world, rows: host.rows! };
}

test("a row's label events are the history the gate holds, and a refused history throws", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.labelEventsOf({ repo: "a11ign/a11ign", row: 2, run: refused }), [{ event: "labeled", label: "session:a", at: "2026-09-09T09:00:00Z" }, { event: "unlabeled", label: "session:a", at: "2026-09-09T10:00:00Z" }]);
  assert.deepEqual(rows.labelEventsOf({ repo: "a11ign/a11ign", row: 1, run: refused }), [], "a row with no history: the read worked");
  world.gate.events.set(1, new Error("HTTP 502"));
  assert.throws(() => rows.labelEventsOf({ repo: "a11ign/a11ign", row: 1, run: refused }), /HTTP 502/);
});

test("the audit's texts are the closed rows, the repository's label events one per line, and the closing pull request's timeline", () => {
  const { world, rows } = seeded();
  const listing = JSON.parse(rows.closedRowListingTextOf({ repo: "a11ign/a11ign", limit: 10, run: refused }));
  assert.deepEqual(listing, [{ number: 2, title: "closed row", closedAt: "2026-09-09T10:00:00Z" }, { number: 3, title: "not planned", closedAt: "2026-09-09T11:00:00Z", stateReason: "NOT_PLANNED" }]);
  assert.equal(JSON.parse(rows.closedRowListingTextOf({ repo: "a11ign/a11ign", limit: 1, run: refused })).length, 1, "the limit is the listing's");
  const lines = rows.labelEventLogTextOf({ repo: "a11ign/a11ign", run: refused }).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => [l.number, l.event, l.label]), [[2, "labeled", "session:a"], [2, "unlabeled", "session:a"]]);
  const none = JSON.parse(rows.closingTimelineTextOf({ repo: "a11ign/a11ign", number: 2, run: refused }));
  assert.deepEqual(none.data.repository.issue.timelineItems.nodes, [], "a row no pull request closed has no closer");
  world.misc.closingPulls.set(2, { number: 10, headRefName: "agent/two", merged: true, createdAt: "2026-09-09T09:30:00Z", labels: ["session:a"] });
  const closer = JSON.parse(rows.closingTimelineTextOf({ repo: "a11ign/a11ign", number: 2, run: refused })).data.repository.issue.timelineItems.nodes[0].closer;
  assert.deepEqual([closer.number, closer.headRefName, closer.merged, closer.labels.nodes], [10, "agent/two", true, [{ name: "session:a" }]]);
});

test("pull request states: all of them with their branches, and those of one branch", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.pullStatesOf({ repo: "a11ign/a11ign", limit: 10, run: refused }), [{ number: 10, state: "MERGED", headRefName: "agent/two" }, { number: 11, state: "OPEN", headRefName: "agent/one" }]);
  assert.deepEqual(rows.pullStatesOfBranchIn({ repo: "a11ign/a11ign", branch: "agent/one", run: refused }), [{ number: 11, state: "OPEN" }]);
  assert.deepEqual(rows.pullStatesOfBranchIn({ repo: "a11ign/a11ign", branch: "agent/none", run: refused }), []);
});

test("a row's facts and body; a row the world does not hold throws", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.rowFactsIn({ repo: "a11ign/a11ign", number: 1, run: refused }), { body: "## Region\n", labels: [{ name: "ready" }, { name: "session:a" }], state: "OPEN", closedAt: null });
  assert.equal(rows.rowBodyIn({ repo: "a11ign/a11ign", number: 1, run: refused }), "## Region\n");
  assert.throws(() => rows.rowBodyIn({ repo: "a11ign/a11ign", number: 99, run: refused }), /holds no row/);
  assert.throws(() => rows.rowFactsIn({ repo: "other/repo", number: 1, run: refused }), /holds no row other\/repo#1/);
});

test("the REST listing of open rows holds the open issues and, for pulls, the open pull requests", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.openRestListingOf({ repo: "a11ign/a11ign", kind: "issues", run: refused }), [{ number: 1, title: "open row", body: "## Region\n" }]);
  assert.deepEqual(rows.openRestListingOf({ repo: "a11ign/a11ign", kind: "pulls", run: refused }).map((p) => (p as { number: number }).number), [11]);
  assert.ok(world.calls.includes("openRestListingOf issues"));
});

test("taking labels off a row takes only those, and a row the world does not hold is refused", () => {
  const { world, rows } = seeded();
  rows.removeLabelsFromRow({ repo: "a11ign/a11ign", number: 1, labels: ["ready", "session:a"], run: refused });
  assert.deepEqual(world.rows.get(1)?.labels, []);
  rows.removeLabelsFromRow({ repo: "a11ign/a11ign", number: 2, labels: ["session:a"], run: refused });
  assert.deepEqual(world.rows.get(2)?.labels, ["was-ready"], "a label the row does not carry is no error and no change");
  assert.throws(() => rows.removeLabelsFromRow({ repo: "a11ign/a11ign", number: 99, labels: ["x"], run: refused }), /holds no row/);
});
