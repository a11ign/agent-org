// no-token: gh -- the ticket port is a fake and nothing here spawns `gh`
/**
 * agent-org#490 (Phase 1 of a11ign/a11ign#4505): THE GATE BOARDS A LABELLED ROW ITSELF AND A MANAGER IS WOKEN ONLY FOR THE UNLABELLED REMAINDER.
 *
 * The row's four named cases are the four tests whose names start with their sentence. The orders are the real ones: `settleOffBoardRows` is given what
 * `readRowsOffBoard` returns and its result goes through `rowOffBoardOrders`, the entry `decide` calls, so what the order names is what the gate would send and not
 * what this file thinks it would.
 *
 * The facts' ages and the grace are written out here (`GRACE`, `OLD`), never taken from `ROW_OFF_BOARD_GRACE_MS`, for the reason the sibling
 * `work-gate-org-health-port.test.ts` writes its standing row out: a test built from the constant moves with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROW_OFF_BOARD_SWITCH_ENV, rowOffBoardOrders, settleOffBoardRows, type BoardFacts } from "./work-gate.ts";
import type { Decision, ItemRef, StateChange, TicketPort } from "./ticket-port/port.ts";

const HOME = "a11ign/a11ign";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const GRACE = 5 * 60_000;
const OLD = NOW - 60 * 60_000;

// --- the facts and the open rows ----------------------------------------------------------------------------------------------------

/** A row `readRowsOffBoard` found with no item on Project 1, old enough to be called off it. */
const offBoard = (number: number, title = `row ${number}`, createdMs = OLD): BoardFacts => ({ number, title, createdMs, onBoard: false });
/** The same row as `readOpenRows` returns it: the labels as `{ name }` and a milestone or `null`. */
const openRow = (number: number, labels: string[], milestone: string | null = "v1") =>
  ({ number, title: `row ${number}`, labels: labels.map((name) => ({ name })), milestone: milestone === null ? null : { number: 1, title: milestone } });

// --- the fake port ----------------------------------------------------------------------------------------------------------------------

function fakePort({ failChange = [], failComment = false }: { failChange?: number[]; failComment?: boolean } = {}) {
  const changes: { ref: ItemRef; change: StateChange; }[] = [];
  const comments: { ref: ItemRef; decision: Decision; }[] = [];
  const scopesAsked: string[] = [];
  const portFor = (scope: string): TicketPort => {
    scopesAsked.push(scope);
    return {
      readItem() { throw new Error("boarding a row must not read it through the port: `changeState` does that itself"); },
      postDecision(ref, decision) {
        if (failComment) throw new Error("HTTP 502: the comment could not be posted");
        comments.push({ ref, decision });
        return "1";
      },
      changeState(ref, change) {
        if (failChange.includes(ref.id)) throw new Error("HTTP 502: the board could not be written");
        changes.push({ ref, change });
        return true;
      },
      subscribe() { throw new Error("boarding a row must not subscribe"); },
    };
  };
  return { portFor, changes, comments, scopesAsked };
}

/** One tick: the facts settled through the fake port, and the orders `decide` would make from what is left. */
function tick(facts: BoardFacts[] | null, openRows: any[], { port = fakePort(), env = {}, now = NOW }: { port?: ReturnType<typeof fakePort>; env?: Record<string, string | undefined>; now?: number } = {}) {
  const said: string[] = [];
  const settled = settleOffBoardRows(facts, { openRows, portFor: port.portFor, env, log: (line) => said.push(line), now, scope: HOME });
  return { settled, orders: rowOffBoardOrders(settled, now), said, ...port };
}

// --- the row's Acceptance, one test per named case ---------------------------------------------------------------------------------------

