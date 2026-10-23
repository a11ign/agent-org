// no-token: gh -- the fake code host acts on its own state; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 7): WHAT THE FAKE CODE HOST MODELS OF FILING A ROW -- the world a core test of `row-file` seeds and reads. The fake ignores the `run` it is handed, so the operations below are asked with a `run` that fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const never = (): string => { throw new Error("the fake must not run a program"); };

function world() {
  const host = createFakeCodeHost();
  return { host, rows: host.rows!, world: host.rowsWorld };
}

test("a blocker is the row's state and body, and a row the world does not hold is null", () => {
  const { rows, world: w } = world();
  w.rows.set(4, fakeRow(w, 4, { state: "CLOSED", body: "b" }));
  assert.deepEqual(rows.blockerRowOf({ number: 4, repo: w.repo, run: never }), { state: "CLOSED", body: "b" });
  assert.equal(rows.blockerRowOf({ number: 5, repo: w.repo, run: never }), null);
});

test("the newest open rows are the open ones, newest first, cut at the limit, as the JSON text the list prints", () => {
  const { rows, world: w } = world();
  for (const [number, state] of [[1, "OPEN"], [2, "CLOSED"], [3, "OPEN"], [4, "OPEN"]] as const) w.rows.set(number, fakeRow(w, number, { state, title: `t${number}` }));
  assert.deepEqual(JSON.parse(rows.newestOpenRowsText({ repo: w.repo, limit: 2, run: never })), [{ number: 4, title: "t4" }, { number: 3, title: "t3" }]);
});

test("the list of open rows is what the world says instead when a test names an answer, and an error it names is thrown", () => {
  const { rows, world: w } = world();
  w.rows.set(1, fakeRow(w, 1, { title: "t" }));
  w.filing.openRowsAnswer = "Bad gateway";
  assert.equal(rows.newestOpenRowsText({ repo: w.repo, limit: 5, run: never }), "Bad gateway");
  w.filing.openRowsAnswer = new Error("HTTP 502");
  assert.throws(() => rows.newestOpenRowsText({ repo: w.repo, limit: 5, run: never }), /HTTP 502/);
  assert.deepEqual(w.calls, [`newestOpenRowsText ${w.repo} 5`, `newestOpenRowsText ${w.repo} 5`], "each list is recorded, with its repository and limit");
});

test("a row is filed from arguments into the repository they name, with the title, body and labels they carry, and its address is answered", () => {
  const { rows, world: w } = world();
  const url = rows.fileRowFromArguments({ argv: ["--title", "T", "--body=B", "--label", "ready", "--label=lane:any"], run: never });
  assert.equal(url, `https://github.com/${w.repo}/issues/1`);
  assert.deepEqual([w.rows.get(1)?.title, w.rows.get(1)?.body, w.rows.get(1)?.labels], ["T", "B", ["ready", "lane:any"]]);
  assert.match(rows.fileRowFromArguments({ argv: ["--title", "U", "--repo", "o/other"], run: never }), /o\/other\/issues\/2$/);
  assert.equal(w.foreignRows.get("o/other#2")?.title, "U");
  assert.equal(w.filing.filed.length, 2);
});

test("labels are added to a row, set whole on it, and created in a repository; its body and milestone are read", () => {
  const { rows, world: w } = world();
  w.rows.set(7, fakeRow(w, 7, { labels: ["regression"], body: "the body" }));
  rows.addLabelsToRowIn({ repo: w.repo, number: 7, labels: ["backlog", "regression"], run: never });
  assert.deepEqual(w.rows.get(7)?.labels, ["regression", "backlog"]);
  rows.setRowLabels({ repo: w.repo, number: 7, labels: ["ready"], run: never });
  assert.deepEqual(w.rows.get(7)?.labels, ["ready"]);
  rows.ensureLabelIn({ repo: "o/other", name: "lane:any", run: never });
  assert.deepEqual(w.filing.labelsCreatedIn, ["o/other:lane:any"]);
  assert.equal(rows.bodyTextOfRowIn({ repo: w.repo, number: 7, run: never }), "the body");
  assert.equal(rows.milestoneTitleOfRow({ repo: w.repo, number: 7, run: never }), "");
  w.filing.rowMilestones.set(`${w.repo}#7`, "CI reset");
  assert.equal(rows.milestoneTitleOfRow({ repo: w.repo, number: 7, run: never }), "CI reset");
  assert.throws(() => rows.bodyTextOfRowIn({ repo: w.repo, number: 99, run: never }), /holds no row/);
});

