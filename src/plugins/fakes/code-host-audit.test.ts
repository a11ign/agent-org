// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9): THE FAKE CODE HOST'S OPERATIONS FOR THE READY-LABEL AUDIT, THE RETRO'S UNWAITED-STOCK COUNT, THE UN-PARK OF SATISFIED ROWS AND THE TICK'S HEARTBEAT. Core's tests of those callers seed the world and call them
 * with no `run`; these cases hold what they rely on: the listings (by state, by fields, by milestone, a limit), a second tracker held beside the world's own and one that is not, what closes what, and what the heartbeat wrote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";
import { holdRepository } from "./code-host-health.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};
const HOME = "a11ign/a11ign";
const OTHER = "a11ign/agent-org";

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = HOME;
  world.rows.set(1, fakeRow(world, 1, { title: "open row", body: "b1", labels: ["ready", "lane:any"], blockedBy: [2], comments: [{ id: 1, body: "c", createdAt: "2026-10-01T00:00:00Z" }] }));
  world.rows.set(2, fakeRow(world, 2, { title: "closed row", state: "CLOSED", closedAt: "2026-10-02T00:00:00Z", labels: [] }));
  world.rows.set(3, fakeRow(world, 3, { title: "milestoned", labels: ["backlog"], milestone: { number: 1, title: "Out of release", description: "d", dueOn: null } }));
  world.misc.stateReasons.set(2, "NOT_PLANNED");
  const pull = (number: number, over: object) => ({ number, body: `Closes #${number}`, headRefName: `agent/${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-01T00:00:00Z", comments: [], ...over });
  world.pulls.set(10, pull(10, { merged: true, mergedAt: "2026-10-03T00:00:00Z", closes: [{ number: 2, labels: [] }] }));
  world.pulls.set(11, pull(11, { closes: [{ number: 1, labels: [] }] }));
  world.pulls.set(12, pull(12, { closedAt: "2026-10-04T00:00:00Z", closes: [{ number: 2, labels: [] }, { number: 1, labels: [] }] }));
  return { host, world, rows: host.rows! };
}

test("an issue listing is the world's rows in a state, cut at the limit, with only the fields asked for and the labels as names", () => {
  const { rows } = seeded();
  const ask = (state: "open" | "closed" | "all", fields: Parameters<typeof rows.issueListingOf>[0]["fields"], limit = 10, milestone?: string) =>
    rows.issueListingOf({ repo: HOME, state, limit, fields, what: "x", run: refused, ...(milestone === undefined ? {} : { milestone }) });
  assert.deepEqual(ask("open", ["number", "title", "labels", "state"]), { rows: [
    { number: 1, title: "open row", labels: ["ready", "lane:any"], state: "OPEN" }, { number: 3, title: "milestoned", labels: ["backlog"], state: "OPEN" }] });
  assert.deepEqual(ask("closed", ["number", "closedAt", "stateReason"]), { rows: [{ number: 2, closedAt: "2026-10-02T00:00:00Z", stateReason: "NOT_PLANNED" }] });
  assert.equal((ask("all", ["number"]) as { rows: unknown[] }).rows.length, 3);
  assert.equal((ask("all", ["number"], 2) as { rows: unknown[] }).rows.length, 2, "the limit is the listing's: a full page is how the audit knows to ask for more");
  assert.deepEqual(ask("open", ["number"], 10, "Out of release"), { rows: [{ number: 3 }] });
  assert.deepEqual(ask("open", ["number", "blockedBy"]), { rows: [{ number: 1, blockedBy: { totalCount: 1, nodes: [{ number: 2, state: "CLOSED" }] } }, { number: 3, blockedBy: { totalCount: 0, nodes: [] } }] });
});

test("edges a row's listing could not read are absent, never an empty list", () => {
  const { world, rows } = seeded();
  world.rows.get(1)!.blockedByUnread = true;
  const listed = rows.issueListingOf({ repo: HOME, state: "open", limit: 10, fields: ["number", "blockedBy"], what: "x", run: refused }) as { rows: { number: number; blockedBy?: unknown }[] };
  assert.equal("blockedBy" in listed.rows[0], false);
  assert.equal("blockedBy" in listed.rows[1], true);
});

test("a pull request listing is open or closed-without-merging, as `gh pr list` has it, with the fields asked for", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.pullListingOf({ repo: HOME, state: "open", limit: 10, fields: ["number", "body", "headRefName"], what: "x", run: refused }), { rows: [{ number: 11, body: "Closes #11", headRefName: "agent/11" }] });
  assert.deepEqual(rows.pullListingOf({ repo: HOME, state: "closed", limit: 10, fields: ["number", "mergedAt"], what: "x", run: refused }), { rows: [{ number: 12, mergedAt: null }] }, "a merged pull request is not a closed one");
});

test("a second tracker is read when the world holds it and refused when it does not; a refusal can be named for one repository", () => {
  const { world, rows } = seeded();
  const other = () => rows.issueListingOf({ repo: OTHER, state: "open", limit: 10, fields: ["number", "title"], what: "x", run: refused });
  assert.throws(other, /holds no rows of a11ign\/agent-org/, "a repository the world holds nothing of is a refused read, never an empty one");
  holdRepository(world, OTHER, { rows: [fakeRow(world, 9, { title: "only in agent-org" })] });
  assert.deepEqual(other(), { rows: [{ number: 9, title: "only in agent-org" }] });
  assert.deepEqual(rows.reportedOpenIssueNumbersOf({ repo: OTHER, run: refused }), { numbers: [9] });
  world.failures.set(`issueListingOf ${OTHER}`, new Error("HTTP 502"));
  assert.throws(other, /HTTP 502/);
  assert.deepEqual((rows.issueListingOf({ repo: HOME, state: "open", limit: 10, fields: ["number"], what: "x", run: refused }) as { rows: unknown[] }).rows.length, 2, "the home repository is not refused with it");
  world.failures.clear();
  world.failures.set("reportedOpenIssueNumbersOf", new Error("HTTP 503"));
  assert.throws(() => rows.reportedOpenIssueNumbersOf({ repo: HOME, run: refused }), /HTTP 503/, "and a refusal named for no repository is every repository's");
});

test("what GitHub's search index reports open is the open rows, unless a test says it reports otherwise", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.reportedOpenIssueNumbersOf({ repo: HOME, run: refused }), { numbers: [1, 3] });
  world.tail.audit.reportedOpen.set(HOME, [1, 2, 3, 4]);
  assert.deepEqual(rows.reportedOpenIssueNumbersOf({ repo: HOME, run: refused }), { numbers: [1, 2, 3, 4] });
});

test("what closes what: the pull requests that name a row, from the row's side and from the pull request's side, and the merged ones", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.closingReferencesOf({ repo: HOME, numbers: [1, 2], run: refused }), { references: new Map([
    [1, [{ number: 11, state: "OPEN", mergedAt: null }, { number: 12, state: "CLOSED", mergedAt: null }]],
    [2, [{ number: 10, state: "MERGED", mergedAt: "2026-10-03T00:00:00Z" }, { number: 12, state: "CLOSED", mergedAt: null }]]]) });
  assert.deepEqual(rows.closingIssueReferencesOf({ repo: HOME, numbers: [12], run: refused }), { references: new Map([[12, [2, 1]]]) });
  assert.deepEqual(rows.mergedClosersOf({ repo: HOME, number: 2, run: refused }), [{ number: 10, mergedAt: "2026-10-03T00:00:00Z" }]);
  assert.deepEqual(rows.mergedClosersOf({ repo: HOME, number: 1, run: refused }), [], "an open and a closed-unmerged pull request are not merged closers");
  assert.deepEqual(rows.closingReferencesOf({ repo: HOME, numbers: [99], run: refused }), { unreadable: "issue #99 is missing from the closing-references response -- refusing to guess. Got: null" });
  assert.deepEqual(rows.closingIssueReferencesOf({ repo: HOME, numbers: [99], run: refused }), { unreadable: "PR #99 is missing from the closing-issue-references response -- refusing to guess. Got: null" });
  world.tail.audit.reopenedAt.set(`${HOME}#1`, "2026-10-05T00:00:00Z");
  assert.deepEqual(rows.latestReopenedAtOf({ repo: HOME, numbers: [1, 2], run: refused }), { reopenedAt: new Map([[1, "2026-10-05T00:00:00Z"], [2, null]]) });
});

