// no-token: gh -- drives answerOrders -> readLedger -> undelivered with the ledger as text; `gh` is never reached
/**
 * #3652: AN `answer:<session>` LABEL RE-APPLIED INSIDE THE LEDGER WINDOW MUST WAKE THE SESSION IT NAMES.
 *
 * `product-manager/answer-owed/row-3566` (2026-10-05): delivered 23:33, 01:34, 03:35, 05:35 -- two hours apart and
 * never at a label time -- while the label was removed and applied again at 01:55, 03:45 and 06:32. The key carries
 * no label time, so a re-applied label is the SAME key, and `answer-owed` was declared a judgment cause, which holds
 * a delivered key for `JUDGMENT_TTL_MS`.
 *
 * THE REPLAY USES THE REAL PIECES, NOT A COPY OF THEIR RULE: the order comes from `answerOrders`, the window from
 * `readLedger` handed `JUDGMENT_CAUSES` exactly as `wake.mjs`'s `main` hands it, and the declaration from
 * `cause-declaration.mjs`. A test that passed its own judgment set would pass whatever the declaration said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerOrders } from "../work-gate.ts";
import { JUDGMENT_CAUSES } from "../cause-declaration.ts";
import { readLedger, undelivered, ledgerLine, WAKE_TTL_MS, JUDGMENT_TTL_MS } from "../wake.ts";

const MINUTE = 60_000;
const DELIVERED = 1_000_000_000_000; // the 05:35:42 delivery of the ledger above
const row3566 = { number: 3566, state: "OPEN", labels: [{ name: "answer:product-manager" }] };

/** The orders the gate emits, as a tick reads GitHub: the label is on the row now, whenever it was applied. */
const orders = () => answerOrders([row3566]) as { session: string, cause: string, causeKey: string }[];

/** What `wake` would hand out at `now`, given the ledger text -- `main`'s own composition. */
const handedOut = (now: number, ledger: string, orderList = orders()) =>
  undelivered(orderList, readLedger("x", () => ledger, now, new Set(JUDGMENT_CAUSES))).map((o) => o.causeKey);

test("#3652: the order for a row owing an answer is the same key whenever its label was applied", () => {
  const [order] = orders();
  assert.equal(order.cause, "answer-owed");
  assert.equal(order.causeKey, "product-manager/answer-owed/row-3566");
  assert.deepEqual(orders().map((o) => o.causeKey), [order.causeKey], "built twice: nothing in the key moves");
});

test("#3652: delivered, label removed, label re-applied inside two hours: the order is delivered again", () => {
  const ledger = ledgerLine(DELIVERED, orders()[0].causeKey);
  // 06:32:28 is 56m46s after the 05:35:42 delivery: the label came off and went back on in between.
  const reapplied = DELIVERED + 56 * MINUTE + 46_000;
  assert.ok(reapplied - DELIVERED < JUDGMENT_TTL_MS, "inside the window the old classification held");
  assert.deepEqual(handedOut(reapplied, ledger), ["product-manager/answer-owed/row-3566"]);
});

test("#3652: it is still not re-handed inside the twenty-minute window, and is the moment that window passes", () => {
  const ledger = ledgerLine(DELIVERED, orders()[0].causeKey);
  assert.deepEqual(handedOut(DELIVERED + 2 * MINUTE, ledger), [], "two minutes after a delivery: the tick must not re-ask");
  assert.deepEqual(handedOut(DELIVERED + WAKE_TTL_MS - 1, ledger), [], "the last millisecond of the window");
  assert.deepEqual(handedOut(DELIVERED + WAKE_TTL_MS, ledger), ["product-manager/answer-owed/row-3566"]);
});

// POSITIVE CONTROL for the one above and for the replay: a cause that IS a judgment cause stays held for the two
// hours with the same ledger and the same set, so the replay passing is the declaration's doing and not a ledger
// that never held anything.
test("#3652 positive control: a real judgment cause delivered at the same moment is still held for two hours", () => {
  const held = { session: "product-manager", cause: "ready-queue-empty", causeKey: "product-manager/ready-queue-empty/1" };
  const ledger = ledgerLine(DELIVERED, held.causeKey);
  assert.ok(JUDGMENT_CAUSES.includes("ready-queue-empty"));
  assert.deepEqual(handedOut(DELIVERED + 56 * MINUTE, ledger, [held] as never), []);
  assert.deepEqual(handedOut(DELIVERED + JUDGMENT_TTL_MS, ledger, [held] as never), [held.causeKey]);
});

test("#3652: answer-owed is no longer declared a judgment cause", () => {
  assert.equal(JUDGMENT_CAUSES.includes("answer-owed"), false);
});
