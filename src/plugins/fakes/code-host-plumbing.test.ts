// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9): THE FAKE CODE HOST'S OPERATIONS FOR THE TOOL-VERSION AGREEMENT, THE HOST CHECK, THE GRAPHQL POOL'S PROBE AND THE REVIEW EVAL. Core's tests of those callers seed the world and call them with no
 * `run`; these cases hold what they rely on: a seeded release, run and log answer as the plugin's reads do, a seeded `Error` and a read the world holds nothing for are refusals (never an empty answer), a row's labels are
 * the world's, and the runner that never throws is the one thing the fake cannot be: it has no program.
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
  world.rows.set(7, fakeRow(world, 7, { title: "a worker's row", body: "the body", labels: ["tier:haiku", "in-progress"] }));
  return { world, rows: host.rows!, plumbing: world.tail.plumbing };
}

test("a seeded release answers its date, a release with none answers null, and an unseeded or refused one throws", () => {
  const { plumbing, rows } = seeded();
  plumbing.releases.set("a11ign/agent-org@v0.22.0", 1759608929000);
  plumbing.releases.set("a11ign/agent-org@v0.21.0", null);
  plumbing.releases.set("a11ign/agent-org@v0.20.0", new Error("HTTP 404"));
  assert.equal(rows.releasePublishedAtOf({ repo: "a11ign/agent-org", tag: "v0.22.0", run: refused }), 1759608929000);
  assert.equal(rows.releasePublishedAtOf({ repo: "a11ign/agent-org", tag: "v0.21.0", run: refused }), null);
  assert.throws(() => rows.releasePublishedAtOf({ repo: "a11ign/agent-org", tag: "v0.20.0", run: refused }), /HTTP 404/);
  assert.throws(() => rows.releasePublishedAtOf({ repo: "a11ign/agent-org", tag: "v9.9.9", run: refused }), /holds no release/, "a release the world does not hold is refused, never an empty answer");
});

test("the gating run and a run's log are the world's: a repository with no run answers null, an expired log is the empty log, and a refusal throws", () => {
  const { world, plumbing, rows } = seeded();
  plumbing.ciRuns.set("a11ign/a11ign", { id: 77, sha: "a".repeat(40), createdAt: "2026-10-04T10:00:00Z", event: "merge_group" });
  plumbing.ciRuns.set("o/none", null);
  plumbing.ciRuns.set("o/refused", new Error("HTTP 502"));
  plumbing.runLogs.set(77, "agent-org resolved v0.22.0");
  plumbing.runLogs.set(78, "");
  plumbing.runLogs.set(79, new Error("HTTP 403"));
  assert.deepEqual(rows.gatingCiRunOf({ repo: "a11ign/a11ign", run: refused }), { id: 77, sha: "a".repeat(40), createdAt: "2026-10-04T10:00:00Z", event: "merge_group" });
  assert.equal(rows.gatingCiRunOf({ repo: "o/none", run: refused }), null);
  assert.throws(() => rows.gatingCiRunOf({ repo: "o/refused", run: refused }), /HTTP 502/);
  assert.throws(() => rows.gatingCiRunOf({ repo: "o/unseeded", run: refused }), /holds no workflow runs/);
  assert.equal(rows.ciRunLogOf({ repo: "a11ign/a11ign", id: 77, run: refused }), "agent-org resolved v0.22.0");
  assert.equal(rows.ciRunLogOf({ repo: "a11ign/a11ign", id: 78, run: refused }), "");
  assert.throws(() => rows.ciRunLogOf({ repo: "a11ign/a11ign", id: 79, run: refused }), /HTTP 403/);
  assert.throws(() => rows.ciRunLogOf({ repo: "a11ign/a11ign", id: 80, run: refused }), /holds no run log/);
  assert.deepEqual(world.calls.filter((call) => call.startsWith("ciRunLogOf")), ["ciRunLogOf a11ign/a11ign 77", "ciRunLogOf a11ign/a11ign 78", "ciRunLogOf a11ign/a11ign 79", "ciRunLogOf a11ign/a11ign 80"], "each read is in the world's calls, so a test counts them");
});

test("a row's label names, title and body are the world's row, and a row it does not hold is refused", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.restLabelNamesOf({ repo: "a11ign/a11ign", number: 7, run: refused }), ["tier:haiku", "in-progress"]);
  assert.deepEqual(rows.rowForReviewEvalOf({ repo: "a11ign/a11ign", number: 7, run: refused }), { title: "a worker's row", body: "the body" });
  assert.throws(() => rows.restLabelNamesOf({ repo: "a11ign/a11ign", number: 99, run: refused }), /holds no row/);
  const read = rows.restLabelNamesOf({ repo: "a11ign/a11ign", number: 7, run: refused });
  read.push("mutated");
  assert.deepEqual(world.rows.get(7)!.labels, ["tier:haiku", "in-progress"], "a caller that edits the list it was given does not edit the row");
});

test("a seeded pull request is what the review eval reads, and an unseeded one is refused", () => {
  const { plumbing, rows } = seeded();
  plumbing.evalPulls.set("a11ign/agent-org#1243", { title: "t", body: "Closes #1200", baseRefOid: "base", headRefOid: "head" });
  assert.deepEqual(rows.pullForReviewEvalOf({ repo: "a11ign/agent-org", number: 1243, run: refused }), { title: "t", body: "Closes #1200", baseRefOid: "base", headRefOid: "head" });
  assert.throws(() => rows.pullForReviewEvalOf({ repo: "a11ign/agent-org", number: 1, run: refused }), /holds no pull request/);
});

test("the pool's probe is told from the core pool's, and the runner that never throws throws when it is run: the fake has no program", () => {
  const { rows } = seeded();
  assert.notDeepEqual([...rows.graphqlPoolProbeArgs()], [...rows.corePoolProbe]);
  assert.throws(() => rows.answeringRunnerWith({ cwd: "/x" })(["issue", "view", "1"]), /fake code host has no gh/);
});
