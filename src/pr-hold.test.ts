// no-token: none -- the hold-holder step is pure over the pull requests, the herdr listing and the declarations handed to it; `holdHolderOrdersNow` is given its listing and a temp state directory; the take-level cycle tests run the real CLI over the fake code host, in a child process with no `gh` on its PATH
/**
 * #4970: A HOLD ON A PULL REQUEST OUTLIVES NO HOLDER. A holder idle 30 minutes with no declared state, or gone, is woken ONCE; 30 minutes later, still idle or gone, the seat that decides
 * is asked ONCE; and nothing here removes a label. Every "left alone" has a sibling that differs in the one thing that makes it act.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declarationExcusesHold, escalationSeatFor, holdHolderKey, holderOrdersOf, holderStep, HOLD_HOLDER_CAUSE, HOLDER_ESCALATE_MINUTES, HOLDER_IDLE_MINUTES,
  type HolderDeclaration, type HolderMemory,
} from "./pr-hold-state.ts";
import { WAIT_MARKER } from "./wait-condition.ts";
import { HOLD_HOLDERS_FILE, holdHolderOrdersNow } from "./work-gate/causes/pr-holds.ts";
import { workGateSource } from "./lib/work-gate-source.ts";
import { holdOverFake, type HoldPull } from "./plugins/fakes/pr-hold-cli.test.support.ts";

const MINUTE = 60_000;
const HELD_AT = Date.parse("2026-10-11T08:00:00Z");
const HOLDER = "worker-9";
const STANDING = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }];
const listing = (status: string | null, holder = HOLDER) => [...STANDING, ...(status === null ? [] : [{ label: holder, status }])];

/** An open pull request carrying `hold:<holder>`, its marker comment dated `HELD_AT`, as the gate's list reads it. */
const heldPr = (over: { number?: number; holders?: string[]; approved?: boolean; marked?: boolean } = {}) => ({
  number: over.number ?? 4971,
  labels: (over.holders ?? [HOLDER]).map((holder) => ({ name: `hold:${holder}` })),
  comments: over.marked === false ? [] : [{ body: `${WAIT_MARKER}\nWaiting-for: closed #2867`, createdAt: new Date(HELD_AT).toISOString() }],
  reviewDecision: over.approved === false ? "REVIEW_REQUIRED" : "APPROVED",
});

type Memory = Record<string, HolderMemory>;
const tick = (over: { prs?: ReturnType<typeof heldPr>[]; agents?: { label: string; status: string }[] | null; declarations?: Map<string, HolderDeclaration>; memory?: Memory; at: number }) =>
  holderOrdersOf({ prs: over.prs ?? [heldPr()], agents: over.agents === undefined ? listing("idle") : over.agents, declarations: over.declarations ?? new Map(),
    memory: over.memory ?? {}, now: HELD_AT + over.at * MINUTE });

/** Run the ticks at these minute offsets over one listing, carrying the memory, and return every tick's orders. */
function ticks(at: number[], over: { agents?: { label: string; status: string }[] | null; declarations?: Map<string, HolderDeclaration>; prs?: ReturnType<typeof heldPr>[] } = {}) {
  let memory: Memory = {};
  return at.map((minute) => {
    const result = tick({ ...over, memory, at: minute });
    memory = result.memory;
    return { at: minute, orders: result.orders, memory };
  });
}

// --- the holder is idle: woken once --------------------------------------------------------------------------------------------------------------------------------------------

test("an idle holder is woken ONCE, at 30 minutes, with the pull request and the hold named, and never again by later idle ticks", () => {
  const run = ticks([0, 10, HOLDER_IDLE_MINUTES, HOLDER_IDLE_MINUTES + 10, HOLDER_IDLE_MINUTES + 20]);
  assert.deepEqual(run.map((t) => t.orders.length), [0, 0, 1, 0, 0]);
  const [wake] = run[2].orders;
  assert.equal(wake.session, HOLDER);
  assert.equal(wake.cause, HOLD_HOLDER_CAUSE);
  assert.match(wake.prompt, /4971/, "names the pull request");
  assert.match(wake.prompt, /hold:worker-9/, "names the hold");
  assert.match(wake.prompt, /WHICH IS APPROVED/, "an approved pull request says so");
  assert.match(wake.prompt, /pr:release 4971 --session=worker-9/, "the way out is a command");
  assert.equal(wake.fallback, undefined, "a holder that exists needs no fallback");
});

