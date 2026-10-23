// no-token: gh -- `board-truth-audit.ts` reaches `gh` only through the code host's rows; every call this file makes is the fake code host, and the live read was run by hand and is pasted on the pull request (a11ign/agent-org#517)
// a11ign/agent-org#517: the board-truth audit flags an open row under a roadmap epic whose own `Roadmap` value is absent or another one. Fixtures only: nothing here reaches GitHub.
//
// A11-160, STEP 8: THE READER'S CASES RUN ON THE FAKE CODE HOST (`roadmapFactsOf`): the world holds each row's project items and its parent as the facts they are (`world.reports.board.roadmaps`), and `readBoardFacts` is asked what
// it makes of them. The aliased GraphQL document, the owner and name variables and the refusal of an answer with no repository are the plugin's, held in `plugins/github/rows/board-rows.test.ts`.
//
// POSITIVE CONTROL: a row with no value and a row with the wrong value are each FOUND, and a row with the right value is not, in one audit, so an empty answer is a reading and not an unwired
// question. Every `agrees` case below differs from its `disagrees` twin by ONE fact (the value, the project, the level of the epic).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QUESTIONS, boardTruthAudit, boardTruthTable, readBoardFacts } from "./board-truth-audit.ts";
import type { BoardFacts, RoadmapNode, RoadmapItem } from "./board-truth-audit.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { watchedRows } from "./plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = "2026-10-10";
const P1 = "a11ign/1";
const P2 = "a11ign/2";
const SELF_HEALING = "Self-healing org";
const SPEND = "Agent spend (Haiku/Jev)";

const row = (number: number, labels: string[] = ["ready"]) => ({ number, title: `row ${number}`, body: "", state: "OPEN", labels });
const item = (project: string, value: string | null): RoadmapItem => ({ project, value });
/** an epic (or a row): its items, and the node above it */
const node = (ref: string, items: RoadmapItem[], parent: RoadmapNode | null = null): RoadmapNode => ({ ref, items, parent });
const EPIC = node("a11ign/a11ign#4437", [item(P1, null), item(P2, SELF_HEALING)]);

const facts = (over: Partial<BoardFacts>): BoardFacts => ({ now: NOW, openRows: [], closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} }, ...over });
const found = (over: Partial<BoardFacts>) => boardTruthAudit(facts(over)).findings.filter((f) => f.question === QUESTIONS.ROADMAP);
const numbers = (over: Partial<BoardFacts>) => found(over).map((f) => f.number);

test("positive control: a row with no value and a row with the wrong value are found, and a row with the right value is not", () => {
  const roadmaps = {
    1: node("a11ign/agent-org#1", [item(P2, null)], EPIC),
    2: node("a11ign/agent-org#2", [item(P2, SPEND)], EPIC),
    3: node("a11ign/agent-org#3", [item(P2, SELF_HEALING)], EPIC),
  };
  assert.deepEqual(numbers({ openRows: [row(1), row(2), row(3)], roadmaps }), [1, 2]);
});

