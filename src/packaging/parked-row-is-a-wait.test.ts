// no-token: gh -- every reader here is pure; the facts are written out and no call is made.
/**
 * `src/wait-condition.mjs`, `src/unpark-satisfied.mjs` and signal 9 of `src/org-health.mjs`, #4230: A PARKED ROW IS A WAIT THE STALL SIGNALS READ.
 *
 * THE INCIDENT, REPLAYED (the chairman's root cause 3, 2026-10-08): #4090 was `parked` on a free-text wait. `waitFieldsOf` did not list `parked`, so the stale-wait signal
 * (8) and the wait-without-reason signal (9) never looked at it, `unpark-satisfied` left it "untouched, a different defect", and `org-health` repaired its LABELS (`backlog`
 * plus `parked`) without asking whether the wait was real. It then sat ten hours on a met wait. The positive control is that row's body at 09:37Z and again at 10:22Z.
 *
 * EVERY "is quiet" BELOW IS ONLY WORTH ANYTHING BECAUSE THE FIRST TEST IS NOT: a correct park (an open condition, a future date, an open edge, the chairman's brief) is
 * asserted quiet against the same reading that names the free-text one.
 *
 * MUTATION, run by hand 2026-10-08 and recorded on the row, each restored byte-identical (`diff` of a copy): `waitFieldsOf` never reporting `parked` turns the naming tests
 * red and leaves the quiet ones green; `fieldsNeedingAReason` never excusing a park turns every "correct park is quiet" test red and leaves the naming ones green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PARKED_LABEL, WAIT_FIELDS, bareWaits, staleWaits, waitFieldsOf, waitItemOf } from "../wait-condition.mjs";
import { readSatisfaction } from "../unpark-satisfied.mjs";
import { SIGNALS, orgHealthOrders, waitWithoutReasonReading } from "../org-health.mjs";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const AT_0937 = Date.parse("2026-10-08T09:37:00Z");
const AT_1022 = Date.parse("2026-10-08T10:22:00Z");

/** #4090's body at 09:37Z: a wait in free text, which no line of the grammar can read. */
const FREE_TEXT_BODY = "## What it is\n\nWaiting-for: the corpus capture to finish, then somebody to look\n";

const row = (extra: Record<string, unknown> = {}) => ({
  number: 4090, labels: [{ name: "backlog" }, { name: "parked" }], body: FREE_TEXT_BODY, updatedAt: new Date(AT_0937).toISOString(), ...extra,
});
const waits = (raw: Record<string, unknown>, now: number) => bareWaits({ items: [waitItemOf(raw, "row")], now });

const openRef = { items: { "#4000": { state: "open" as const, labels: [], resolvedAt: null, changedAt: AT_0937 } } };
const closedRef = { items: { "#4000": { state: "closed" as const, labels: [], resolvedAt: AT_0937 - HOUR_MS, changedAt: AT_0937 - HOUR_MS } } };

// --- the failing case, written first ------------------------------------------------------------------------------------------

test("`parked` is a wait field that does not clear itself", () => {
  assert.deepEqual(WAIT_FIELDS.find((f) => f.kind === PARKED_LABEL), { kind: "parked", selfClears: false });
  assert.deepEqual(waitFieldsOf(waitItemOf(row(), "row"), AT_0937), [{ kind: "parked", label: "parked" }]);
});