test("the milestones of a repository are what the world holds, none where it holds none, and a refused read throws", () => {
  const { rows, world: w } = world();
  assert.deepEqual(rows.milestonesOf({ repo: "o/r", run: never }), []);
  w.filing.milestones.set("o/r", [{ title: "v1", description: "Primary: yes" }, { title: " " }]);
  assert.deepEqual(rows.milestonesOf({ repo: "o/r", run: never }), [{ title: "v1", description: "Primary: yes" }, { title: " " }]);
  assert.deepEqual(rows.milestoneTitlesOf({ repo: "o/r", run: never }), ["v1"]);
  w.filing.milestones.set("o/r", new Error("HTTP 502"));
  assert.throws(() => rows.milestonesOf({ repo: "o/r", run: never }), /HTTP 502/);
  assert.throws(() => rows.milestoneTitlesOf({ repo: "o/r", run: never }), /HTTP 502/);
});

test("a board item's option is set to the option's name, read back with the item, and an item or option the world lacks is refused", () => {
  const { rows, world: w } = world();
  w.filing.roadmapFields.set("a11ign/1", { projectId: "P", fieldId: "F", options: [{ id: "o1", name: "Now" }] });
  w.filing.roadmapItems.set(`${w.repo}#9`, [{ id: "I1", number: 1, owner: "a11ign", value: null }]);
  rows.setBoardItemOption({ itemId: "I1", projectId: "P", fieldId: "F", optionId: "o1", run: never });
  assert.deepEqual(rows.roadmapItemsOf({ repo: w.repo, number: 9, field: "Roadmap", run: never }), [{ id: "I1", number: 1, owner: "a11ign", value: "Now" }]);
  assert.deepEqual(w.filing.optionsSet, [{ itemId: "I1", projectId: "P", fieldId: "F", optionId: "o1" }]);
  assert.deepEqual(w.filing.roadmapReads, [`${w.repo}#9`]);
  assert.throws(() => rows.setBoardItemOption({ itemId: "nope", projectId: "P", fieldId: "F", optionId: "o1", run: never }), /no board item/);
  assert.throws(() => rows.setBoardItemOption({ itemId: "I1", projectId: "P", fieldId: "F", optionId: "nope", run: never }), /no option/);
  assert.deepEqual(rows.roadmapItemsOf({ repo: w.repo, number: 10, field: "Roadmap", run: never }), [], "a row on no board has no item");
  w.filing.roadmapItems.set(`${w.repo}#11`, new Error("HTTP 502"));
  assert.throws(() => rows.roadmapItemsOf({ repo: w.repo, number: 11, field: "Roadmap", run: never }), /HTTP 502/);
});

test("a board's field is what the world holds, null for a board without it, and a board it holds nothing of cannot be read", () => {
  const { rows, world: w } = world();
  assert.throws(() => rows.roadmapFieldOf({ owner: "a11ign", boardNumber: 3, field: "Roadmap", run: never }), /could not read a11ign\/projects\/3/);
  w.filing.roadmapFields.set("a11ign/3", null);
  assert.equal(rows.roadmapFieldOf({ owner: "a11ign", boardNumber: 3, field: "Roadmap", run: never }), null);
  w.filing.roadmapFields.set("a11ign/3", { projectId: "P", fieldId: "F", options: [] });
  assert.deepEqual(rows.roadmapFieldOf({ owner: "a11ign", boardNumber: 3, field: "Roadmap", run: never }), { projectId: "P", fieldId: "F", options: [] });
});

test("the runner the fake makes of a program runner refuses: nothing in the fake runs a program", () => {
  const { rows } = world();
  assert.throws(() => rows.argumentsRunOf(() => "x")(["a"]), /no program/);
});