test("control: the same holder one minute short of 30 is not woken", () => {
  const [short] = ticks([HOLDER_IDLE_MINUTES - 1]);
  assert.deepEqual(short.orders, []);
  const first = tick({ at: 0 });
  const second = tick({ memory: first.memory, at: HOLDER_IDLE_MINUTES - 1 });
  assert.deepEqual(second.orders, [], "the clock started at the first idle tick, and 29 minutes is short");
  assert.equal(tick({ memory: first.memory, at: HOLDER_IDLE_MINUTES }).orders.length, 1, "and 30 is not");
});

// --- still idle after the wake: the seat that decides is asked once, and the label stays ------------------------------------------------------------------------------------------

test("after the second 30 minutes `orchestrator` is asked to decide, once, and the hold's label is left where it was", () => {
  const prs = [heldPr()];
  const before = JSON.stringify(prs);
  const woken = HOLDER_IDLE_MINUTES;
  const decided = woken + HOLDER_ESCALATE_MINUTES;
  const run = ticks([0, woken, woken + 15, decided, decided + 10, decided + 60], { prs });
  assert.deepEqual(run.map((t) => t.orders.map((o) => o.session)), [[], [HOLDER], [], ["orchestrator"], [], []]);
  const [decision] = run[3].orders;
  assert.equal(decision.cause, HOLD_HOLDER_CAUSE);
  assert.match(decision.prompt, /4971/);
  assert.match(decision.prompt, /release it/);
  assert.match(decision.prompt, /take the work over/);
  assert.match(decision.prompt, /WILL NOT REMOVE THE LABEL/);
  assert.equal(JSON.stringify(prs), before, "the pull request read is exactly as it was: its label is present");
  assert.notEqual(decision.causeKey, run[1].orders[0].causeKey, "the wake and the decision are two orders, not one repeated");
});

test("the holder that works after its wake is not woken again, and is asked about only if it goes idle for the full window after the wake", () => {
  const woken = HOLDER_IDLE_MINUTES;
  let memory: Memory = tick({ at: 0 }).memory;
  memory = tick({ memory, at: woken }).memory;
  const working = tick({ memory, agents: listing("working"), at: woken + 5 });
  assert.deepEqual(working.orders, []);
  assert.notDeepEqual(working.memory, {}, "a woken holder's memory survives its working turn: forgetting it would wake it again");
  const idleAgain = tick({ memory: working.memory, at: woken + 10 });
  assert.deepEqual(idleAgain.orders, [], "idle again 10 minutes after the wake is not a second wake");
  assert.equal(tick({ memory: idleAgain.memory, at: woken + HOLDER_ESCALATE_MINUTES }).orders.map((o) => o.session).join(), "orchestrator");
});

test("`orchestrator` holding a hold is never asked to decide its own: `ceo` is", () => {
  assert.equal(escalationSeatFor("orchestrator"), "ceo");
  assert.equal(escalationSeatFor(HOLDER), "orchestrator");
  const prs = [heldPr({ holders: ["orchestrator"] })];
  const agents = [...STANDING];
  const run = ticks([0, HOLDER_IDLE_MINUTES, HOLDER_IDLE_MINUTES + HOLDER_ESCALATE_MINUTES], { prs, agents });
  assert.deepEqual(run.map((t) => t.orders.map((o) => o.session)), [[], ["orchestrator"], ["ceo"]]);
});

// --- left alone ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a working holder is left alone however long it has held, and leaves no memory", () => {
  const run = ticks([0, 45, 90, 400], { agents: listing("working") });
  assert.deepEqual(run.flatMap((t) => t.orders), []);
  assert.deepEqual(run[3].memory, {});
});

test("a holder that declared what it waits on is left alone: `blocked`, and `waiting-ci` / `waiting-review` naming THIS pull request", () => {
  const declared = (state: string, pr?: { number: number }) => new Map([[HOLDER, { state, at: HELD_AT + MINUTE, ...(pr ? { pr } : {}) }]]);
  for (const declarations of [declared("blocked"), declared("waiting-ci", { number: 4971 })]) {
    assert.deepEqual(ticks([0, 45, 120], { declarations }).flatMap((t) => t.orders), []);
  }
  assert.deepEqual(ticks([0, 45], { declarations: declared("waiting-review", { number: 4971 }), prs: [heldPr({ approved: false })] }).flatMap((t) => t.orders), []);
});

