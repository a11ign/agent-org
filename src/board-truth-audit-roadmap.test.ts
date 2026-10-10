// no-token: gh -- `board-truth-audit.ts` reaches `gh` only through the `run` `readBoardFacts` is given; every call this file makes is an injected fake, and the live read was run by hand and is pasted on the pull request (a11ign/agent-org#517)
// a11ign/agent-org#517: the board-truth audit flags an open row under a roadmap epic whose own `Roadmap` value is absent or another one. Fixtures only: nothing here reaches GitHub.
//
// POSITIVE CONTROL: a row with no value and a row with the wrong value are each FOUND, and a row with the right value is not, in one audit, so an empty answer is a reading and not an unwired
// question. Every `agrees` case below differs from its `disagrees` twin by ONE fact (the value, the project, the level of the epic).
import assert from "node:assert/strict";
import { test } from "node:test";
import { QUESTIONS, boardTruthAudit, boardTruthTable, readBoardFacts } from "./board-truth-audit.ts";
import type { BoardFacts, RoadmapNode, RoadmapItem } from "./board-truth-audit.ts";

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

/** a GraphQL `Issue` node as the aliased query returns it */
const issue = (number: number, repo: string, items: { project: number, value?: any }[], parent: any = null) => ({
  number, repository: { nameWithOwner: repo }, parent,
  projectItems: { totalCount: items.length, nodes: items.map(({ project, value }) => ({ project: { number: project, owner: { login: "a11ign" } }, value: value ?? null })) },
});
const answerFor = (nodes: Record<string, any>) => JSON.stringify({ data: { repository: nodes } });
/** a fake `run` that answers the rows list, the closed and merged reads empty, and the aliased query with `graphql` */
const answers = (rows: number[], graphql: (query: string) => string) => (args: string[]) => {
  if (args[0] === "api") return graphql(args.find((a) => a.startsWith("query=")) ?? "");
  if (args.includes("open")) return JSON.stringify(rows.map((number) => ({ number, title: `row ${number}`, labels: [{ name: "ready" }] })));
  return "[]";
};
const read = (run: (args: string[]) => string) => readBoardFacts("a11ign/agent-org", { run, agents: () => null, now: NOW, trackers: [] });

test("readBoardFacts: the rows' values and their parents' are read, a parent in another repository is named whole, and a text value is read", () => {
  const run = answers([1, 2, 3], () => answerFor({
    r1: issue(1, "a11ign/agent-org", [{ project: 2 }], issue(4437, "a11ign/a11ign", [{ project: 2, value: { name: SELF_HEALING } }])),
    r2: issue(2, "a11ign/agent-org", [{ project: 2, value: { name: SPEND } }], issue(4437, "a11ign/a11ign", [{ project: 2, value: { name: SELF_HEALING } }])),
    r3: issue(3, "a11ign/agent-org", [{ project: 1, value: { text: "free text" } }]),
  }));
  const read1 = read(run);
  assert.deepEqual(read1.roadmaps?.[3], { ref: "a11ign/agent-org#3", items: [{ project: P1, value: "free text" }], parent: null });
  assert.deepEqual(read1.roadmaps?.[1].parent, { ref: "a11ign/a11ign#4437", items: [{ project: P2, value: SELF_HEALING }], parent: null });
  const audit = boardTruthAudit({ ...read1, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } });
  assert.deepEqual(audit.findings.filter((f) => f.question === QUESTIONS.ROADMAP).map((f) => f.number), [1, 2], "read through the real reader, the same two rows are found");
  assert.deepEqual(audit.unread, []);
});

test("readBoardFacts: the rows are asked 50 to a request, by alias, and the request names the field", () => {
  const queries: string[] = [];
  const rows = Array.from({ length: 120 }, (_, i) => i + 1);
  const run = answers(rows, (query) => {
    queries.push(query);
    return answerFor(Object.fromEntries([...query.matchAll(/\br(\d+): issue/g)].map((m) => [`r${m[1]}`, issue(Number(m[1]), "a11ign/agent-org", [])])));
  });
  const read2 = read(run);
  assert.deepEqual(queries.map((q) => [...q.matchAll(/\br\d+: issue/g)].length), [50, 50, 20]);
  assert.match(queries[0], /fieldValueByName\(name: "Roadmap"\)/);
  assert.equal(Object.keys(read2.roadmaps ?? {}).length, 120);
  assert.equal(queries.length, 3, "no request per row");
});

test("readBoardFacts: a refused, misshapen or cut-short read is UNREAD (null), never an empty map that every row agrees with", () => {
  const refused = read(answers([1], () => { throw new Error("HTTP 502"); }));
  assert.equal(refused.roadmaps, null);
  assert.deepEqual(boardTruthAudit({ ...refused, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } }).unread, [QUESTIONS.ROADMAP]);
  assert.equal(read(answers([1], () => "[]")).roadmaps, null, "no `data.repository` in the answer");
  assert.equal(read(answers([1], () => JSON.stringify({ data: { repository: null } }))).roadmaps, null);
  const cut = issue(1, "a11ign/agent-org", [{ project: 2 }]);
  cut.projectItems.totalCount = 21;
  assert.equal(read(answers([1], () => answerFor({ r1: cut }))).roadmaps, null, "items beyond the page are not read as absent");
  const unknownRow = read(answers([1, 2], () => answerFor({ r1: issue(1, "a11ign/agent-org", []), r2: null })));
  assert.deepEqual(Object.keys(unknownRow.roadmaps ?? {}), ["1"], "a row the answer does not hold has no entry");
  assert.deepEqual(boardTruthAudit({ ...unknownRow, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } }).unread, [QUESTIONS.ROADMAP]);
});
