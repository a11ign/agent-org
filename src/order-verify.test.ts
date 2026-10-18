// no-token: gh -- every case is a string in and a verdict out; `wake.ts` is imported only for `ledgerLine` and `wakeIdOf`, which build text, so nothing reaches `gh`, herdr or the ledger on disk
/**
 * #5147: AN ORDER THE GATE ISSUED VERIFIES, A MADE-UP ONE DOES NOT, and two deliveries of one order to a holder that did not move its head
 * file one repeat.
 *
 * The ledger lines are written by the REAL `ledgerLine` in `wake.ts`, so a change to the format breaks these tests. Each claim has its
 * negative control beside it: a verifier that accepted any id would pass the first claim, and a detector that counted every delivery
 * would pass the third only by also filing the head that moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerLine, wakeIdOf } from "./wake.ts";
import type { recordFailures } from "./failure-ledger.ts";
import { deliveriesIn, ORDERS_VERIFIABLE_USE, repeatedOrdersIn, repeatedOrdersNow, verifyOrder } from "./order-verify.ts";

const AT = 1_791_000_000_000;
const LATER = AT + 60_000;
const SESSION = "worker-5147";
const KEY = `${SESSION}/pr-merge-conflict/pr-1/abcd1234`;
const MOVED_KEY = `${SESSION}/pr-merge-conflict/pr-1/ef567890`;
const voidedLine = (at: number, key: string, deliveredAt: number) => `${at}\tVOIDED\t${key}\t${deliveredAt}\n`;

test("an id the gate issued verifies, and names the session and the causeKey it was delivered under", () => {
  const raw = ledgerLine(AT, KEY, SESSION);
  const verdict = verifyOrder(raw, wakeIdOf(SESSION, AT));
  assert.deepEqual(verdict, { verified: true, session: SESSION, at: AT, causeKey: KEY });
});

test("an order delivered with no-clear still verifies, because the recipient rides before the flag", () => {
  const raw = ledgerLine(AT, KEY, SESSION, { noClear: true });
  assert.equal(verifyOrder(raw, wakeIdOf(SESSION, AT)).verified, true);
});

test("a made-up id does not verify: wrong time, wrong session, or not an order id at all", () => {
  const raw = ledgerLine(AT, KEY, SESSION);
  assert.equal(verifyOrder(raw, wakeIdOf(SESSION, LATER)).verified, false, "a time the gate never wrote");
  assert.equal(verifyOrder(raw, wakeIdOf("worker-9999", AT)).verified, false, "a session the gate never wrote it for");
  assert.equal(verifyOrder(raw, "made-up-id").verified, false, "not the wake id shape");
});

test("a delivery that a restart VOIDED does not verify, and a marker line is never a delivery", () => {
  const raw = ledgerLine(AT, KEY, SESSION) + voidedLine(LATER, KEY, AT);
  assert.equal(verifyOrder(raw, wakeIdOf(SESSION, AT)).verified, false);
  assert.deepEqual(deliveriesIn(raw), []);
  assert.equal(deliveriesIn(ledgerLine(AT, KEY, SESSION)).length, 1, "the control: the same line without the VOIDED one counts");
});

test("two deliveries of one order to a holder whose head did not move file ONE repeat, and a third adds none", () => {
  const twice = ledgerLine(AT, KEY, SESSION) + ledgerLine(LATER, KEY, SESSION);
  assert.deepEqual(repeatedOrdersIn(twice), [{ session: SESSION, causeKey: KEY, deliveredAt: [AT, LATER] }]);
  const thrice = twice + ledgerLine(LATER + 60_000, KEY, SESSION);
  assert.equal(repeatedOrdersIn(thrice).length, 1, "one record per (session, causeKey), however many times it repeats");
});

test("the control: a head that moved between deliveries takes a new key and files nothing", () => {
  const moved = ledgerLine(AT, KEY, SESSION) + ledgerLine(LATER, MOVED_KEY, SESSION);
  assert.deepEqual(repeatedOrdersIn(moved), []);
});

test("the control: one order to two different holders is two deliveries, not a repeat by one holder", () => {
  const twoHolders = ledgerLine(AT, KEY, SESSION) + ledgerLine(LATER, KEY, "worker-tooling");
  assert.deepEqual(repeatedOrdersIn(twoHolders), []);
});

test("a delivery voided by a restart does not count toward a repeat", () => {
  const raw = ledgerLine(AT, KEY, SESSION) + voidedLine(LATER, KEY, AT) + ledgerLine(LATER + 60_000, KEY, SESSION);
  assert.deepEqual(repeatedOrdersIn(raw), []);
});

/** A failure ledger in memory: a pair already filed is skipped, as `recordFailures` skips it on disk. */
function memoryRecord(filed: string[]): typeof recordFailures {
  return ({ events }) => {
    let appended = 0;
    let skipped = 0;
    for (const { ref } of events) {
      if (filed.includes(ref)) skipped += 1;
      else { filed.push(ref); appended += 1; }
    }
    return { appended, skipped, refused: null };
  };
}

