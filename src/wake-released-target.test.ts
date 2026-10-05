// no-token: gh -- every herdr call is the injected `run`; nothing here reaches gh or a real herdr
/**
 * #3568: AN ORDER IS NEVER SENT TO AN INSTANCE THE SAME TICK RELEASED (chairman, via `ceo`, 2026-10-04).
 *
 * The tick that finished at 21:49:43Z released row #2702's claim, which closed `worker-2702`'s workspace, and then delivered three orders to it from a roster it
 * had read BEFORE: seven `agent_not_found` lines, six `UNDELIVERED` lines, `6 order(s) had nowhere to go`, and #3536 -- the chairman's first-priority row -- was one
 * of them, offered to a dead seat. `performRelease` now says it closed the workspace (`gone`) and `deliver` leaves such a seat out of every order of the tick.
 *
 * THE CONTROL COMES FIRST AND IS THE SAME SHAPE: a live instance in the same roster is sent its order unchanged, and every case below also types SOMETHING to a seat,
 * so a `deliver` that sent nothing at all would fail the control and not pass the rest by emptiness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, deliverHandoffs, relaneTarget } from "./wake.mjs";

const NO_TRANSCRIPTS = "/nonexistent/a11y-3568-no-transcripts";
const FAKE_HEAD = "d".repeat(40);
const FAKE_CHECKOUT = { git: () => `${FAKE_HEAD}\n`, exists: () => true, link: () => null, root: "/fake-reviews", repoRoot: "/fake-primary" };
const noSettle = () => {};
const ROSTER = ["ceo", "product-manager", "orchestrator", "worker-capture", "worker-judge", "worker-tooling"];
const RELEASED = "worker-2702";
const LIVE = "worker-3536";
const GONE = new Map([[RELEASED, "its workspace was closed by the release of #2702"]]);
const idle = (...labels: string[]) => labels.map((label) => ({ label, status: "idle" }));

/** A herdr that has NO agent labelled `dead`: every call naming it is refused as herdr refuses it, and every call is recorded. */
function herdr(dead: string[] = []) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (dead.some((label) => args.includes(label))) throw new Error(`herdr: agent_not_found: agent target ${args.find((a) => dead.includes(a))} not found`);
    return "{}";
  };
  /** Every call that names `label`, whatever it was. */
  const about = (label: string) => calls.filter((c) => c.includes(label));
  const prompted = (label: string) => calls.filter((c) => c[2] === "agent" && c[3] === "prompt" && c[4] === label && c[5] !== "/clear");
  return { run, calls, about, prompted };
}

const send = (herdrRun: (args: string[]) => string) => (orders: object[], agents: object[], deps: object = {}) =>
  deliver(orders as never, agents as never, ROSTER, { run: herdrRun, sleep: noSettle, contextRoot: NO_TRANSCRIPTS, checkout: FAKE_CHECKOUT, ...deps } as never);