test("controls: a `done` declaration, one naming another pull request, and one older than the hold do NOT excuse it", () => {
  const woken = (declarations: Map<string, HolderDeclaration>, prs = [heldPr()]) => ticks([0, HOLDER_IDLE_MINUTES], { declarations, prs })[1].orders.length;
  const entry = (declaration: HolderDeclaration) => new Map([[HOLDER, declaration]]);
  assert.equal(woken(entry({ state: "done", at: HELD_AT + MINUTE })), 1, "the work it names is finished; the hold stands");
  assert.equal(woken(entry({ state: "waiting-ci", at: HELD_AT + MINUTE, pr: { number: 12 } })), 1, "another pull request's wait is not this one's");
  assert.equal(woken(entry({ state: "blocked", at: HELD_AT - MINUTE })), 1, "a declaration made before the hold describes an earlier thing");
  assert.equal(woken(entry({ state: "waiting-review", at: HELD_AT + MINUTE, pr: { number: 4971 } })), 1, "an approved pull request is no longer waiting for review");
  assert.equal(woken(new Map(), [heldPr({ approved: true })]), 1, "and no declaration at all is the case the order exists for");
});

test("a declaration excuses by the pull request's repository when it names one", () => {
  const pr = { number: 7, repoKey: "agent-org", since: HELD_AT, approved: false };
  assert.equal(declarationExcusesHold({ state: "waiting-ci", at: HELD_AT + MINUTE, pr: { number: 7, repoKey: "agent-org" } }, pr), true);
  assert.equal(declarationExcusesHold({ state: "waiting-ci", at: HELD_AT + MINUTE, pr: { number: 7, repoKey: "other" } }, pr), false);
  assert.equal(declarationExcusesHold(undefined, pr), false);
});

// --- gone: the one order is the decision ---------------------------------------------------------------------------------------------------------------------------------------

test("a GONE holder's single order falls back to `orchestrator`, carrying the decision text, and the later tick does not ask again", () => {
  const run = ticks([0, HOLDER_IDLE_MINUTES, HOLDER_IDLE_MINUTES + HOLDER_ESCALATE_MINUTES, HOLDER_IDLE_MINUTES + 90], { agents: listing(null) });
  assert.deepEqual(run.map((t) => t.orders.length), [0, 1, 0, 0]);
  const [order] = run[1].orders;
  assert.equal(order.session, HOLDER);
  assert.equal(order.fallback, "orchestrator");
  assert.equal(order.fallbackOnlyIfAbsent, true, "an unreachable holder, and only then");
  assert.match(order.fallbackPrompt ?? "", /NO LONGER EXISTS/);
  assert.match(order.fallbackPrompt ?? "", /4971/);
  assert.match(order.fallbackPrompt ?? "", /take the work over/);
});

// --- silence and memory --------------------------------------------------------------------------------------------------------------------------------------------------------

test("a listing that is not the whole org, or no listing, is silence and the memory stays as it was", () => {
  const memory: Memory = { [holdHolderKey({ pr: { number: 4971, since: HELD_AT, approved: true }, holder: HOLDER })]: { idleSince: HELD_AT } };
  for (const agents of [null, [{ label: HOLDER, status: "idle" }], [{ label: "ceo", status: "idle" }, { label: HOLDER, status: "idle" }]]) {
    const result = tick({ agents, memory, at: 600 });
    assert.deepEqual(result.orders, []);
    assert.deepEqual(result.memory, memory, "an unreadable org proves nothing about the holder");
  }
  assert.equal(tick({ agents: listing("idle"), memory, at: 600 }).orders.length, 1, "control: the complete listing over the same memory acts");
});

test("a released hold, a re-taken hold and a second holder: memory is pruned to the holds that exist, and each hold has its own clocks", () => {
  const first = tick({ at: 0 });
  assert.equal(Object.keys(first.memory).length, 1);
  assert.deepEqual(tick({ prs: [{ ...heldPr(), labels: [] }], memory: first.memory, at: 10 }).memory, {}, "released: forgotten");
  const retaken = heldPr({ marked: false });
  assert.notEqual(
    holdHolderKey({ pr: { number: 4971, since: HELD_AT, approved: true }, holder: HOLDER }),
    holdHolderKey({ pr: { number: 4971, since: HELD_AT + MINUTE, approved: true }, holder: HOLDER }),
    "a hold taken again is a new hold",
  );
  assert.equal(tick({ prs: [retaken], at: 0 }).orders.length, 0, "an undated hold starts its clock like any other");
  const two = tick({ prs: [heldPr({ holders: [HOLDER, "worker-10"] })], agents: [...listing("idle"), { label: "worker-10", status: "working" }], at: 0 });
  assert.equal(Object.keys(two.memory).length, 1, "only the idle holder of the two accrues idle time");
});

