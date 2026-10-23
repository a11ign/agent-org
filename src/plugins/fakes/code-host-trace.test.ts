// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 8): THE FAKE CODE HOST'S OPERATIONS FOR THE TRACE. A comment handed over by input lands on the row the world holds (and is recorded in `world.reports.trace`), a row is viewed as a read-only script
 * reads it, and the two operations whose answer is GitHub's own text (`apiTextOf`, `conditionalGetOf`) throw by name, so a test that needs them runs against the GitHub plugin's rows.
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
  world.repo = "a11ign/agent-org";
  world.rows.set(928, fakeRow(world, 928, { title: "the standing row", body: "b", labels: ["ready", "lane:any"] }));
  world.foreignRows.set("o/other#5", fakeRow(world, 5, { title: "elsewhere" }));
  return { world, rows: host.rows! };
}

test("a comment by input lands on the row of its repository, at the world's clock, and is recorded; an absent row is a throw and records nothing", () => {
  const { world, rows } = seeded();
  rows.commentOnRowByInput({ repo: "a11ign/agent-org", number: 928, body: "an incident", timeoutMs: 1 });
  rows.commentOnRowByInput({ repo: "o/other", number: "5", body: "elsewhere too", timeoutMs: 1 });
  assert.deepEqual(world.rows.get(928)!.comments.map((comment) => comment.body), ["an incident"]);
  assert.deepEqual(world.foreignRows.get("o/other#5")!.comments.map((comment) => comment.body), ["elsewhere too"]);
  assert.deepEqual(world.reports.trace.inputComments, [{ repo: "a11ign/agent-org", number: "928", body: "an incident" }, { repo: "o/other", number: "5", body: "elsewhere too" }]);
  assert.throws(() => rows.commentOnRowByInput({ repo: "a11ign/agent-org", number: 1, body: "x", timeoutMs: 1 }), /holds no row a11ign\/agent-org#1/);
  assert.equal(world.reports.trace.inputComments.length, 2, "CONTROL: the refused comment is not recorded");
});

test("a row is viewed as number, state, title, body and the labels as {name}; an absent row is a throw", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.rowSnapshotOf({ repo: "a11ign/agent-org", number: 928, run: refused }), { number: 928, state: "OPEN", title: "the standing row", body: "b", labels: [{ name: "ready" }, { name: "lane:any" }] });
  world.rows.get(928)!.state = "CLOSED";
  assert.equal(rows.rowSnapshotOf({ repo: "{owner}/{repo}", number: 928, run: refused }).state, "CLOSED");
  assert.throws(() => rows.rowSnapshotOf({ repo: "a11ign/agent-org", number: 2, run: refused }), /holds no row/);
});

test("the answers that are GitHub's own text are not modeled, and say so by name", () => {
  const { rows } = seeded();
  assert.throws(() => rows.apiTextOf({ args: ["x"], run: refused }), /do not model apiTextOf/);
  assert.throws(() => rows.conditionalGetOf({ path: "p", etag: null, maxBuffer: 1 }), /do not model conditionalGetOf/);
});
