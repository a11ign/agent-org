// no-token: gh -- no `gh` call is made here; the tail is handed a record and a clock, and the one file read goes through a seam (a11ign/a11ign#4605)
// #4605 (fix 4 of 4 for the lock-gridlock class, epic #4437): a holder's order and wakes say `your claim blocks N rows (#a, #b, ...)`.
//
// POSITIVE CONTROLS: the three-row fixture is the control for the empty ones (a tail that never prints fails it; one that always prints fails the empty, stale and unrelated-row tests), and the
// list is built from `holdingsOf`/`advance` themselves, so a tail that recounted differently from the gate would disagree with the record it is handed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, holdingsOf, MAX_TICK_GAP_MS, type Held, type Ref, type Shelved } from "./blocking-impact.ts";
import { blastTail, readBlockingRecord, shelvedBehind } from "./blast-tail.ts";
import { addressed } from "./wake.ts";

const NOW = Date.parse("2026-10-09T10:00:00Z");
const ROW = 4605;
const B4_ROW = (held: number) => `overlaps the Region of #${held}, a row already claimed (\`in-progress\`) that has no open pull request declaring \`Closes #${held}\` yet, and which declares: src/wake.ts. B4: no two rows are worked on the same file at once`;
const HOLDERS: Record<number, Held> = { [ROW]: { holder: "worker-4605", row: ROW }, 200: { holder: "worker-b", row: 200 } };
const resolve = (ref: Ref): Held | null => HOLDERS[ref.number] ?? null;
const shelved = (held: number, numbers: number[]): Shelved[] => numbers.map((number) => ({ number, reason: B4_ROW(held) }));

/** The record the gate's own `advance` writes for one tick over `blocked`: the tail reads what the count wrote, not a hand-built shape. */
const recordOf = (blocked: Shelved[], at = NOW) => advance(null, { now: at, holdings: holdingsOf(blocked, resolve).holdings }).record;
const spawned = { row: ROW, branch: "agent/x-4605", worktree: "../wt-4605", launchDir: "/tmp/wt-4605" };
const order = { session: "worker-4605", prompt: "Build the row." };

test("a holder blocking three rows is told so, with the rows", () => {
  const record = recordOf(shelved(ROW, [4701, 4702, 4703]));
  assert.match(blastTail(ROW, record, NOW), /your claim blocks 3 rows \(#4701, #4702, #4703\)/);
});

test("a holder blocking one row is told too: the 5-row threshold is for the incident, not for the information", () => {
  assert.match(blastTail(ROW, recordOf(shelved(ROW, [4701])), NOW), /your claim blocks 1 row \(#4701\)/);
});

test("nothing shelved prints nothing: no line, no blank line", () => {
  assert.equal(blastTail(ROW, recordOf([]), NOW), "");
  assert.equal(blastTail(ROW, null, NOW), "");
});

test("rows shelved behind ANOTHER holder are not this holder's", () => {
  const record = recordOf([...shelved(200, [4801, 4802]), ...shelved(ROW, [4701])]);
  assert.deepEqual(shelvedBehind(ROW, record, NOW), [4701]);
  assert.deepEqual(shelvedBehind(200, record, NOW), [4801, 4802]);
  assert.deepEqual(shelvedBehind(999, record, NOW), []);
});

test("the list is the count's list: every row the gate shelved behind the holder, none cut", () => {
  const numbers = Array.from({ length: 28 }, (_, i) => 5000 + i);
  const { holdings } = holdingsOf(shelved(ROW, numbers), resolve);
  assert.deepEqual(shelvedBehind(ROW, recordOf(shelved(ROW, numbers)), NOW), holdings.get("worker-4605")?.rows);
  assert.match(blastTail(ROW, recordOf(shelved(ROW, numbers)), NOW), /blocks 28 rows \(#5000, #5001,.*#5027\)/);
});

test("a record older than one missed tick is not a reading of now, and one from before holdings were kept says nothing", () => {
  const record = recordOf(shelved(ROW, [4701]));
  assert.equal(blastTail(ROW, record, NOW + MAX_TICK_GAP_MS), blastTail(ROW, record, NOW), "exactly the gap is still a reading");
  assert.equal(blastTail(ROW, record, NOW + MAX_TICK_GAP_MS + 1), "");
  const { holdings: _kept, ...beforeHoldings } = record;
  assert.equal(blastTail(ROW, beforeHoldings, NOW), "");
});

test("the spawned order and a later wake both carry the line, and an order with nothing shelved is byte-identical to one that was never given a reading", () => {
  const record = recordOf(shelved(ROW, [4701, 4702, 4703]));
  const first = addressed(order, "worker-4605", { spawned, blocking: record, now: NOW });
  const later = addressed(order, "worker-4605", { spawned, followUp: true, blocking: record, now: NOW });
  for (const text of [first, later]) assert.match(text, /your claim blocks 3 rows \(#4701, #4702, #4703\)/);
  const bare = addressed(order, "worker-4605", { spawned });
  assert.equal(addressed(order, "worker-4605", { spawned, blocking: recordOf([]), now: NOW }), bare);
  assert.equal(first.slice(0, bare.length), bare, "the line is a tail: everything before it is the order as it was");
});

test("a standing seat's order does not carry it", () => {
  assert.doesNotMatch(addressed(order, "product-manager", { blocking: recordOf(shelved(ROW, [4701])), now: NOW }), /your claim blocks/);
});

test("the reader returns the record, null for an absent file quietly, and null for a corrupt one with a diagnostic", () => {
  const logged: string[] = [];
  const record = recordOf(shelved(ROW, [4701]));
  assert.deepEqual(readBlockingRecord("/state", { read: () => JSON.stringify(record), log: (line) => logged.push(line) }), record);
  const absent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  assert.equal(readBlockingRecord("/state", { read: absent, log: (line) => logged.push(line) }), null);
  assert.equal(logged.length, 0);
  assert.equal(readBlockingRecord("/state", { read: () => "{not json", log: (line) => logged.push(line) }), null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /blocking-impact\.json could not be read/);
});
