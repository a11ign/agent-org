// no-token: gh -- the code-host port is a fake and the arming read is a stub; nothing here spawns `gh`
/**
 * agent-org#488 (Phase 1 of a11ign/a11ign#4505): THE GATE ARMS A LONE UNARMED PULL REQUEST ITSELF AND A MANAGER IS WOKEN ONLY WHEN EVERY CANDIDATE IS UNARMED.
 *
 * The row's four named cases are the four tests whose names start with their sentence. The orders are the real ones: `readArming` is given the answer the API's
 * query gives, `settleUnarmedPrs` takes what it returns, and the result goes through `greenUnarmedOrders`, the entry `decide` calls, so what the order names is
 * what the gate would send and not what this file thinks it would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GREEN_UNARMED_SWITCH_ENV, greenUnarmedOrders, readArming, readArmingOf, readUnarmed, settleUnarmedPrs, type ArmingPort } from "./work-gate.ts";
import type { ChangeRef, Decision, ItemRef } from "./ticket-port/port.ts";

const HOME = "a11ign/a11ign";
const NOW = Date.parse("2026-10-10T12:00:00Z");

// --- the arming read, as the API answers it ------------------------------------------------------------------------------------------------

const unarmedNode = (number: number) => ({ number, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: null });
const armedNode = (number: number) => ({ number, isDraft: false, merged: false, autoMergeRequest: { enabledAt: "2026-10-10T11:00:00Z" }, mergeQueueEntry: null });
const queuedNode = (number: number) => ({ number, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "AWAITING_CHECKS" } });

// --- the fake port ----------------------------------------------------------------------------------------------------------------------

/** `refuse` maps a pull request to the message its arm throws; `notArmed` lists the ones whose arm runs and reads back "not armed". */
function fakePort({ refuse = {}, notArmed = [], failComment = false }: { refuse?: Record<number, string>; notArmed?: number[]; failComment?: boolean } = {}) {
  const arms: ChangeRef[] = [];
  const comments: { ref: ItemRef; decision: Decision; }[] = [];
  const scopesAsked: string[] = [];
  const portFor = (scope: string): ArmingPort => {
    scopesAsked.push(scope);
    return {
      armMerge(ref) {
        const number = Number(ref.id.split("#")[1]);
        arms.push(ref);
        if (refuse[number] !== undefined) throw new Error(refuse[number]);
        return !notArmed.includes(number);
      },
      postDecision(ref, decision) {
        if (failComment) throw new Error("HTTP 502: the comment could not be posted");
        comments.push({ ref, decision });
        return "1";
      },
    };
  };
  return { portFor, arms, comments, scopesAsked };
}

/** One tick: the API's answer read, the unarmed ones settled through the fake port, and the orders `decide` would make from what is left. */
function tick(nodes: object[], candidates: number[], { port = fakePort(), env = {} }: { port?: ReturnType<typeof fakePort>; env?: Record<string, string | undefined> } = {}) {
  const said: string[] = [];
  const reading = readArming(candidates, () => JSON.stringify(nodes));
  assert.ok(reading !== null, "the stubbed read answers");
  const settled = settleUnarmedPrs(reading.unarmed, { armed: reading.armed.length, of: candidates.length, portFor: port.portFor, env, log: (line) => said.push(line), now: NOW, scope: HOME });
  return { reading, settled, orders: greenUnarmedOrders(settled, { key: "", repo: HOME }), said, ...port };
}

// --- the row's Acceptance, one test per named case ---------------------------------------------------------------------------------------