test("a pull request nobody holds yields nothing, and is the positive control for every emptiness above", () => {
  const unheld = { number: 5, labels: [{ name: "needs:review" }], comments: [], reviewDecision: "APPROVED" };
  assert.deepEqual(tick({ prs: [unheld], at: 600 }), { orders: [], memory: {} });
  assert.equal(holderStep({ holder: HOLDER, pr: { number: 1, since: null, approved: true }, agents: listing("idle"), declaration: undefined }, { memory: { idleSince: 0 }, now: 31 * MINUTE }).step, "wake");
});

// --- the gate's wrapper ---------------------------------------------------------------------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "hold-holders-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshState = () => { const path = join(dir, `state-${n++}`); mkdirSync(join(path, "worker-state"), { recursive: true }); return path; };
const quiet = () => {};

test("`holdHolderOrdersNow` wakes on the tick that crosses 30 minutes, persists the clock, and a second call at the same time is silent", () => {
  const stateDir = freshState();
  const run = (minute: number) => holdHolderOrdersNow({ prs: [heldPr()], now: HELD_AT + minute * MINUTE, stateDir, agents: () => listing("idle"), log: quiet });
  assert.deepEqual(run(0), []);
  assert.equal(run(HOLDER_IDLE_MINUTES).length, 1);
  assert.deepEqual(run(HOLDER_IDLE_MINUTES + 1), [], "the woken hold is remembered in the file and not woken again");
  assert.ok(existsSync(join(stateDir, HOLD_HOLDERS_FILE)));
});

test("`holdHolderOrdersNow` reads declarations from the state directory, and is silent on a refused read", () => {
  const stateDir = freshState();
  writeFileSync(join(stateDir, "worker-state", `${HOLDER}.json`), JSON.stringify({ session: HOLDER, state: "blocked", at: HELD_AT + MINUTE, row: 4970, reason: "waiting on an answer" }));
  const run = (minute: number, prs: unknown[] | null = [heldPr()]) => holdHolderOrdersNow({ prs, now: HELD_AT + minute * MINUTE, stateDir, agents: () => listing("idle"), log: quiet });
  assert.deepEqual([run(0), run(60), run(200)].flat(), [], "declared blocked: left alone");
  assert.deepEqual(run(200, null), [], "a refused pull-request list is silence");
  const lines: string[] = [];
  const unreadable = holdHolderOrdersNow({ prs: [heldPr()], now: HELD_AT + 60 * MINUTE, stateDir: freshState(), agents: () => { throw new Error("herdr refused"); }, log: (l) => lines.push(l) });
  assert.deepEqual(unreadable, [], "a listing that throws is no order, not a crashed tick");
  assert.match(lines.join(""), /hold-holders: could not run \(herdr refused\)/);
});

test("`holdHolderOrdersNow` forgets a released hold's memory in the file, and touches nothing else", () => {
  const stateDir = freshState();
  const at = (minute: number, prs: unknown[]) => holdHolderOrdersNow({ prs, now: HELD_AT + minute * MINUTE, stateDir, agents: () => listing("idle"), log: quiet });
  at(0, [heldPr()]);
  assert.notDeepEqual(JSON.parse(readFileSync(join(stateDir, HOLD_HOLDERS_FILE), "utf8")), {});
  at(5, [{ ...heldPr(), labels: [] }]);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, HOLD_HOLDERS_FILE), "utf8")), {});
});

test("the tick calls it: `main()` in work-gate.ts spreads `holdHolderOrdersNow` into the orders, over the pull requests it already read", () => {
  const gate = workGateSource();
  const calls = gate.match(/\.\.\.holdHolderOrdersNow\(\{ prs: prs === null \? null : \[\.\.\.prs, \.\.\.pullRequestsOfOthers\(otherScopes\)\] \}\)/g) ?? [];
  assert.equal(calls.length, 1, "exactly one call in the tick, so a deleted wiring is a red test and not a silent gate");
});

// --- the take refuses a hold that closes a cycle (#1396): the real CLI over the fake code host, which holds each pull request and row by `repo#n` ----------------------

