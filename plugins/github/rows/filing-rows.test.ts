// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 7): THE ARGUMENTS AND READINGS OF THE OPERATIONS `row-file` ASKS OF GITHUB, which core's tests of the filing used to assert over a stubbed `run` and are the plugin's now (core's tests of the filing run on
 * the fake code host's rows). Each literal list below is the one `src/row-file/` built before the call moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addLabelsToRowIn, argumentsRunOf, blockerRowOf, bodyTextOfRowIn, fileRowFromArguments, milestoneTitleOfRow, milestoneTitlesOf, milestonesOf, newestOpenRowsText, roadmapFieldOf, roadmapItemsOf, setBoardItemOption } from "./filing-rows.ts";
import { setRowLabels } from "./claim-ops.ts";
import { ensureLabelIn } from "./rules-writes.ts";
import { recording } from "./recording-run.test.support.ts";

test("the runner made of a program runner hands it `gh` and the arguments unchanged", () => {
  const seen: [string, string[]][] = [];
  const answer = argumentsRunOf((program, args) => { seen.push([program, args]); return "out"; })(["issue", "view", "4"]);
  assert.equal(answer, "out");
  assert.deepEqual(seen, [["gh", ["issue", "view", "4"]]]);
});

test("a blocker is read with its state and body; an unreadable one, one with no state and an answer that is not JSON are null", () => {
  const { run, asked } = recording({ state: "OPEN", body: "b" });
  assert.deepEqual(blockerRowOf({ number: 7, repo: "o/r", run }), { state: "OPEN", body: "b" });
  assert.deepEqual(asked, [["issue", "view", "7", "--repo", "o/r", "--json", "state,body"]]);
  assert.deepEqual(blockerRowOf({ number: 7, repo: "o/r", run: recording({ state: "CLOSED" }).run }), { state: "CLOSED", body: "" }, "a body that is absent is empty");
  assert.equal(blockerRowOf({ number: 7, repo: "o/r", run: recording({ body: "b" }).run }), null);
  assert.equal(blockerRowOf({ number: 7, repo: "o/r", run: recording("not json").run }), null);
  assert.equal(blockerRowOf({ number: 7, repo: "o/r", run: recording(new Error("HTTP 502")).run }), null, "an unreadable blocker is an unknown, never an umbrella");
});

