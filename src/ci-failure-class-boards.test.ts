// no-token: none -- the fake code host holds the rows and their board; nothing here spawns `gh`
// #5405: a machine-filed incident row is BOARDED when it is filed. `recordIncident` is run on the fake code host (A11-160, step 9), and the tests read back the row it filed and what the board holds of it. The order of
// the board writes (the card, then Backlog, then the labels last) and the retry after a half-done board are `boardFiledRow`'s, and are pinned in the plugin (`plugins/github/rows/board-filed-row.test.ts`).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { recordIncident, SHARED_FAILURE_LABEL, type Run, type SharedGroup } from "./ci-failure-class.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL } from "./project-vocabulary.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow, type FakeRowsWorld } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const NEW_ROW = 9001;
const group: SharedGroup = {
  key: "a11ign/a11ign#5400|2026-10-13T10:00Z",
  signature: { check: "gate", step: "Run tests", line: "AssertionError: expected 3, got 4", file: null },
  prs: ["a11ign/a11ign#5300", "a11ign/a11ign#5301"],
  noted: ["a11ign/a11ign#5300", "a11ign/a11ign#5301"],
};
const silent = (): void => {};
/** The runner the live tool hands the code host's operations. The fake acts on its world and never calls it. */
const NO_GH: Run = () => { throw new Error("the fake code host runs nothing"); };

/** The fake code host in place; the next row it files is numbered `NEW_ROW`. */
function codeHost(): FakeRowsWorld {
  const host = createFakeCodeHost();
  host.rowsWorld.nextNumber = NEW_ROW;
  substituteCodeHost(host);
  return host.rowsWorld;
}

/** The body an incident row of `group` carries: filed once on a throwaway world, and read back. */
function bodyFiled(): string {
  const world = codeHost();
  recordIncident(group, { run: NO_GH, log: silent });
  return world.rows.get(NEW_ROW)!.body;
}

/** The fake code host in place with an open incident row #7 of `group` an earlier tick filed, on the board or not as given and carrying `labels`. */
function worldWithOpenRow({ labels = [SHARED_FAILURE_LABEL], onBoard = false }: { labels?: string[]; onBoard?: boolean } = {}): FakeRowsWorld {
  const body = bodyFiled();
  const world = codeHost();
  world.rows.set(7, fakeRow(world, 7, { body, labels, onBoard, boardStatus: onBoard ? "Backlog" : null }));
  return world;
}

/** A filing whose board step is refused: the world, the lines it logged, and what `recordIncident` reported. */
function refusedFiling() {
  const world = codeHost();
  world.failures.set("boardFiledRow", new Error("gh refused"));
  const log: string[] = [];
  const reported = recordIncident(group, { run: NO_GH, log: (line) => log.push(line) });
  return { world, log, reported };
}

test("a new incident is boarded when it is filed: on the board at Backlog, and carrying the labels that declare it out of release", () => {
  const world = codeHost();
  assert.equal(recordIncident(group, { run: NO_GH, log: silent }), NEW_ROW, "the row is reported as filed");
  const row = world.rows.get(NEW_ROW)!;
  assert.deepEqual([row.onBoard, row.boardStatus], [true, "Backlog"]);
  assert.ok(row.labels.includes(SHARED_FAILURE_LABEL) && row.labels.includes(BACKLOG_LABEL) && row.labels.includes(OUT_OF_RELEASE_LABEL), `the labels: ${row.labels.join(", ")}`);
  assert.ok(world.labelsCreated.includes(SHARED_FAILURE_LABEL), "the incident label was made sure of before the row was filed");
  assert.match(row.body, /SIGNAL for `orchestrator`/, "the body says it is a signal and carries no claimable work");
});

test("a refused board step is not reported as filed, and the next tick boards the row it already filed", () => {
  const { world, log, reported } = refusedFiling();
  assert.equal(reported, null, "not reported as filed while the board is refused");
  assert.match(log.join(""), /the next tick retries/);
  const filed = world.rows.get(NEW_ROW)!;
  assert.deepEqual([filed.onBoard, filed.labels.includes(OUT_OF_RELEASE_LABEL)], [false, false], "the row was filed, and nothing of the board was written on a refusal");
  world.failures.clear();
  assert.equal(recordIncident(group, { run: NO_GH, log: silent }), NEW_ROW, "the next tick joins the open row");
  assert.equal(world.rows.size, 1, "and files no second");
  assert.deepEqual([filed.onBoard, filed.boardStatus], [true, "Backlog"], "and boards it, because it does not yet carry the release declaration");
  assert.ok(filed.labels.includes(OUT_OF_RELEASE_LABEL), "its labels are set");
});

test("a refused board step on a joined row is not reported as filed", () => {
  const world = worldWithOpenRow();
  world.failures.set("boardFiledRow", new Error("gh refused"));
  const log: string[] = [];
  assert.equal(recordIncident(group, { run: NO_GH, log: (line) => log.push(line) }), null, "the row exists, but it is not boarded: not reported as filed");
  assert.match(log.join(""), /could not board #7.*the next tick retries/);
  assert.equal(world.rows.get(7)!.onBoard, false);
});

test("a row already boarded is joined without a second board write", () => {
  const world = worldWithOpenRow({ labels: [SHARED_FAILURE_LABEL, BACKLOG_LABEL, OUT_OF_RELEASE_LABEL], onBoard: true });
  world.failures.set("boardFiledRow", new Error("a row carrying out-of-release is not boarded again"));
  assert.equal(recordIncident(group, { run: NO_GH, log: silent }), 7, "the open row is joined");
  assert.equal(world.rows.size, 1, "and no second row is filed");
});

test("a row that has not the release declaration is boarded when it is joined, and the joined row's body keeps the PRs it had", () => {
  const world = worldWithOpenRow();
  const wider: SharedGroup = { ...group, prs: [...group.prs, "a11ign/a11ign#5302"], noted: [...group.noted, "a11ign/a11ign#5302"] };
  assert.equal(recordIncident(wider, { run: NO_GH, log: silent }), 7);
  const row = world.rows.get(7)!;
  assert.match(row.body, /Shared-failure-prs: a11ign\/a11ign#5300, a11ign\/a11ign#5301, a11ign\/a11ign#5302/, "the third PR joined the one row");
  assert.deepEqual([row.onBoard, row.labels.includes(OUT_OF_RELEASE_LABEL)], [true, true]);
});