test("a row's label history is the gate's: when a label was last put on it, and its timeline for the stock count", () => {
  const { world, rows } = seeded();
  world.gate.events.set(1, [{ event: "labeled", label: "in-progress", actor: null, at: "2026-10-01T00:00:00Z" }, { event: "unlabeled", label: "in-progress", actor: null, at: "2026-10-02T00:00:00Z" },
    { event: "labeled", label: "in-progress", actor: null, at: "2026-10-03T00:00:00Z" }]);
  assert.equal(rows.newestLabeledAtOf({ repo: HOME, number: 1, label: "in-progress", run: refused }), "2026-10-03T00:00:00Z");
  assert.equal(rows.newestLabeledAtOf({ repo: HOME, number: 1, label: "ready", run: refused }), null);
  assert.equal(rows.newestLabeledAtOf({ repo: HOME, number: 3, label: "ready", run: refused }), null, "a row with no history has no event");
  assert.deepEqual(rows.stockTimelineEventsOf({ repo: HOME, number: 1, run: refused }).map((e) => [e.event, e.label?.name, e.created_at]), [
    ["labeled", "in-progress", "2026-10-01T00:00:00Z"], ["unlabeled", "in-progress", "2026-10-02T00:00:00Z"], ["labeled", "in-progress", "2026-10-03T00:00:00Z"]]);
  world.gate.events.set(1, new Error("HTTP 502"));
  assert.throws(() => rows.stockTimelineEventsOf({ repo: HOME, number: 1, run: refused }), /HTTP 502/);
  assert.throws(() => rows.newestLabeledAtOf({ repo: HOME, number: 1, label: "x", run: refused }), /HTTP 502/);
});

