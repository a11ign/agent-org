// no-token: none -- a fake `gh` answers the by-label read and the Project-membership read and records every write; nothing here spawns `gh`
// #5405: a machine-filed incident row is BOARDED when it is filed. `recordIncident` is handed a fake `run`, and the tests read back the calls it made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordIncident, type Run, type SharedGroup } from "./ci-failure-class.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "./board-snapshot-scope.ts";
import { REPO } from "./project-identity.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL } from "./project-vocabulary.ts";
import { connectionOf, readsRowsByLabel, type FakeRow } from "./packaging/rows-by-label-fixtures.ts";

const NEW_ROW = 9001;
const group: SharedGroup = {
  key: "a11ign/a11ign#5400|2026-10-13T10:00Z",
  signature: { check: "gate", step: "Run tests", line: "AssertionError: expected 3, got 4", file: null },
  prs: ["a11ign/a11ign#5300", "a11ign/a11ign#5301"],
  noted: ["a11ign/a11ign#5300", "a11ign/a11ign#5301"],
};
const urlOf = (number: number): string => `https://github.com/${REPO}/issues/${number}`;
const silent = (): void => {};
const isItemAdd = (args: string[]): boolean => args[0] === "project" && args[1] === "item-add";
const isItemEdit = (args: string[]): boolean => args[0] === "project" && args[1] === "item-edit";
const isLabelWrite = (args: string[]): boolean => args[0] === "issue" && args[1] === "edit" && args.includes(OUT_OF_RELEASE_LABEL);

/** The issue a Project-membership read asks about (`row-file`'s `projectItems` query), or `null` for any other call. */
const membershipOf = (args: string[]): number | null => {
  if (args[0] !== "api" || args[1] !== "graphql" || !args.some((a) => a.includes("projectItems"))) return null;
  return Number(/issue\(number: (\d+)\)/.exec(args.join(" "))![1]);
};
/** The answer GitHub gives for one issue: its one Project item, with no Status, when it is on the board; no items otherwise. */
const membershipAnswer = (onBoard: boolean) => ({
  data: { repository: { issue: { projectItems: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: onBoard ? [{ project: { number: PROJECT_NUMBER, owner: { login: PROJECT_OWNER } }, fieldValueByName: null }] : [],
  } } } },
});

/** A fake `gh`. `issues` is what the by-label read answers; `onBoard` lists the issues already on Project 1; `refuse` names the calls that throw; every other call is recorded and answered empty (a create answers its URL). */
function fakeGh({ issues = [], onBoard = [], refuse = () => false }: { issues?: FakeRow[]; onBoard?: number[]; refuse?: (args: string[]) => boolean } = {}) {
  const writes: string[][] = [];
  const run: Run = (args) => {
    const read = readsRowsByLabel(args);
    if (read !== null) return connectionOf(issues.filter((row) => (row.state === "CLOSED") === (read.state === "CLOSED")));
    const membership = membershipOf(args);
    if (membership !== null) {
      if (refuse(args)) throw new Error("gh refused");
      return JSON.stringify(membershipAnswer(onBoard.includes(membership)));
    }
    writes.push(args);
    if (refuse(args)) throw new Error("gh refused");
    return args[0] === "issue" && args[1] === "create" ? `${urlOf(NEW_ROW)}\n` : "";
  };
  return { run, writes };
}

/** The `--body` the filing create sent, which is the body an open row carries. */
function createdBody(writes: string[][]): string {
  const create = writes.find((args) => args[0] === "issue" && args[1] === "create")!;
  return create[create.indexOf("--body") + 1];
}

