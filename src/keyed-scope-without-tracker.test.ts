// no-token: gh -- imports `work-gate.mjs`, whose default readers spawn `gh`; the lanes are read through an injected `run` and the per-tick reads are stubs, so nothing is spawned (#3493)
/**
 * #3493: A CODE-ONLY SCOPE DOES NOT ASK A TRACKER QUESTION, because it has no tracker.
 *
 * `readLanes` gave such a scope `[]` for every tracker lane, but `scopeTick` still ran `readings.tracker` inside `inRepo(undefined)`, which
 * is the AMBIENT repository -- the primary's. One closed row owing an answer became one `answer-owed` order per code scope, three of them
 * naming a repository where the row does not exist.
 *
 * POSITIVE CONTROLS: (1) and (3) are the non-empty cases the emptiness of (2) and (4) is read against. (2) and (4) fail on the code before the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopesOf, readLanes, scopeTick } from "./work-gate.mjs";

const TRACKER = "a11ign/a11ign";
const CLOSED_ROW = { number: 3423, state: "CLOSED", labels: [{ name: "answer:product-manager" }] };

/** The declaration under test: one tracker (the primary's) and the code scopes, keyed or not -- `tracker` with a key adds a tracker of its own. */
const scopes = scopesOf([{
  tracker: [{ key: "", repo: TRACKER }, { key: "own", repo: "a11ign/own" }],
  code: [{ key: "", repo: TRACKER }, { key: "own", repo: "a11ign/own" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "documents", repo: "a11ign/documents" }],
}]);
const scopeOf = (key: string) => scopes.find((scope) => scope.key === key)!;

/** A tracker that answers with the one closed row, and counts how often it was asked. */
function stubTracker() {
  const calls: unknown[] = [];
  return { calls, readings: {
    code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null }),
    tracker: (lists: unknown) => { calls.push(lists); return { claimedComments: [], epics: [], closedRows: [CLOSED_ROW], closings: null }; },
  } };
}

const ordersOf = (scope: ReturnType<typeof scopeOf>, readings: ReturnType<typeof stubTracker>["readings"]) =>
  (scopeTick(scope, false, readLanes(scope, () => "[]"), readings).orders as { cause: string, causeKey: string, prompt: string }[])
    .filter((order) => order.cause === "answer-owed");

test("(1) the primary scope, with a tracker declared, owes the answer once", () => {
  const { readings, calls } = stubTracker();
  const orders = ordersOf(scopeOf(""), readings);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].causeKey, "product-manager/answer-owed/row-3423");
  assert.equal(calls.length, 1);
});

test("(2) a keyed scope with `tracker: null` yields NO answer-owed order, and the tracker is not asked", () => {
  assert.equal(scopeOf("agent-org").tracker, null, "the scope under test must be code-only, or this test is (3)");
  const { readings, calls } = stubTracker();
  assert.deepEqual(ordersOf(scopeOf("agent-org"), readings), []);
  assert.equal(calls.length, 0);
});

test("(3) a keyed scope WITH its own tracker still gets its order, tagged with its key and its tracker's repo", () => {
  const { readings, calls } = stubTracker();
  const orders = ordersOf(scopeOf("own"), readings);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].causeKey, "product-manager/answer-owed/row-own#3423");
  assert.match(orders[0].prompt, /a11ign\/own/);
  assert.equal(calls.length, 1);
});

test("(4) two code-only scopes and the primary, over one stub, yield exactly ONE order between them", () => {
  const { readings } = stubTracker();
  const all = ["", "agent-org", "documents"].flatMap((key) => ordersOf(scopeOf(key), readings));
  assert.equal(all.length, 1);
  assert.equal(all[0].causeKey, "product-manager/answer-owed/row-3423");
});