const REPO = "a11ign/agent-org";
const FIRST_REPO = "a11ign/a11ign";
const PROJECT = { first: FIRST_REPO, keyed: { "agent-org": REPO } };
const HELD_PR = 1365;
const TARGET_ROW = 1325;
const CLOSER_PR = 1378;
const HELD_REF = `${REPO}#${HELD_PR}`;

/**
 * `product-manager` takes a hold on agent-org#1365 with `argv` over the fake code host. The 2026-10-13 shape: #1325 is an open row, closed by the open pull request #1378, and the held #1365 waits `closed #1325`;
 * `closerBody` is #1378's body, and `heldBody` the held pull request's. `closer: false` leaves #1378 unreadable (GitHub lists it as closing #1325, the code host has none of it).
 */
function cycleTake(shape: { closerBody?: string, heldBody?: string, closer?: boolean }, ...argv: string[]) {
  const { closerBody = "", heldBody = "", closer = true } = shape;
  const pulls: Record<number, HoldPull> = { [HELD_PR]: { labels: ["ready"], body: heldBody, armed: true } };
  if (closer) pulls[CLOSER_PR] = { body: closerBody, closes: [TARGET_ROW] };
  const run = holdOverFake(PROJECT, { home: REPO, repos: { [REPO]: {
    pulls,
    rows: { [TARGET_ROW]: { labels: ["ready"] } },
    closingUnread: closer ? {} : { [`${REPO}#${TARGET_ROW}`]: [{ number: CLOSER_PR, repo: REPO }] },
  } } }, String(HELD_PR), "--repo-key=agent-org", "--session=product-manager", ...argv);
  const held = run.repos[REPO];
  return { ...run, written: held.written, held: held.pulls[HELD_PR] };
}

test("REFUSED (#1396): `closed #1325` where #1325's open pull request #1378 waits `merged #1365` is refused, the cycle named, and nothing written", () => {
  const refused = cycleTake({ closerBody: "Closes #1325\n\nWaiting-for: merged #1365" }, "--until=closed #1325");
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /^REFUSING --until="closed #1325": the hold would close a cycle, a11ign\/agent-org#1365, which waits on a11ign\/agent-org#1325, which waits on a11ign\/agent-org#1378, which waits on a11ign\/agent-org#1365: each waits on the next/m);
  assert.match(refused.stderr, /--until=manual/);
  assert.deepEqual(refused.written, [], "no label, no marker, no merge");
  assert.deepEqual(refused.held.labels, ["ready"], "the held pull request carries no hold");
  assert.deepEqual(refused.held.comments, [], "and no marker");
  assert.equal(refused.held.armed, true, "and it was not disarmed");
  assert.deepEqual(refused.asked, [
    `holdTargetRowOf ${REPO}#${TARGET_ROW}`,
    `pullRequestFieldsOf body ${HELD_REF}`,
    `pullRequestFieldsOf body,comments ${REPO}#${CLOSER_PR}`,
  ], "the reads the decision needs, and nothing after the refusal");
});

test("REFUSED (#1396): the same cycle through the row the held pull request closes: #1365 closes #1300, and #1378 waits `closed #1300`", () => {
  const refused = cycleTake({ closerBody: "Closes #1325\n\nWaiting-for: closed #1300", heldBody: "Closes #1300" }, "--until=closed #1325");
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /would close a cycle, a11ign\/agent-org#1365, which waits on a11ign\/agent-org#1325, which waits on a11ign\/agent-org#1378, which waits on a11ign\/agent-org#1300, which waits on a11ign\/agent-org#1365/);
  assert.deepEqual(refused.written, []);
});

test("CONTROL (#1396): the same hold is TAKEN when #1378 waits on a third row, and when #1378 cannot be read (a NOTE, not a refusal)", () => {
  const third = cycleTake({ closerBody: "Closes #1325\n\nWaiting-for: merged #1300" }, "--until=closed #1325");
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(third.held.labels, ["ready", "hold:product-manager", "rearm-on-release"]);
  assert.deepEqual(third.held.comments, [`${WAIT_MARKER}\nHeld by \`product-manager\`.\nWaiting-for: closed #1325`]);

  const unreadable = cycleTake({ closer: false }, "--until=closed #1325");
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.match(unreadable.stderr, /^NOTE: could not read a11ign\/agent-org#1378, a pull request that closes a11ign\/agent-org#1325/m);
  assert.deepEqual(unreadable.held.labels, ["ready", "hold:product-manager", "rearm-on-release"], "the hold is taken as asked");
});