test("the finding names the row, the epic and both values, so the fix is one `gh project item-edit`", () => {
  const roadmaps = { 1: node("a11ign/agent-org#1", [item(P2, null)], EPIC), 2: node("a11ign/agent-org#2", [item(P2, SPEND)], EPIC) };
  const [none, wrong] = found({ openRows: [row(1), row(2)], roadmaps });
  assert.equal(none.field, "`Roadmap` on project a11ign/2");
  assert.match(none.detail, /no `Roadmap` value, and its epic a11ign\/a11ign#4437 has `Self-healing org`/);
  assert.match(none.detail, /`gh project item-edit` it to `Self-healing org`/);
  assert.match(wrong.detail, /`Roadmap` `Agent spend \(Haiku\/Jev\)`, and its epic a11ign\/a11ign#4437 has `Self-healing org`/);
  assert.equal(none.route, "product-manager");
  const table = boardTruthTable(boardTruthAudit(facts({ openRows: [row(1), row(2)], roadmaps })), DAY);
  assert.match(table, /\*\*2 disagree\*\*/);
  assert.match(table, /\| #1 \| roadmap-value \| `Roadmap` on project a11ign\/2 \| no `Roadmap` value, and its epic a11ign\/a11ign#4437 has `Self-healing org`.* \| product-manager \|/);
});

test("the comparison is per project: an epic with a value on one project asks nothing of a row boarded only to another", () => {
  // #517's own shape: its epic is `Self-healing org` on project 2 and unset on 1
  const only1 = { 1: node("a11ign/agent-org#1", [item(P1, null)], EPIC) };
  assert.deepEqual(numbers({ openRows: [row(1)], roadmaps: only1 }), [], "the epic has no value on project 1");
  const both = { 1: node("a11ign/agent-org#1", [item(P1, null), item(P2, SELF_HEALING)], EPIC) };
  assert.deepEqual(numbers({ openRows: [row(1)], roadmaps: both }), [], "right on project 2, nothing to compare on 1");
  const wrongOn2 = { 1: node("a11ign/agent-org#1", [item(P1, SPEND), item(P2, null)], EPIC) };
  assert.deepEqual(found({ openRows: [row(1)], roadmaps: wrongOn2 }).map((f) => f.field), ["`Roadmap` on project a11ign/2"], "one finding, for the project the epic has a value on");
  const offBoard = { 1: node("a11ign/agent-org#1", [], EPIC) };
  assert.deepEqual(numbers({ openRows: [row(1)], roadmaps: offBoard }), [], "a row boarded to no project has no item to read; that is another disagreement");
});

test("a row under no epic, or under an epic with no value, is not asked", () => {
  const roadmaps = {
    1: node("a11ign/agent-org#1", [item(P2, null)]),
    2: node("a11ign/agent-org#2", [item(P2, SPEND)], node("a11ign/a11ign#9", [item(P2, null)])),
    3: node("a11ign/agent-org#3", [item(P2, null)], node("a11ign/a11ign#9", [item(P2, "")])),
  };
  assert.deepEqual(numbers({ openRows: [row(1), row(2), row(3)], roadmaps }), []);
});

test("two levels, as the backfill was: a row whose parent has no value is held to its grandparent's, and no further", () => {
  const sub = node("a11ign/a11ign#10", [item(P2, null)], EPIC);
  const roadmaps = {
    1: node("a11ign/agent-org#1", [item(P2, null)], sub),
    2: node("a11ign/agent-org#2", [item(P2, SELF_HEALING)], sub),
    // the nearest epic with a value wins: the sub-epic's own value is the one its child is held to
    3: node("a11ign/agent-org#3", [item(P2, SELF_HEALING)], node("a11ign/a11ign#11", [item(P2, SPEND)], EPIC)),
    // a value three levels up is not an epic of this row
    4: node("a11ign/agent-org#4", [item(P2, null)], node("a11ign/a11ign#12", [item(P2, null)], node("a11ign/a11ign#13", [item(P2, null)], EPIC))),
  };
  assert.deepEqual(numbers({ openRows: [row(1), row(2), row(3), row(4)], roadmaps }), [1, 3]);
  const [through] = found({ openRows: [row(1)], roadmaps });
  assert.match(through.detail, /its epic a11ign\/a11ign#4437 \(through a11ign\/a11ign#10\) has `Self-healing org`/);
});

test("a fact that could not be read is UNREAD and never counted as agreeing; a caller that does not ask is not asked", () => {
  const rows = [row(1)];
  assert.deepEqual(boardTruthAudit(facts({ openRows: rows, roadmaps: null })).unread, [QUESTIONS.ROADMAP]);
  assert.deepEqual(boardTruthAudit(facts({ openRows: rows, roadmaps: {} })).unread, [QUESTIONS.ROADMAP], "an empty map holds no entry for the row, which is not an agreement");
  assert.deepEqual(boardTruthAudit(facts({ openRows: rows })).unread, [], "undefined is a caller that does not ask");
  assert.deepEqual(boardTruthAudit(facts({ openRows: rows, roadmaps: { 1: node("a11ign/agent-org#1", [item(P2, SELF_HEALING)], EPIC) } })).unread, []);
  assert.match(boardTruthTable(boardTruthAudit(facts({ openRows: rows, roadmaps: null })), DAY), /NOT READ, so not counted as agreeing: roadmap-value/);
});

test("a keyed tracker is asked too, and its finding carries its key", () => {
  const other = facts({ openRows: [row(7)], roadmaps: { 7: node("a11ign/lab#7", [item(P2, SPEND)], EPIC) } });
  const audit = boardTruthAudit(facts({ others: [{ key: "lab", repo: "a11ign/lab", facts: other }] }));
  assert.deepEqual(audit.findings.filter((f) => f.question === QUESTIONS.ROADMAP).map((f) => [f.key, f.number]), [["lab", 7]]);
  assert.match(boardTruthTable(audit, DAY), /\| lab#7 \| roadmap-value \|/);
});

// ----- the reader: `readBoardFacts` asks once per 50 rows and reads the answer into the nodes above

/** The fake code host serving `a11ign/agent-org`, holding the open rows `numbers` (each is `ready`). `calls` is every operation of its rows that was called, with the request. */
function tracker(numbers: number[]) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "a11ign/agent-org";
  for (const number of numbers) host.rowsWorld.rows.set(number, fakeRow(host.rowsWorld, number, { title: `row ${number}`, labels: ["ready"] }));
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return { world: host.rowsWorld, roadmaps: host.rowsWorld.reports.board.roadmaps, calls: watched.calls };
}
const read = () => readBoardFacts("a11ign/agent-org", { agents: () => null, now: NOW, trackers: [] });
/** a project item of a row on project `project` of a11ign, with the `Roadmap` value it carries */
const onProject = (project: number, value: string | null = null) => ({ owner: "a11ign", project, value });

test("readBoardFacts: the rows' values and their parents' are read, a parent in another repository is named whole, and a text value is read", () => {
  const t = tracker([1, 2, 3]);
  t.roadmaps.set(4437, { items: [onProject(2, SELF_HEALING)], parent: null, repo: "a11ign/a11ign" });
  t.roadmaps.set(1, { items: [onProject(2)], parent: 4437 });
  t.roadmaps.set(2, { items: [onProject(2, SPEND)], parent: 4437 });
  t.roadmaps.set(3, { items: [onProject(1, "free text")], parent: null });
  const read1 = read();
  assert.deepEqual(read1.roadmaps?.[1].parent, { ref: "a11ign/a11ign#4437", items: [{ project: P2, value: SELF_HEALING }], parent: null });
  assert.deepEqual(read1.roadmaps?.[1].items, [{ project: P2, value: null }]);
  assert.deepEqual(read1.roadmaps?.[3], { ref: "a11ign/agent-org#3", items: [{ project: P1, value: "free text" }], parent: null }, "a value that is text is read as the text");
  const audit = boardTruthAudit({ ...read1, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } });
  assert.deepEqual(audit.findings.filter((f) => f.question === QUESTIONS.ROADMAP).map((f) => f.number), [1, 2], "read through the real reader, the same two rows are found");
  assert.deepEqual(audit.unread, []);
});

test("readBoardFacts: the rows are asked 50 to a request, and every row's answer is read", () => {
  const rows = Array.from({ length: 120 }, (_, i) => i + 1);
  const t = tracker(rows);
  const read2 = read();
  assert.deepEqual(t.calls.filter((c) => c.op === "roadmapFactsOf").map((c) => c.request.numbers.length), [50, 50, 20]);
  assert.deepEqual(t.calls.filter((c) => c.op === "roadmapFactsOf").flatMap((c) => c.request.numbers).sort((a: number, b: number) => a - b), rows, "each row once");
  assert.equal(Object.keys(read2.roadmaps ?? {}).length, 120);
});

test("readBoardFacts: a refused or cut-short read is UNREAD (null), never an empty map that every row agrees with", () => {
  const refusing = tracker([1]);
  refusing.world.failures.set("roadmapFactsOf", new Error("HTTP 502"));
  const refused = read();
  assert.equal(refused.roadmaps, null);
  assert.deepEqual(boardTruthAudit({ ...refused, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } }).unread, [QUESTIONS.ROADMAP]);
  const cutShort = tracker([1]);
  cutShort.roadmaps.set(1, { items: Array.from({ length: 21 }, (_, i) => onProject(i + 1)), parent: null });
  assert.equal(read().roadmaps, null, "items beyond the page are not read as absent: 21 items, 20 asked");
  const whole = tracker([1]);
  whole.roadmaps.set(1, { items: Array.from({ length: 20 }, (_, i) => onProject(i + 1)), parent: null });
  assert.notEqual(read().roadmaps, null, "CONTROL: twenty items are the whole of the row");
  tracker([1]);
  const unknownRow = readBoardFacts("a11ign/agent-org", { agents: () => null, now: NOW, trackers: [], openRows: [row(1), row(2)] });
  assert.deepEqual(Object.keys(unknownRow.roadmaps ?? {}), ["1"], "a row the answer does not hold (#2) has no entry");
  assert.deepEqual(boardTruthAudit({ ...unknownRow, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } }).unread, [QUESTIONS.ROADMAP]);
});