test("a row's newest comment, labels and state, close time, and the milestone and blocker-edge facts a test seeds", () => {
  const { world, rows } = seeded();
  assert.equal(rows.newestCommentAtOf({ repo: HOME, number: 1, run: refused }), "2026-10-01T00:00:00Z");
  assert.equal(rows.newestCommentAtOf({ repo: HOME, number: 3, run: refused }), null);
  assert.deepEqual(rows.rowLabelsAndStateOf({ repo: HOME, number: 1, run: refused }), { labels: ["ready", "lane:any"], state: "OPEN" });
  assert.throws(() => rows.rowLabelsAndStateOf({ repo: HOME, number: 99, run: refused }), /holds no row/);
  assert.equal(rows.closedAtOf({ repo: HOME, number: 2, run: refused }), Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(rows.closedAtOf({ repo: HOME, number: 1, run: refused }), null, "an open row has not closed");
  assert.equal(rows.milestoneDescriptionOf({ repo: HOME, title: "Out of release", run: refused }), null);
  world.tail.audit.milestones.set(HOME, [{ title: "Out of release", description: "the rule" }]);
  assert.equal(rows.milestoneDescriptionOf({ repo: HOME, title: "Out of release", run: refused }), "the rule");
  assert.equal(rows.blockedByAddedAtOf({ repo: HOME, holder: 1, blocker: 2, run: refused }), null);
  world.tail.audit.blockedByAdded.set(`${HOME}#1->2`, "2026-10-09T00:00:00Z");
  assert.equal(rows.blockedByAddedAtOf({ repo: HOME, holder: 1, blocker: 2, run: refused }), "2026-10-09T00:00:00Z");
});

test("the heartbeat variable is what the tick sent, and every call is recorded by repository", () => {
  const { world, rows } = seeded();
  rows.writeHeartbeatVariable({ repo: HOME, variable: "GATE_LAST_TICK", value: "17", run: refused });
  assert.equal(world.tail.audit.variables.get(`${HOME}/GATE_LAST_TICK`), "17");
  world.failures.set(`writeHeartbeatVariable ${HOME}`, new Error("HTTP 403"));
  assert.throws(() => rows.writeHeartbeatVariable({ repo: HOME, variable: "GATE_LAST_TICK", value: "18", run: refused }), /HTTP 403/);
  assert.equal(world.tail.audit.variables.get(`${HOME}/GATE_LAST_TICK`), "17", "a refused write changes nothing");
  assert.deepEqual(world.calls.filter((call) => call.startsWith("writeHeartbeat")), [`writeHeartbeatVariable ${HOME}`, `writeHeartbeatVariable ${HOME}`]);
});
