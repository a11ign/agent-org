// no-token: gh -- pure: `decide` and `chairmanReminderWindow` over in-memory rows and an injected clock; nothing reaches `gh`, `git` or the network
/**
 * #2989: THE CHAIRMAN-BLOCKED ORDER'S KEY ADVANCES BY THE DAY, NOT BY AN AGE `ceo`'S OWN COMMENTS RESET.
 *
 * The order keyed on `daysSince(oldest updatedAt)`. `ceo` answers it by commenting on the rows, which writes
 * `updatedAt`, so the age read 0 for ever, the key never moved, `wake` re-delivered it to `MAX_DELIVERIES` and the
 * tick then printed `STUCK ceo/chairman-blocked/0` on every run. Every clock below is injected: none of this reads
 * the wall clock, so none of it can pass or fail by the hour it runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide, chairmanReminderWindow, CHAIRMAN_REMINDER_PERIOD_MS, PROMOTION_ASK_WINDOW_MS,
} from "./work-gate.mjs";
import { JUDGMENT_TTL_MS, MAX_DELIVERIES, stuckRowOf } from "./wake.mjs";

const DAY = CHAIRMAN_REMINDER_PERIOD_MS;
const MIN = 60_000;
/** A UTC midnight, so "the window opens" is the first millisecond of the fixture and not a guess. */
const MIDNIGHT = Date.parse("2026-10-02T00:00:00Z");
const NUMBERS = [2885, 2887, 2705, 2752];

/** The four rows labelled `needs:chairman`, each last touched at `touchedAt`. */
const rows = (touchedAt: number) => NUMBERS.map((number) =>
  ({ number, title: `row ${number}`, updatedAt: new Date(touchedAt).toISOString() }));

const orderAt = (nowMs: number, chairmanBlocked: unknown[]) =>
  decide({ prs: [], readyRows: [], chairmanBlocked, nowMs })
    .filter((order: { cause: string }) => order.cause === "chairman-blocked");

test("the window is exactly the judgment TTL, so one delivery per window and no state (the coupling is the mechanism)", () => {
  assert.equal(PROMOTION_ASK_WINDOW_MS, JUDGMENT_TTL_MS,
    "`wake` dedupes a judgment cause for JUDGMENT_TTL_MS; a shorter window asks twice, a longer one is the treadmill");
});

test("(1) POSITIVE CONTROL: ceo commenting on every row does NOT move the key; a day boundary DOES", () => {
  const before = orderAt(MIDNIGHT + MIN, rows(MIDNIGHT - 3 * DAY));
  // `ceo` answers by commenting on each row, so every `updatedAt` is now: the very write that froze the old age.
  const afterAnswer = orderAt(MIDNIGHT + 30 * MIN, rows(MIDNIGHT + 20 * MIN));
  const nextDay = orderAt(MIDNIGHT + DAY + MIN, rows(MIDNIGHT + 20 * MIN));
  assert.equal(before.length, 1, "the positive control: the order IS emitted in the window, so the others mean something");
  assert.equal(afterAnswer.length, 1);
  assert.equal(nextDay.length, 1);
  assert.equal(afterAnswer[0].causeKey, before[0].causeKey,
    "same day, same question: ceo's own comment must not make a new one, or the cap is reached by diligence");
  assert.notEqual(nextDay[0].causeKey, before[0].causeKey, "a day boundary is a new question");
});

test("(2) the key advances by the day even when no row's updatedAt is older than a day", () => {
  const keys = [0, 1, 2, 3, 4, 5, 6].map((d) => orderAt(MIDNIGHT + d * DAY + MIN, rows(MIDNIGHT + d * DAY))[0].causeKey);
  assert.equal(new Set(keys).size, keys.length, "seven days, seven distinct keys, with every row touched that very day");
  for (const key of keys) assert.doesNotMatch(key, /\/0$/, "the frozen `/0` this row was filed over");
});

test("(3) an empty set still returns [] -- in the window and out of it", () => {
  assert.deepEqual(orderAt(MIDNIGHT + MIN, []), []);
  assert.deepEqual(orderAt(MIDNIGHT + 12 * 60 * MIN, []), []);
});

test("(4) the prompt no longer claims an age from updatedAt, and says it is a standing daily reminder", () => {
  const [order] = orderAt(MIDNIGHT + MIN, rows(MIDNIGHT - 9 * DAY));
  assert.doesNotMatch(order.prompt, /NO ACTIVITY OF ANY KIND/);
  assert.doesNotMatch(order.prompt, /\d+ day\(s\)/, "the 9-day-old fixture must not surface as an age");
  assert.match(order.prompt, /STANDING DAILY REMINDER for 2026-10-02 \(UTC\)/);
  assert.match(order.prompt, /4 row\(s\)/);
  for (const n of NUMBERS) assert.match(order.prompt, new RegExp(`#${n}`));
  assert.match(order.prompt, /take the label off/);
});

test("between windows the order is ABSENT, so the ledger sees the cause stop and writes its RESET", () => {
  const blocked = rows(MIDNIGHT);
  assert.equal(orderAt(MIDNIGHT, blocked).length, 1, "the window opens on the first millisecond");
  assert.equal(orderAt(MIDNIGHT + PROMOTION_ASK_WINDOW_MS - 1, blocked).length, 1, "and is open to its last");
  assert.deepEqual(orderAt(MIDNIGHT + PROMOTION_ASK_WINDOW_MS, blocked), [], "and is shut at TTL, not a tick later");
  assert.deepEqual(orderAt(MIDNIGHT + 13 * 60 * MIN, blocked), [], "and stays shut all afternoon");
  assert.deepEqual(orderAt(MIDNIGHT + DAY - 1, blocked), [], "to the end of the day");
  assert.equal(chairmanReminderWindow(MIDNIGHT)?.day, MIDNIGHT / DAY);
});

test("six consecutive days of ticks never reach MAX_DELIVERIES: one key a day, each held no longer than the TTL", () => {
  const tickEvery = 2 * MIN;
  const emissions = new Map<string, number[]>();
  for (let t = MIDNIGHT; t < MIDNIGHT + 6 * DAY; t += tickEvery) {
    // Every tick finds the rows freshly commented on: the answer's own write, which froze the old key.
    for (const order of orderAt(t, rows(t))) emissions.set(order.causeKey, [...(emissions.get(order.causeKey) ?? []), t]);
  }
  assert.equal(emissions.size, 6, "six days, six keys: the positive control that ticks DID emit, so the bounds below are not vacuous");
  for (const [key, at] of emissions) {
    const span = at[at.length - 1] - at[0];
    assert.ok(span < JUDGMENT_TTL_MS, `${key} is emitted over ${span / MIN} min, inside one TTL, so wake delivers it ONCE`);
    // A delivery at the first emission is held for the TTL, which outlasts the key's last emission.
    const deliveries = Math.floor(span / JUDGMENT_TTL_MS) + 1;
    assert.ok(deliveries < MAX_DELIVERIES, `${key}: ${deliveries} delivery(ies) against a cap of ${MAX_DELIVERIES}`);
  }
});

test("the key names no row, so the stuck escalator cannot mistake a day number for one", () => {
  const [order] = orderAt(MIDNIGHT + MIN, rows(MIDNIGHT));
  assert.equal(stuckRowOf(order.causeKey), null, "a day number read as a row would label an unrelated issue");
});