test("a new incident is boarded when it is filed: the card, then Backlog, then the labels last", () => {
  const { run, writes } = fakeGh();
  assert.equal(recordIncident(group, { run, log: silent }), NEW_ROW, "the row is reported as filed");
  const board = writes.filter((args) => args[0] === "project" || (args[0] === "issue" && args[1] === "edit"));
  assert.deepEqual(board, [
    ["project", "item-add", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", urlOf(NEW_ROW)],
    ["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", urlOf(NEW_ROW), "--field", "Status", "--value", "Backlog"],
    ["issue", "edit", String(NEW_ROW), "--repo", REPO, "--add-label", BACKLOG_LABEL, "--add-label", OUT_OF_RELEASE_LABEL],
  ], "the three board writes, in row-file's order: the card, its Status, then the labels");
  assert.match(createdBody(writes), /SIGNAL for `orchestrator`/, "the body says it is a signal and carries no claimable work");
});

test("a refused board step is not reported as filed, and the next tick boards the row it already filed", () => {
  const first = fakeGh({ refuse: isItemAdd });
  const log: string[] = [];
  assert.equal(recordIncident(group, { run: first.run, log: (line) => log.push(line) }), null, "not reported as filed while the card is missing");
  assert.match(log.join(""), /the next tick retries/);
  const open: FakeRow = { number: NEW_ROW, body: createdBody(first.writes), labels: ["ci-shared-failure"] };
  const second = fakeGh({ issues: [open] });
  assert.equal(recordIncident(group, { run: second.run, log: silent }), NEW_ROW, "the next tick joins the open row");
  assert.ok(second.writes.some(isItemAdd), "and boards it, because it does not yet carry the release declaration");
  assert.ok(second.writes.some((args) => args[0] === "issue" && args[1] === "edit" && args.includes(OUT_OF_RELEASE_LABEL)), "its labels are set");
});

test("a refused Status write is not reported as filed, and the retry does not add the card a second time", () => {
  const first = fakeGh({ refuse: isItemEdit });
  const log: string[] = [];
  assert.equal(recordIncident(group, { run: first.run, log: (line) => log.push(line) }), null, "not reported as filed while its Status is missing");
  assert.match(log.join(""), /the next tick retries/);
  assert.ok(first.writes.some(isItemAdd), "the card was added before its Status was refused");
  assert.ok(!first.writes.some(isLabelWrite), "and no label was written after the refusal");
  const open: FakeRow = { number: NEW_ROW, body: createdBody(first.writes), labels: ["ci-shared-failure"] };
  const second = fakeGh({ issues: [open], onBoard: [NEW_ROW] });
  assert.equal(recordIncident(group, { run: second.run, log: silent }), NEW_ROW, "the next tick joins the open row");
  assert.ok(!second.writes.some(isItemAdd), "the card is already on the board, with no Status: it is not added again");
  assert.ok(second.writes.some(isItemEdit), "its Status is set");
  assert.ok(second.writes.some(isLabelWrite), "and its labels after it");
});

test("an unreadable board writes nothing to the board, and is not reported as filed", () => {
  const { run, writes } = fakeGh({ refuse: (args) => membershipOf(args) !== null });
  const log: string[] = [];
  assert.equal(recordIncident(group, { run, log: (line) => log.push(line) }), null, "not reported as filed while whether the card is on the board is unknown");
  assert.match(log.join(""), /the next tick retries/);
  assert.deepEqual(writes.filter((args) => args[0] === "project"), [], "no card is added or moved on a guess");
});

test("a joined row whose board is refused is not reported as filed", () => {
  const filed = fakeGh();
  recordIncident(group, { run: filed.run, log: silent });
  const open: FakeRow = { number: 7, body: createdBody(filed.writes), labels: ["ci-shared-failure"] };
  const { run } = fakeGh({ issues: [open], refuse: isItemAdd });
  const log: string[] = [];
  assert.equal(recordIncident(group, { run, log: (line) => log.push(line) }), null, "the row exists, but it is not boarded: not reported as filed");
  assert.match(log.join(""), /could not board #7.*the next tick retries/);
});

test("a row already boarded is joined without a second board write", () => {
  const filed = fakeGh();
  recordIncident(group, { run: filed.run, log: silent });
  const open: FakeRow = { number: 7, body: createdBody(filed.writes), labels: ["ci-shared-failure", BACKLOG_LABEL, OUT_OF_RELEASE_LABEL] };
  const { run, writes } = fakeGh({ issues: [open] });
  assert.equal(recordIncident(group, { run, log: silent }), 7, "the open row is joined");
  assert.deepEqual(writes.filter((args) => args[0] === "project" || args[0] === "issue"), [], "a row carrying out-of-release is not boarded again");
});