const poolOrder = (row: number) => ({ session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`, prompt: `Row #${row} is ready; claim it.` });
const namedOrder = (session: string) => ({ session, cause: "answer-label-unexplained", causeKey: `${session}/answer-label-unexplained/row-2702`, prompt: "A label is unexplained." });

test("#3568 CONTROL: with no seat released, a pool order goes to the first free instance, which is typed its order unchanged", () => {
  const h = herdr();
  const got = send(h.run)([poolOrder(3536)], idle(RELEASED, LIVE));
  assert.deepEqual(got.refused, []);
  assert.equal(h.prompted(RELEASED).length, 1, "the live instance is sent its order (an empty run would pass every assertion below, so this one has to fail it)");
  assert.match(got.sent[0], new RegExp(`^${RELEASED} <- engineers/ready-row-unclaimed/3536`));
});

test("#3568 a seat released earlier in the tick receives no herdr call at all, and its ready-row-unclaimed order goes to a free engineer", () => {
  const h = herdr([RELEASED]);
  const got = send(h.run)([poolOrder(3536), poolOrder(3559)], idle(RELEASED, LIVE), { goneSeats: GONE });
  assert.deepEqual(h.about(RELEASED), [], "herdr was never asked about the released seat -- not a /compact, not a prompt");
  assert.match(got.sent[0], new RegExp(`^${LIVE} <- engineers/ready-row-unclaimed/3536`), "#3536 is the order the 21:49Z tick lost to the dead seat");
  assert.equal(h.prompted(LIVE).length, 1, "and the free engineer WAS typed it");
  assert.equal(got.sent.length, 1, "the second row finds that engineer working and does not fall back to the released seat");
  assert.equal(got.refused.length, 1, "it waits for the next tick: the one refusal is that row's, for want of an idle engineer");
  assert.match(got.refused[0], /^engineers\/ready-row-unclaimed\/3559: no engineer is idle/);
  assert.doesNotMatch(got.refused[0], new RegExp(RELEASED), "and the released seat is not even listed as a candidate");
});

test("#3568 a derived cause addressed to the released seat is DROPPED with a line saying so, never refused and never sent", () => {
  const h = herdr([RELEASED]);
  const got = send(h.run)([namedOrder(RELEASED)], idle(RELEASED, LIVE), { goneSeats: GONE });
  assert.deepEqual(h.about(RELEASED), []);
  assert.deepEqual(got.refused, [], "not counted as an order with nowhere to go");
  assert.equal(got.settled.length, 1);
  assert.match(got.settled[0], /^DROPPED worker-2702\/answer-label-unexplained\/row-2702: "worker-2702" ended this tick \(its workspace was closed by the release of #2702\)/);
  assert.match(got.settled[0], /derives it again from the row/);
});

test("#3568 an AUTHORED order for the released seat is LEFT QUEUED, not delivered, not retired and not 'nowhere to go'", () => {
  const h = herdr([RELEASED]);
  const now = 10 * 60 * 60 * 1000;
  const queued = [{ id: `handoff/${RELEASED}/0001`, session: RELEASED, prompt: "the check failed", queuedAt: now - 60_000 }];
  const dropped: string[][] = [];
  const out = deliverHandoffs(queued as never, idle(RELEASED, LIVE) as never, ROSTER, { run: h.run, now, goneSeats: GONE, sleep: noSettle, contextRoot: NO_TRANSCRIPTS, drop: (_path: string, ids: string[]) => dropped.push(ids) , queuePath: "/q" } as never);
  assert.deepEqual(h.about(RELEASED), [], "no herdr call");
  assert.deepEqual(out.ids, [], "nothing was carried, so the caller retires nothing");
  assert.deepEqual(dropped, [[]], "and the queue is told to drop NO id: the order is still there for the next tick");
  assert.deepEqual(out.refused, []);
  assert.match(out.settled[0], /^LEFT QUEUED handoff\/worker-2702\/[^:]+: "worker-2702" ended this tick/);
});

test("#3568 an order a cause DECLARES re-lanable, addressed to the released seat, goes to a free engineer through relaneTarget at once", () => {
  const h = herdr([RELEASED]);
  const order = { ...namedOrder(RELEASED), mayRelane: true };
  const got = send(h.run)([order], idle(RELEASED, LIVE), { goneSeats: GONE });
  assert.deepEqual(got.refused.concat(got.settled), []);
  assert.deepEqual(h.about(RELEASED), []);
  assert.match(got.sent[0], new RegExp(`^${LIVE} <- `));
  const typed = h.prompted(LIVE)[0].join(" ");
  assert.match(typed, /RE-LANED TO YOU: "worker-2702" has ended/);
  assert.doesNotMatch(typed, /busy for/, "the age bound is for a seat that is only busy");
});

test("#3568 relaneTarget CONTROL: a live-but-busy seat inside the bound is still not re-laned (the new path is for an ended seat only)", () => {
  const order = { ...namedOrder("product-manager"), mayRelane: true };
  const facts = { now: 1_000, live: idle(LIVE), roster: ROSTER };
  assert.equal(relaneTarget(order, { ...facts, deferredSince: new Map([[order.causeKey, 900]]) }), null, "100 ms of waiting is inside the bound");
  assert.equal(relaneTarget(order, { ...facts, goneSeats: new Map([["product-manager", "gone"]]) } as never)?.hasOwnProperty("label"), true, "an ended seat is re-laned with no history at all");
  assert.equal(relaneTarget({ ...order, mayRelane: false }, { ...facts, goneSeats: new Map([["product-manager", "gone"]]) } as never), null, "an undeclared order never is");
});

test("#3568 NO SECOND CALL: after ONE agent_not_found for a seat, later orders for it -- pool and named -- are handled without calling herdr again", () => {
  const h = herdr([RELEASED]);
  // The seat died BETWEEN the roster read and the prompt, so the tick has not been told: the first order pays the one refusal.
  const got = send(h.run)([poolOrder(3536), namedOrder(RELEASED), poolOrder(3559)], idle(RELEASED, LIVE));
  const calls = h.about(RELEASED);
  assert.ok(calls.length >= 1, "the first order DID reach herdr -- done-when 4: a death between the read and the prompt stays one refusal");
  const firstRefusal = calls.length;
  assert.equal(got.refused.filter((l) => l.includes("agent_not_found")).length, 1, `one refusal, not one per order: ${JSON.stringify(got.refused)}`);
  assert.equal(h.about(RELEASED).length, firstRefusal, "and every later order for the seat made no further call");
  assert.match(got.settled[0], /^DROPPED worker-2702\/answer-label-unexplained/, "the derived cause for it is dropped");
  assert.match(got.sent.join("\n"), new RegExp(`${LIVE} <- engineers/ready-row-unclaimed/3559`), "and the next ready row goes to the engineer that is there");
  assert.ok(got.goneSeats.has(RELEASED), "the seat is reported gone, so the tick's second delivery does not ask again");
});

test("#3568 the second delivery of a tick inherits what the first found: a handoff batch that met agent_not_found leaves the gate's orders no call to make", () => {
  const h = herdr([RELEASED]);
  const now = 10 * 60 * 60 * 1000;
  const queued = [{ id: `handoff/${RELEASED}/0001`, session: RELEASED, prompt: "the check failed", queuedAt: now - 60_000 }];
  const handed = deliverHandoffs(queued as never, idle(RELEASED, LIVE) as never, ROSTER, { run: h.run, now, sleep: noSettle, contextRoot: NO_TRANSCRIPTS, drop: () => {}, queuePath: "/q" } as never);
  const callsAfterHandoff = h.about(RELEASED).length;
  assert.ok(callsAfterHandoff >= 1 && handed.goneSeats.has(RELEASED), "the handoff paid the one refusal");
  const got = send(h.run)([poolOrder(3536), namedOrder(RELEASED)], idle(RELEASED, LIVE), { goneSeats: handed.goneSeats });
  assert.equal(h.about(RELEASED).length, callsAfterHandoff, "the gate's orders asked herdr nothing more about it");
  assert.match(got.sent[0], new RegExp(`^${LIVE} <- `));
});

test("#3568 CONTROL for the above: a refusal that is NOT agent_not_found leaves the seat in the roster, so its next order is still tried", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[3] === "prompt" && args[4] === RELEASED) throw new Error("herdr: agent_blocked: the agent is waiting on a permission prompt");
    return "{}";
  };
  const got = send(run)([namedOrder(RELEASED), { ...namedOrder(RELEASED), causeKey: `${RELEASED}/answer-label-unexplained/row-2703` }], idle(RELEASED));
  assert.equal(got.goneSeats.size, 0, "a blocked seat is not a gone one");
  assert.equal(got.settled.length, 0);
  assert.equal(got.refused.length, 2, "both were refused as before: UNDELIVERED, because the seat exists and could not take them");
  assert.equal(calls.filter((c) => c[3] === "prompt" && c[4] === RELEASED).length, 2, "and herdr WAS asked for each, which is what a seat that exists is owed");
});
