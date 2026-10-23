// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 7): THE FAKE CODE HOST'S OPERATIONS FOR THE CLAIM. Core's tests of `row-claim.ts` seed the world's rows and call the claim with no `gh` to stub; these cases hold what they rely on: the REST read of a
 * row and its comments, the write of its labels in one request, the edit that removes and adds, and what GitHub does that a claim depends on (a row that is not there is a 404, an added label that was never created
 * is refused after the removals landed).
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
  world.rows.set(7, fakeRow(world, 7, { title: "A row", labels: ["ready", "lane:x"], comments: [{ id: 1, body: "one", createdAt: "2026-10-04T10:00:00Z" }, { id: 2, body: "two", createdAt: "2026-10-04T11:00:00Z" }] }));
  return { world, rows: host.rows! };
}

test("a row is read as REST states it: labels by name, state upper-cased, and a row that is not there is the 404 a claim hints at", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.readRestRow({ repo: world.repo, number: 7, run: refused }), { row: { number: 7, title: "A row", labels: ["ready", "lane:x"], state: "OPEN" } });
  assert.throws(() => rows.readRestRow({ repo: world.repo, number: 99, run: refused }), (error: Error & { stderr?: string }) => /HTTP 404/.test(error.stderr ?? ""), "the refusal carries stderr, as execFileSync's did");
  assert.throws(() => rows.readRestRow({ repo: "other/repo", number: 7, run: refused }), /HTTP 404/, "the same number in another repository is not this row");
  world.foreignRows.set("other/repo#7", fakeRow(world, 7, { title: "Another tracker's row", state: "CLOSED" }));
  assert.equal((rows.readRestRow({ repo: "other/repo", number: 7, run: refused }) as { row: { title: string; state: string } }).row.title, "Another tracker's row");
  world.claim.unreadable.set(7, "row-claim: gh's response for issue #7 was not JSON -- refusing to guess. First 200 chars: x");
  assert.deepEqual(rows.readRestRow({ repo: world.repo, number: 7, run: refused }), { unreadable: "row-claim: gh's response for issue #7 was not JSON -- refusing to guess. First 200 chars: x" });
});

test("the comments are the bodies, oldest first, the newest hundred", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.readRestComments({ repo: world.repo, number: 7, run: refused }), { comments: ["one", "two"] });
  world.claim.commentsUnreadable.set(7, "row-claim: gh's response for issue #7's comments was not a list of pages");
  assert.ok("unreadable" in rows.readRestComments({ repo: world.repo, number: 7, run: refused }));
});

test("the labels are set to exactly the list given, in one request", () => {
  const { world, rows } = seeded();
  rows.setRowLabels({ repo: world.repo, number: 7, labels: ["in-progress", "session:a"], run: refused });
  assert.deepEqual(world.rows.get(7)!.labels, ["in-progress", "session:a"]);
});

test("an edit removes, then adds; an added label that was never created is REFUSED after the removals landed, and creating it first makes the edit land", () => {
  const { world, rows } = seeded();
  assert.throws(() => rows.editRowLabels({ repo: world.repo, number: 7, remove: ["ready"], add: ["session:b"], run: refused }), /session:b/);
  assert.deepEqual(world.rows.get(7)!.labels, ["lane:x"], "#677: the removal applied while the add did not");
  rows.ensureLabelIn({ repo: world.repo, name: "session:b", run: refused });
  rows.editRowLabels({ repo: world.repo, number: 7, remove: [], add: ["session:b"], run: refused });
  assert.deepEqual(world.rows.get(7)!.labels, ["lane:x", "session:b"]);
  world.claim.dropEdits = true;
  rows.editRowLabels({ repo: world.repo, number: 7, remove: ["lane:x"], add: [], run: refused });
  assert.deepEqual(world.rows.get(7)!.labels, ["lane:x", "session:b"], "an edit that exits well and changes nothing, which the decline's read-back exists to catch");
});

test("the arguments a batch is handed name the label and the repository", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.ensureLabelArgs("started", "o/r"), ["fake-ensure-label", "o/r", "started"]);
});