test("a ready row off the board is boarded at Ready by the gate and produces no order", () => {
  const { orders, settled, changes, comments, said } = tick([offBoard(4001)], [openRow(4001, ["ready", "lane:any"])]);
  assert.deepEqual(orders, [], "no order");
  assert.deepEqual(settled, [], "and nothing is left of the row in the facts");
  assert.equal(changes.length, 1, "one write");
  assert.deepEqual(changes[0].ref, { tracker: "github", scope: HOME, id: 4001 });
  assert.deepEqual(changes[0].change, { state: "ready" }, "the port's own state, which its adapter writes as the label and as the Ready Status");
  // recorded on the row, by the gate, with the header the port writes (Move 0), after the write and not before it.
  assert.equal(comments.length, 1);
  assert.equal(comments[0].decision.role, "work-gate");
  assert.equal(comments[0].decision.kind, "row-off-board");
  assert.match(comments[0].decision.text, /added at \*\*Ready\*\*/);
  assert.match(said.join(""), /boarded #4001 at Ready/);
});

test("a row with no Status-naming label produces the order, naming only that row", () => {
  const facts = [offBoard(4001), offBoard(4002, "no state label"), offBoard(4003)];
  const rows = [openRow(4001, ["ready"]), openRow(4002, ["lane:any", "tooling"]), openRow(4003, ["in-progress", "session:worker-1"])];
  const { orders, changes } = tick(facts, rows);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "product-manager");
  assert.equal(orders[0].cause, "row-off-board");
  assert.match(orders[0].prompt, /^1 open row\(s\) have NO item on Project/);
  assert.match(orders[0].prompt, /#4002 no state label/);
  assert.doesNotMatch(orders[0].prompt, /#4001|#4003/, "only the row nobody could place by its label");
  assert.equal(orders[0].causeKey, "product-manager/row-off-board/4002", "the key is the set that is left, so the settled rows are not a question the manager is asked again");
  assert.deepEqual(changes.map((c) => [c.ref.id, c.change.state]), [[4001, "ready"], [4003, "in-progress"]], "and the two that name a Status were boarded at it");
});

test("the board write goes through a fake port, not a direct gh spawn", () => {
  const port = fakePort();
  const { changes, scopesAsked } = tick([offBoard(4001), offBoard(4002)], [openRow(4001, ["ready"]), openRow(4002, ["backlog"])], { port });
  assert.deepEqual(changes.map((c) => c.change.state), ["ready", "backlog"], "both writes were the fake's");
  assert.ok(scopesAsked.every((scope) => scope === HOME), "asked of the gate's own repository");
  // THE SOURCE OF THE FUNCTION, because nothing in the call can show a spawn that was not made: it names no spawn, no `gh` runner and no `item-add`.
  // (`boardingPortOf`, below it, is the adapter's `moveStatus` hook and IS where `item-add` is: the port's adapter is the one place that names the tracker's CLI.)
  const source = readFileSync(fileURLToPath(new URL("./work-gate.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export function settleOffBoardRows(");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "the function is found");
  const body = source.slice(start, end);
  for (const forbidden of [/execFileSync/, /\bspawn/, /defaultRun/, /item-add/, /item-edit/, /"gh"/]) {
    assert.doesNotMatch(body, forbidden, `settleOffBoardRows must not reach the tracker except through the port (${forbidden})`);
  }
});

test("negative control: with the switch off, the ready row produces today's order", () => {
  const facts = [offBoard(4001, "a ready row")];
  const rows = [openRow(4001, ["ready"])];
  const off = tick(facts, rows, { env: { [ROW_OFF_BOARD_SWITCH_ENV]: "off" } });
  assert.deepEqual([off.changes.length, off.comments.length, off.scopesAsked.length], [0, 0, 0], "no write and no port asked");
  assert.deepEqual(off.settled, facts, "the facts come back untouched");
  assert.equal(off.orders.length, 1);
  assert.match(off.orders[0].prompt, /#4001 a ready row/);
  assert.match(off.orders[0].prompt, /THIS ORDER DOES NOT BOARD THE ROW FOR YOU/, "today's text, which the gate stops saying only for the rows it boards");
  // the control is real: the same tick with the switch unset boards the row and sends nothing.
  const on = tick(facts, rows);
  assert.equal(on.changes.length, 1);
  assert.deepEqual(on.orders, []);
  // and "off" is the only value that turns it off: an unset or other value is the cutover.
  assert.equal(tick(facts, rows, { env: { [ROW_OFF_BOARD_SWITCH_ENV]: "on" } }).changes.length, 1);
});

// --- what is not a lookup stays an order ------------------------------------------------------------------------------------------------------

test("every doubt is a wake: a failed write, two state labels, an epic, a parked row and a row not in the open rows are left in the order", () => {
  const facts = [offBoard(4001), offBoard(4002), offBoard(4003), offBoard(4004), offBoard(4005), offBoard(4006)];
  const rows = [
    openRow(4001, ["ready"]), // the write for this one fails
    openRow(4002, ["ready", "backlog"]), // two: the port would strip one of them, which is a decision about the row
    openRow(4003, ["backlog", "epic"]), // boarded by `row-file --board`, at Backlog (#4456)
    openRow(4004, ["ready", "parked"]), // `parked` beside one: the port would remove it
    // 4005 is not among the open rows at all: its labels were not read
    openRow(4006, ["ready"]),
  ];
  const port = fakePort({ failChange: [4001] });
  const { orders, changes, said, comments } = tick(facts, rows, { port });
  assert.deepEqual(changes.map((c) => c.ref.id), [4006], "only the one that was a lookup and could be written");
  assert.deepEqual(comments.map((c) => c.ref.id), [4006], "and nothing is said on a row that was not boarded");
  assert.equal(orders.length, 1);
  for (const n of [4001, 4002, 4003, 4004, 4005]) assert.match(orders[0].prompt, new RegExp(`#${n}\\b`), `#${n} is named`);
  assert.doesNotMatch(orders[0].prompt, /#4006\b/);
  assert.match(said.join(""), /COULD NOT BOARD #4001 at Ready \(HTTP 502/);
});

test("a row younger than the grace is not boarded: row-file may still be about to add it", () => {
  const young = offBoard(4001, "young", NOW - (GRACE - 1));
  const { changes, orders, settled } = tick([young], [openRow(4001, ["ready"])]);
  assert.deepEqual([changes.length, orders.length], [0, 0]);
  assert.deepEqual(settled, [young], "left in the facts, as `rowsOffBoard` leaves it");
  assert.equal(tick([{ ...young, createdMs: NOW - GRACE }], [openRow(4001, ["ready"])]).changes.length, 1, "at the grace it is");
});

test("a row on the board, and a board that could not be read, are not touched", () => {
  const onBoard: BoardFacts = { number: 4001, title: "on", createdMs: OLD, onBoard: true };
  const unknown: BoardFacts = { number: 4002, title: "could not tell", createdMs: OLD, onBoard: null };
  const rows = [openRow(4001, ["ready"]), openRow(4002, ["ready"])];
  const { changes, orders, settled } = tick([onBoard, unknown], rows);
  assert.deepEqual([changes.length, orders.length], [0, 0]);
  assert.deepEqual(settled, [onBoard, unknown]);
  assert.equal(tick(null, rows).settled, null, "a refused read stays null: it is not a clean board and not an empty list");
});

test("a boarded row that declares no release is asked for the declaration only, and the gate declares none", () => {
  const facts = [offBoard(4001), offBoard(4002), offBoard(4003, "no label")];
  const rows = [openRow(4001, ["ready"], null), openRow(4002, ["backlog", "out-of-release"], null), openRow(4003, ["lane:any"])];
  const { orders, changes, comments } = tick(facts, rows);
  assert.deepEqual(changes.map((c) => c.ref.id), [4001, 4002], "both are boarded, the release does not hold a lookup back");
  assert.ok(changes.every((c) => c.change.addFlags === undefined && c.change.removeFlags === undefined), "and no flag, so no release label, is written: it is not a lookup");
  assert.match(comments[0].decision.text, /declares none, and `product-manager` is asked for it/);
  assert.match(comments[1].decision.text, /already declares one/, "`out-of-release` is a declaration");
  assert.equal(orders.length, 1, "one order for the two kinds of remainder");
  assert.match(orders[0].prompt, /^1 open row\(s\) have NO item on Project/);
  assert.match(orders[0].prompt, /#4003 no label/);
  assert.match(orders[0].prompt, /1 open row\(s\) were off Project \d+ and the gate BOARDED them this tick/);
  assert.match(orders[0].prompt, /#4001 row 4001 \(boarded at Ready\)/);
  assert.doesNotMatch(orders[0].prompt, /#4002/, "the one that declares a release is not named");
  // alone, the release-less boarded row is the whole order, and it does not say the row is off the board.
  const alone = tick([offBoard(4001)], [openRow(4001, ["ready"], null)]);
  assert.equal(alone.orders.length, 1);
  assert.doesNotMatch(alone.orders[0].prompt, /have NO item on Project/);
  assert.match(alone.orders[0].prompt, /THEY ARE ON THE BOARD NOW/);
});

test("with nothing off the board there is no order and no port asked", () => {
  const { orders, scopesAsked } = tick([], [openRow(4001, ["ready"])]);
  assert.deepEqual([orders, scopesAsked], [[], []]);
});

test("a comment that could not be posted does not undo the board write, and says so", () => {
  const { changes, orders, said } = tick([offBoard(4001)], [openRow(4001, ["ready"])], { port: fakePort({ failComment: true }) });
  assert.equal(changes.length, 1, "the row is boarded");
  assert.deepEqual(orders, [], "and a row that is on the board with a release is no order");
  assert.match(said.join(""), /boarded #4001 at Ready, COULD NOT RECORD IT ON THE ROW \(HTTP 502/);
});