/** A failure ledger that cannot be written: nothing is filed, and `recordFailures` reports the refusal instead of throwing. */
const refusingRecord: typeof recordFailures = () => ({ appended: 0, skipped: 0, refused: "EACCES: permission denied" });

test("the detector is off unless its switch is on: a repeat files nothing and wakes nobody", () => {
  const raw = ledgerLine(AT, KEY, SESSION) + ledgerLine(LATER, KEY, SESSION);
  const filed: string[] = [];
  const off = repeatedOrdersNow({ ledgerPath: "/state/wake-ledger", switches: {}, now: LATER, read: () => raw, record: memoryRecord(filed) });
  assert.deepEqual(off, []);
  assert.deepEqual(filed, []);
  const on = repeatedOrdersNow({ ledgerPath: "/state/wake-ledger", switches: { [ORDERS_VERIFIABLE_USE]: true }, now: LATER, read: () => raw, record: memoryRecord(filed) });
  assert.equal(on.length, 1, "the control: the same ledger with the switch on wakes one holder");
});

test("switch on: a repeat files ONE failure entry and wakes orchestrator once, however many ticks find it", () => {
  const raw = ledgerLine(AT, KEY, SESSION) + ledgerLine(LATER, KEY, SESSION);
  const filed: string[] = [];
  const tick = () => repeatedOrdersNow({ ledgerPath: "/state/wake-ledger", switches: { [ORDERS_VERIFIABLE_USE]: true }, now: LATER, read: () => raw, record: memoryRecord(filed) });
  const first = tick();
  assert.equal(first.length, 1);
  assert.equal(first[0].session, "orchestrator");
  assert.equal(first[0].subject, SESSION, "the prompt names the holder that ignored the order");
  assert.equal(first[0].causeKey, `orchestrator/order-repeated/${SESSION}/${KEY}`);
  assert.deepEqual(filed, [`${SESSION}/${KEY}`]);
  assert.deepEqual(tick(), [], "the next tick finds the pair already filed, so orchestrator is not woken again");
  assert.deepEqual(filed, [`${SESSION}/${KEY}`], "still one failure entry");
});

test("a repeat whose failure entry was REFUSED wakes nobody, so the order is not sent for a filing that never happened", () => {
  const raw = ledgerLine(AT, KEY, SESSION) + ledgerLine(LATER, KEY, SESSION);
  const switches = { [ORDERS_VERIFIABLE_USE]: true };
  const refused = repeatedOrdersNow({ ledgerPath: "/state/wake-ledger", switches, now: LATER, read: () => raw, record: refusingRecord });
  assert.deepEqual(refused, [], "a refused write files nothing, so orchestrator is not woken");
  const filed: string[] = [];
  const retried = repeatedOrdersNow({ ledgerPath: "/state/wake-ledger", switches, now: LATER, read: () => raw, record: memoryRecord(filed) });
  assert.equal(retried.length, 1, "the control: the next tick, with a writable ledger, files it and wakes orchestrator once");
});