test("one unarmed candidate among armed ones is armed by the gate and no order is produced", () => {
  const { orders, settled, arms, comments, said, reading } = tick([armedNode(7001), unarmedNode(7002), queuedNode(7003)], [7001, 7002, 7003]);
  assert.deepEqual(reading, { unarmed: [7002], armed: [7001, 7003] }, "a queued pull request is armed, as `armedFromApi` says");
  assert.deepEqual(orders, [], "no order");
  assert.deepEqual(settled, [], "and nothing is left of it");
  assert.deepEqual(arms, [{ host: "github", id: `${HOME}#7002` }], "one arm, of the unarmed one only");
  // recorded on the pull request, by the gate, with the header the port writes (Move 0), after the arm and not before it.
  assert.equal(comments.length, 1);
  assert.deepEqual(comments[0].ref, { tracker: "github", scope: HOME, id: 7002 });
  assert.equal(comments[0].decision.role, "work-gate");
  assert.equal(comments[0].decision.kind, "pr-green-unarmed");
  assert.match(said.join(""), /armed #7002 -- no order/);
});

test("every candidate unarmed produces the order as today, with the count, and arms nothing", () => {
  const { orders, settled, arms, comments, scopesAsked, said } = tick([unarmedNode(7001), unarmedNode(7002)], [7001, 7002]);
  assert.deepEqual([arms.length, comments.length, scopesAsked.length, said.length], [0, 0, 0, 0], "no arm, no record, no port asked");
  assert.deepEqual(settled, { numbers: [7001, 7002], of: 2, armed: 0 });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "product-manager");
  assert.equal(orders[0].cause, "pr-green-unarmed");
  assert.equal(orders[0].causeKey, "product-manager/pr-green-unarmed/7001.7002", "the key is the set, as it was");
  assert.match(orders[0].prompt, /^2 pull request\(s\) are green on every required check, NOT held, and NOTHING HAS ARMED THEM: #7001, #7002\./, "today's first sentence");
  assert.match(orders[0].prompt, /THE GATE'S COUNT: 2 of 2 candidate\(s\) are unarmed and 0 are armed\. NO candidate is armed, which is the signature of a refusing arming credential.*so the gate armed nothing/, "and the count the fork turns on");
  assert.match(orders[0].prompt, /FIRST ASK WHETHER THE CREDENTIAL IS REFUSING/, "the fork's own guidance is still the order's");
  // the same two, beside a third that is armed, are not the outage: the gate arms both.
  const beside = tick([unarmedNode(7001), unarmedNode(7002), armedNode(7003)], [7001, 7002, 7003]);
  assert.deepEqual(beside.arms.map((a) => a.id), [`${HOME}#7001`, `${HOME}#7002`]);
  assert.deepEqual(beside.orders, []);
});

test("the arming call goes through the code-host port, a fake port records it, and no direct gh spawn is named", () => {
  const port = fakePort();
  const { arms, comments, scopesAsked } = tick([armedNode(7001), unarmedNode(7002)], [7001, 7002], { port });
  assert.equal(arms.length, 1, "the arm was the fake's");
  assert.equal(comments.length, 1, "and so was the record");
  assert.deepEqual(scopesAsked, [HOME], "asked of the repository the pull requests are in");
  // THE SOURCE OF THE FUNCTIONS, because nothing in the call can show a spawn that was not made: neither names a spawn, a `gh` runner or an arming command.
  // (`armingPortOf`, below them, is the adapter: it is where `runArmPr` is called and so the one place the tracker's CLI is reached.)
  const source = readFileSync(fileURLToPath(new URL("./work-gate.ts", import.meta.url)), "utf8");
  for (const head of ["export function settleUnarmedPrs(", "function armOne("]) {
    const start = source.indexOf(head);
    const end = source.indexOf("\n}\n", start);
    assert.ok(start > 0 && end > start, `${head} is found`);
    const body = source.slice(start, end);
    for (const forbidden of [/execFileSync/, /\bspawn/, /defaultRun/, /runArmPr/, /"gh"/, /pr merge/, /--auto/]) {
      assert.doesNotMatch(body, forbidden, `${head} must not reach the code host except through the port (${forbidden})`);
    }
  }
});

test("negative control: with the switch off, one unarmed candidate produces today's order", () => {
  const nodes = [armedNode(7001), unarmedNode(7002)];
  const off = tick(nodes, [7001, 7002], { env: { [GREEN_UNARMED_SWITCH_ENV]: "off" } });
  assert.deepEqual([off.arms.length, off.comments.length, off.scopesAsked.length], [0, 0, 0], "no arm, no record and no port asked");
  assert.deepEqual(off.settled, [7002], "the list comes back as it was");
  assert.equal(off.orders.length, 1);
  assert.deepEqual(off.orders, greenUnarmedOrders([7002], { key: "", repo: HOME }), "and the order is the one the bare list has always made");
  assert.doesNotMatch(off.orders[0].prompt, /THE GATE'S COUNT/, "with none of the gate's words in it");
  // the control is real: the same tick with the switch unset arms it and sends nothing.
  const on = tick(nodes, [7001, 7002]);
  assert.equal(on.arms.length, 1);
  assert.deepEqual(on.orders, []);
  // and "off" is the only value that turns it off: another value is the cutover.
  assert.equal(tick(nodes, [7001, 7002], { env: { [GREEN_UNARMED_SWITCH_ENV]: "on" } }).arms.length, 1);
});

// --- the fork, and what is not armed stays an order -----------------------------------------------------------------------------------------

test("exactly one candidate in the queue, and it is unarmed: the gate arms it (the credential is asked, and the outage answers for itself)", () => {
  const { arms, orders } = tick([unarmedNode(7001)], [7001]);
  assert.deepEqual(arms.map((a) => a.id), [`${HOME}#7001`]);
  assert.deepEqual(orders, []);
  // and when the credential IS refusing, the arm throws, and the order goes to the manager with the count and with what the gate saw.
  const refused = tick([unarmedNode(7001)], [7001], { port: fakePort({ refuse: { 7001: "arm-pr exited 2: GraphQL: API rate limit already exceeded" } }) });
  assert.equal(refused.orders.length, 1);
  assert.match(refused.orders[0].prompt, /THE GATE'S COUNT: 1 of 1 candidate\(s\) are unarmed and 0 are armed\. NO candidate is armed/);
  assert.match(refused.orders[0].prompt, /RAN THE ARMING COMMAND on #7001 and it did not arm: #7001: arm-pr exited 2: GraphQL: API rate limit already exceeded/);
  assert.match(refused.said.join(""), /COULD NOT ARM #7001 \(arm-pr exited 2/);
});

test("every doubt is a wake: an arm that throws, an arm that reads back not armed and a record that fails", () => {
  const nodes = [armedNode(7001), unarmedNode(7002), unarmedNode(7003), unarmedNode(7004)];
  const { orders, arms, comments, said, settled } = tick(nodes, [7001, 7002, 7003, 7004], { port: fakePort({ refuse: { 7002: "HTTP 502" }, notArmed: [7003] }) });
  assert.deepEqual(arms.map((a) => Number(a.id.split("#")[1])), [7002, 7003, 7004], "each was tried");
  assert.deepEqual(comments.map((c) => c.ref.id), [7004], "and only the one that is armed is recorded: nothing is said on a pull request that was not");
  assert.deepEqual((settled as { numbers: number[] }).numbers, [7002, 7003]);
  assert.equal(orders.length, 1);
  assert.match(orders[0].prompt, /NOTHING HAS ARMED THEM: #7002, #7003\./);
  assert.match(orders[0].prompt, /2 of 4 candidate\(s\) are unarmed and 1 are armed\. At least one candidate IS armed/, "the count is said even here: the manager is told it is not the outage");
  assert.match(orders[0].prompt, /#7002: HTTP 502; #7003: the arming command ran and the pull request is still not armed/);
  assert.doesNotMatch(orders[0].prompt, /#7004\b/);
  assert.equal(orders[0].causeKey, "product-manager/pr-green-unarmed/7002.7003");
  assert.match(said.join(""), /COULD NOT ARM #7002/);
  // a record that cannot be posted does not put an armed pull request back in the order.
  const unrecorded = tick([armedNode(7001), unarmedNode(7002)], [7001, 7002], { port: fakePort({ failComment: true }) });
  assert.deepEqual(unrecorded.orders, []);
  assert.match(unrecorded.said.join(""), /armed #7002, COULD NOT RECORD IT ON THE PULL REQUEST \(HTTP 502/);
});

test("a candidate the read did not cover is not evidence that the credential works, and an ejected one is not a lone unarmed one", () => {
  // two unarmed, and the only other candidate is not in the query's answer: nothing is positively armed, so this is the outage's shape.
  const uncovered = tick([unarmedNode(7001), unarmedNode(7002)], [7001, 7002, 7003]);
  assert.equal(uncovered.arms.length, 0);
  assert.deepEqual(uncovered.settled, { numbers: [7001, 7002], of: 3, armed: 0 });
  assert.match(uncovered.orders[0].prompt, /THE GATE'S COUNT: 2 of 3 candidate\(s\) are unarmed and 0 are armed\. NO candidate is armed/);
  // `settleUnarmedPrs` is handed what is left once ejections are split out, and the armed count is the read's own.
  const afterEjection = settleUnarmedPrs([7002], { armed: 0, of: 2, portFor: fakePort().portFor, log: () => {}, scope: HOME, now: NOW });
  assert.deepEqual(afterEjection, [], "the one that is left is a lone unarmed one, and is armed");
});

test("the read: `readUnarmed` answers what it answered, a refused read is null and nothing is armed on it", () => {
  const nodes = [unarmedNode(7001), armedNode(7002), queuedNode(7003)];
  assert.deepEqual(readUnarmed([7001, 7002, 7003], () => JSON.stringify(nodes)), [7001]);
  assert.deepEqual(readArming([], () => { throw new Error("must not be asked"); }), { unarmed: [], armed: [] });
  assert.equal(readArming([7001], () => { throw new Error("GraphQL: API rate limit already exceeded"); }), null);
  assert.equal(readArming([7001], () => "not json"), null);
  const port = fakePort();
  assert.deepEqual(settleUnarmedPrs([], { armed: 3, of: 3, portFor: port.portFor, log: () => {}, scope: HOME }), [], "nothing unarmed asks no port");
  assert.equal(port.scopesAsked.length, 0);
});

test("a bare list makes the order it always made: the gate's words are added only when the gate held a count", () => {
  const [bare] = greenUnarmedOrders([7001, 7002], { key: "", repo: HOME });
  assert.doesNotMatch(bare.prompt, /THE GATE'S COUNT/);
  assert.match(bare.prompt, /^2 pull request\(s\) are green on every required check, NOT held, and NOTHING HAS ARMED THEM: #7001, #7002\.\nThis is the state a refused arming credential produces/);
  assert.deepEqual(greenUnarmedOrders(null), []);
  assert.deepEqual(greenUnarmedOrders({ numbers: [], of: 4, armed: 4 }), []);
});

// --- the tick's own wiring: `readArmingOf` is the function both call sites of the gate make ----------------------------------------------------

/** A green, unheld, non-draft pull request as `readPrs` returns it. */
const green = (number: number) => ({ number, isDraft: false, labels: [], statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] });
/** `gh`, as the gate runs it: the candidates query answers `nodes`, and each pull request's timeline reads as never queued. */
const ghStub = (nodes: object[]) => (args: string[]) =>
  args.some((arg) => arg.includes("timelineItems")) ? JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [] } }) : JSON.stringify(nodes);

test("the tick: the candidates, the read, the ejection split and the settle are one chain, and the count is the read's, not the list's", () => {
  const prs = [green(7001), green(7002), green(7003)];
  // 7003 is not in the query's answer (past its window, or another base): two unarmed and NOTHING positively armed, so nothing is armed by the gate.
  const port = fakePort();
  const outage = readArmingOf(prs, ["gate"], { scope: HOME, run: ghStub([unarmedNode(7001), unarmedNode(7002)]), portFor: port.portFor, env: {}, log: () => {} });
  assert.deepEqual(outage?.unarmed, { numbers: [7001, 7002], of: 3, armed: 0 });
  assert.equal(port.arms.length, 0);
  // one armed beside them is the credential working: both are armed, and the order has nothing to name.
  const working = fakePort();
  const fine = readArmingOf(prs, ["gate"], { scope: HOME, run: ghStub([armedNode(7001), unarmedNode(7002), unarmedNode(7003)]), portFor: working.portFor, env: {}, log: () => {} });
  assert.deepEqual(fine?.unarmed, []);
  assert.deepEqual(working.arms.map((a) => a.id), [`${HOME}#7002`, `${HOME}#7003`]);
  // a refused read is null, as it was, and the port is not asked.
  const refused = fakePort();
  assert.equal(readArmingOf(prs, ["gate"], { scope: HOME, run: () => { throw new Error("GraphQL: API rate limit already exceeded"); }, portFor: refused.portFor, env: {} }), null);
  assert.equal(refused.scopesAsked.length, 0);
});
