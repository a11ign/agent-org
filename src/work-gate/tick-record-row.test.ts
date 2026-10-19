// no-token: gh -- the ticket port and the create's runner are fakes and nothing here spawns `gh`
/**
 * agent-org#1229 (a11ign#5275): THE TICK'S STANDING RECORD ROW REACHES PROJECT 1. The row is created through the tick's own `createTickRecordRow` against a fake runner, the
 * labels it was created with are handed to `settleOffBoardRows` as the open row's labels, and the gate's real orders are asked for. The positive control is a row bare-created
 * the way the tick used to (`lane:ceo` alone), which must still be flagged: a check that exempted everything would pass the first test too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowOffBoardOrders, type BoardFacts } from "./causes/rows-off-board.ts";
import { settleOffBoardRows } from "./tick.ts";
import type { ItemRef, StateChange, TicketPort } from "../ticket-port/port.ts";
import { TICK_RECORD_ROW_LABELS, createTickRecordRow } from "../work-tick.ts";

const HOME = "a11ign/a11ign";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const OLD = NOW - 60 * 60_000;

function settle(number: number, labels: string[]) {
  const changes: { ref: ItemRef; change: StateChange }[] = [];
  const portFor = (): TicketPort => ({
    readItem() { throw new Error("not read"); },
    postDecision() { return "1"; },
    changeState(ref, change) { changes.push({ ref, change }); return true; },
    subscribe() { throw new Error("not subscribed"); },
  });
  const facts: BoardFacts[] = [{ number, title: "Tick record: slow ticks", createdMs: OLD, onBoard: false }];
  const openRows = [{ number, title: facts[0].title, labels: labels.map((name) => ({ name })), milestone: null }];
  const settled = settleOffBoardRows(facts, { openRows, portFor, env: {}, log: () => {}, now: NOW, scope: HOME });
  return { changes, orders: rowOffBoardOrders(settled, NOW) };
}

test("the tick creates its record row at Backlog, out of release, lane ceo, and the gate boards it with no order", () => {
  let argv: string[] = [];
  const number = createTickRecordRow(HOME, (args) => { argv = args; return `https://github.com/${HOME}/issues/5275\n`; });
  assert.equal(number, 5275);
  const labels = argv.flatMap((arg, i) => (argv[i - 1] === "--label" ? [arg] : []));
  assert.deepEqual(labels, [...TICK_RECORD_ROW_LABELS]);
  assert.deepEqual(labels, ["lane:ceo", "backlog", "out-of-release"], "written out, not taken from the constants");
  const { changes, orders } = settle(5275, labels);
  assert.deepEqual(changes.map((c) => [c.ref.id, c.change.state]), [[5275, "backlog"]], "boarded at Backlog by the gate");
  assert.deepEqual(orders, [], "and no row-off-board order is sent for it");
});

test("positive control: an ordinary row created bare is still flagged, and the tick's old labels would have been", () => {
  for (const labels of [["lane:any"], ["lane:ceo"]]) {
    const { changes, orders } = settle(4242, labels);
    assert.deepEqual(changes, [], `${labels} names no Status, so the gate boards nothing`);
    assert.equal(orders.length, 1);
    assert.match(orders[0].prompt, /#4242\b/);
  }
});