test("POSITIVE CONTROL, THE INCIDENT: #4090's free-text wait is named by signal 9 at 09:37Z and again at 10:22Z, never left alone and never excused as untouched", () => {
  for (const now of [AT_0937, AT_1022]) {
    const bare = waits(row(), now);
    assert.equal(bare.length, 1, `named at ${new Date(now).toISOString()}`);
    assert.deepEqual(bare[0].fields, ["parked"]);
    assert.equal(bare[0].atOnce, true);
    const reading = waitWithoutReasonReading({ now, bare });
    assert.equal(reading.status, "tripped", "AT ONCE: the row was touched minutes ago, far inside the 4 quiet hours a `hold:*` earns");
    assert.match(reading.detail, /#4090 \(parked, no reason given\)/);
  }
});

test("a parked row with NO `Waiting-for:` at all is named at once too, the case the signal's remedy tells the setter to fix", () => {
  const bare = waits(row({ body: "## What it is\n\nNothing about a wait.\n" }), AT_1022);
  assert.equal(bare.length, 1);
  assert.equal(waitWithoutReasonReading({ now: AT_1022, bare }).status, "tripped");
});

test("the order to `product-manager` names the row and the one line to add", () => {
  const bare = waits(row(), AT_1022);
  const [order] = orgHealthOrders([waitWithoutReasonReading({ now: AT_1022, bare })]);
  assert.match(order.prompt, /#4090 \(parked/);
  assert.match(order.prompt, /Waiting-for: <closed\|merged\|labelled <label>\|unlabelled <label>> <#n>/);
  assert.match(order.prompt, /`parked`/);
});

// --- the negative controls: a correct park is quiet ---------------------------------------------------------------------------

test("NEGATIVE CONTROL: a park whose readable condition is UNMET and open is not named, by signal 9 or by signal 8", () => {
  const parked = row({ body: "Waiting-for: closed #4000\n" });
  assert.deepEqual(waits(parked, AT_1022), []);
  assert.equal(waitWithoutReasonReading({ now: AT_1022, bare: waits(parked, AT_1022) }).status, "clear");
  assert.deepEqual(staleWaits({ items: [waitItemOf(parked, "row")], facts: openRef, now: AT_1022 }), []);
});

test("NEGATIVE CONTROL: the other reasons a park carries each excuse it -- a future date, an open edge, the chairman's brief", () => {
  const future = row({ body: "Not-before: 2026-10-20T00:00:00Z\n" });
  const edge = row({ body: "", blockedBy: { nodes: [{ number: 4000, state: "OPEN" }] } });
  const chairman = row({ body: "BRIEF for the chairman\n", labels: [{ name: "parked" }, { name: "needs:chairman" }] });
  for (const parked of [future, edge, chairman]) assert.deepEqual(waits(parked, AT_1022), [], JSON.stringify(parked.labels));
});

test("a park that names a `Not-before:` the gate can read stays excused AFTER the date, which is `unpark-satisfied`'s to act on, not a park without a reason", () => {
  assert.deepEqual(waits(row({ body: "Not-before: 2026-10-01\n" }), AT_1022), []);
});

test("`answer:<session>` beside `parked` and no `Waiting-for:` is named as before, by the answer and not the park", () => {
  const owed = row({ body: "", labels: [{ name: "parked" }, { name: "answer:product-manager" }], updatedAt: new Date(AT_1022 - 5 * HOUR_MS).toISOString() });
  const bare = waits(owed, AT_1022);
  assert.deepEqual(bare.map((b) => [b.fields, b.atOnce]), [[["answer:product-manager"], false]]);
  const young = row({ body: "", labels: [{ name: "parked" }, { name: "answer:product-manager" }] });
  assert.equal(waitWithoutReasonReading({ now: AT_1022, bare: waits(young, AT_1022) }).status, "clear", "the answer keeps the 4 quiet hours it always had");
});

// --- a TRUE condition: un-parked exactly as today, and named by signal 8 if the tick could not act -----------------------------

test("a parked row whose readable condition is TRUE is un-parked by the tick exactly as before: `parked` itself no longer counts as a wait standing", () => {
  const parked = row({ body: "Waiting-for: closed #4000\n" });
  const verdict = readSatisfaction(parked, closedRef, AT_1022);
  assert.equal(verdict.verdict, "satisfied");
  const open = readSatisfaction(parked, openRef, AT_1022);
  assert.deepEqual(open, { verdict: "untouched", reason: "`Waiting-for: closed #4000` is not true" });
});

test("a true condition on a parked row that still stands is a stale wait, and it names the `parked` label to remove", () => {
  const stale = staleWaits({ items: [waitItemOf(row({ body: "Waiting-for: closed #4000\n" }), "row")], facts: closedRef, now: AT_1022 });
  assert.equal(stale.length, 1);
  assert.ok(stale[0].remove.some((r) => r.includes("`parked` label")));
});

// --- the label repair's instruction ------------------------------------------------------------------------------------------

test("the state-label repair no longer says `parked` REPLACES `backlog` unconditionally: it says to read the wait first", () => {
  const [order] = orgHealthOrders([{ signal: SIGNALS.STATE_LABEL, status: "tripped", firstTrippedAt: null, discriminator: "state-label@x", detail: "1 row" }] as never);
  assert.match(order.prompt, /`parked` ONLY while its wait is real: READ the wait first/);
  assert.doesNotMatch(order.prompt, /`parked` and `epic` REPLACE/);
});