test("the newest open rows are listed with their numbers and titles, as the text GitHub printed, and a refused list throws", () => {
  const { run, asked } = recording("[]");
  assert.equal(newestOpenRowsText({ repo: "o/r", limit: 200, run }), "[]");
  assert.deepEqual(asked, [["issue", "list", "--repo", "o/r", "--state", "open", "--limit", "200", "--json", "number,title"]]);
  assert.throws(() => newestOpenRowsText({ repo: "o/r", limit: 200, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("a board item's option is set by item, project, field and option id", () => {
  const { run, asked } = recording("");
  setBoardItemOption({ itemId: "PVTI_1", projectId: "PVT_1", fieldId: "PVTSSF_1", optionId: "opt1", run });
  assert.deepEqual(asked, [["project", "item-edit", "--id", "PVTI_1", "--project-id", "PVT_1", "--field-id", "PVTSSF_1", "--single-select-option-id", "opt1"]]);
  assert.throws(() => setBoardItemOption({ itemId: "i", projectId: "p", fieldId: "f", optionId: "o", run: recording(new Error("refused")).run }), /refused/);
});

test("a row is filed from the arguments of the create command, unchanged, and its address is trimmed", () => {
  const { run, asked } = recording("https://github.com/o/r/issues/12\n");
  assert.equal(fileRowFromArguments({ argv: ["--title", "T", "--body", "B", "--label", "ready"], run }), "https://github.com/o/r/issues/12");
  assert.deepEqual(asked, [["issue", "create", "--title", "T", "--body", "B", "--label", "ready"]]);
  assert.throws(() => fileRowFromArguments({ argv: ["--title", "T"], run: recording(new Error("HTTP 422")).run }), /HTTP 422/, "a create that failed is not a row filed");
});

test("the milestones are read whole or as titles; a refusal throws, and a blank title is left out", () => {
  const whole = recording([{ title: "v1", description: "Primary: yes" }]);
  assert.deepEqual(milestonesOf({ repo: "o/r", run: whole.run }), [{ title: "v1", description: "Primary: yes" }]);
  assert.deepEqual(whole.asked, [["api", "repos/o/r/milestones"]]);
  assert.throws(() => milestonesOf({ repo: "o/r", run: recording("not json").run }));
  const titles = recording("v1\n\n  v2 \n");
  assert.deepEqual(milestoneTitlesOf({ repo: "o/r", run: titles.run }), ["v1", "v2"]);
  assert.deepEqual(titles.asked, [["api", "repos/o/r/milestones", "--jq", ".[].title"]]);
  assert.deepEqual(milestoneTitlesOf({ repo: "o/r", run: recording("").run }), []);
  assert.throws(() => milestoneTitlesOf({ repo: "o/r", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("a label is created in the repository the row is filed in, and the labels of a row are added in one edit", () => {
  const created = recording("");
  ensureLabelIn({ repo: "o/r", name: "lane:any", run: created.run });
  assert.deepEqual(created.asked, [["label", "create", "lane:any", "--repo", "o/r", "--force"]]);
  const added = recording("");
  addLabelsToRowIn({ repo: "o/r", number: 9, labels: ["backlog", "lane:any"], run: added.run });
  assert.deepEqual(added.asked, [["issue", "edit", "9", "--repo", "o/r", "--add-label", "backlog", "--add-label", "lane:any"]]);
  assert.throws(() => addLabelsToRowIn({ repo: "o/r", number: 9, labels: ["x"], run: recording(new Error("label not found")).run }), /label not found/);
});

test("a row's body and milestone are read as printed, untrimmed", () => {
  const body = recording("the body\n");
  assert.equal(bodyTextOfRowIn({ repo: "o/r", number: 3, run: body.run }), "the body\n");
  assert.deepEqual(body.asked, [["issue", "view", "3", "--repo", "o/r", "--json", "body", "--jq", ".body"]]);
  const milestone = recording("v1\n");
  assert.equal(milestoneTitleOfRow({ repo: "o/r", number: 3, run: milestone.run }), "v1\n");
  assert.deepEqual(milestone.asked, [["issue", "view", "3", "--repo", "o/r", "--json", "milestone", "--jq", ".milestone.title // \"\""]]);
  assert.throws(() => bodyTextOfRowIn({ repo: "o/r", number: 3, run: recording(new Error("HTTP 404")).run }), /HTTP 404/);
});

test("#2111: a row's whole label list is SET in one PUT, with one `-f labels[]=` per label", () => {
  const { run, asked } = recording("");
  setRowLabels({ repo: "o/r", number: 5, labels: ["ready"], run });
  assert.deepEqual(asked, [["api", "--method", "PUT", "repos/o/r/issues/5/labels", "-f", "labels[]=ready"]]);
  assert.throws(() => setRowLabels({ repo: "o/r", number: 5, labels: ["ready"], run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
});

const itemsPage = (nodes: unknown[], next: string | null = null) => ({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } } });
const item = (id: string, number: number, owner: string, value: string | null) => ({ id, project: { number, owner: { login: owner } }, fieldValueByName: value === null ? null : { name: value } });

test("a row's board items are read page by page with their value of the field, and a cut-off or malformed answer throws", () => {
  const pages = [itemsPage([item("I1", 1, "a11ign", "Now")], "CUR1"), itemsPage([item("I2", 2, "other", null)])];
  const { run, asked } = recording(() => pages.shift());
  assert.deepEqual(roadmapItemsOf({ repo: "a11ign/agent-org", number: 5, field: "Roadmap", run }), [{ id: "I1", number: 1, owner: "a11ign", value: "Now" }, { id: "I2", number: 2, owner: "other", value: null }]);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0].slice(0, 3), ["api", "graphql", "-f"]);
  assert.equal(asked[0][3], 'query=query { repository(owner: "a11ign", name: "agent-org") { issue(number: 5) { projectItems(first: 100) { pageInfo { hasNextPage endCursor } nodes { id project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "Roadmap") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }');
  assert.match(asked[1][3], /projectItems\(first: 100, after: "CUR1"\)/, "the second page continues from the cursor of the first");
  assert.throws(() => roadmapItemsOf({ repo: "o/r", number: 5, field: "Roadmap", run: recording({ data: {} }).run }), /did not have the expected shape/);
  assert.throws(() => roadmapItemsOf({ repo: "o/r", number: 5, field: "Roadmap", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("a board's field is read with its ids and options; a board without it is null, and one that cannot be read throws", () => {
  const board = { data: { repositoryOwner: { projectV2: { id: "PVT_1", field: { id: "F1", options: [{ id: "o1", name: "Now" }, { id: "o2", name: "Later" }] } } } } };
  const { run, asked } = recording(board);
  assert.deepEqual(roadmapFieldOf({ owner: "a11ign", boardNumber: 1, field: "Roadmap", run }), { projectId: "PVT_1", fieldId: "F1", options: [{ id: "o1", name: "Now" }, { id: "o2", name: "Later" }] });
  const project = 'projectV2(number: 1) { id field(name: "Roadmap") { ... on ProjectV2SingleSelectField { id options { id name } } } }';
  assert.deepEqual(asked, [["api", "graphql", "-f", `query=query { repositoryOwner(login: "a11ign") { ... on Organization { ${project} } ... on User { ${project} } } }`]]);
  assert.equal(roadmapFieldOf({ owner: "a11ign", boardNumber: 1, field: "Roadmap", run: recording({ data: { repositoryOwner: { projectV2: { id: "PVT_1", field: {} } } } }).run }), null);
  assert.throws(() => roadmapFieldOf({ owner: "a11ign", boardNumber: 1, field: "Roadmap", run: recording({ data: { repositoryOwner: null } }).run }), /could not read a11ign\/projects\/1/);
});
