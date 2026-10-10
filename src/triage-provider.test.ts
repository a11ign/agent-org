// #4384: the triage seam. A fake `fetch`, a fake `readKey` and a fake diagnostic only: no network, no real key, no file read.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./decision-provider.ts";
import { parseHostConfig } from "./host-config.ts";
import { compose, freshState, QUESTIONS, REPEAT_FLOOR, REPEAT_WINDOW_MINUTES, triageOrder, WAKE_GUARD_FLOOR, type QuestionName } from "./triage-provider.ts";

const FAKE_KEY = "tsk-FAKE-0123456789-do-not-print";
const KEY_PATH = "/fake/typesafe/key";
const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.9 };
const ORDER = { cause: "answer-owed", causeKey: "product-manager/answer-owed/row-1", session: "product-manager", lastDeliveredMinutesAgo: 30, mainRed: false, chairmanDirection: false };

type Reply = { status?: number; body?: unknown; throws?: boolean; hangs?: boolean };
const NAMES = Object.keys(QUESTIONS) as QuestionName[];
/** What the provider says to the five questions when nothing in the event asks for a wake and nothing says it can wait: it asks something of this seat. */
const QUIET = { "asks-this-seat": "yes", repeat: "no", "names-red-main": "no", "names-chairman-direction": "no", "informational-only": "no" } as const;
/** All five answered at one confidence, `say` overriding the quiet `no`s. */
const answered = (say: Partial<Record<QuestionName, string>>, confidence = 0.95) => ({
  answers: Object.fromEntries(NAMES.map((name) => [name, { type: "choice", choice: { ...QUIET, ...say }[name], probabilities: {}, confidence }])),
});
/** Held for the digest: one answer, that the event asks nothing of this seat. */
const digestible = (confidence = 0.95) => answered({ "asks-this-seat": "no" }, confidence);
/** Each question answered at its OWN confidence, `[choice, confidence]`, the rest quiet at 0.95: what a provider that is sure of one thing and not of the others sends. */
const mixed = (say: Partial<Record<QuestionName, readonly [string, number]>>) => ({
  answers: Object.fromEntries(NAMES.map((name) => {
    const [choice, confidence] = say[name] ?? [QUIET[name], 0.95];
    return [name, { type: "choice", choice, probabilities: {}, confidence }];
  })),
});

/** A fake `fetch` that records every call and answers `reply`. */
function fakeFetch(reply: Reply | (() => Reply)) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = typeof reply === "function" ? reply() : reply;
    if (r.throws) throw new Error("connection refused");
    if (r.hangs) return new Promise(() => {});
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Everything one run can leak through, collected so the key's text can be searched for in ALL of it. */
function rig(triage: unknown, reply: Reply | (() => Reply) = { body: answered({}, 1) }, readKey?: (path: string) => string) {
  const net = fakeFetch(reply);
  const lines: string[] = [];
  const reads: string[] = [];
  const deps = {
    host: withTriage(triage), fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line: string) => lines.push(line),
    readKey: readKey ?? ((path: string) => { reads.push(path); return FAKE_KEY; }),
  };
  return { deps, net, lines, reads };
}

const orders = (n: number) => Array.from({ length: n }, (_, index) => ({ ...ORDER, causeKey: `k${index}` }));

test("provider absent: every order wakes, via none, and fetch is called zero times (Jev is optional)", async () => {
  const { deps, net, lines, reads } = rig(undefined);
  for (const order of orders(50)) assert.deepEqual(await triageOrder(order, deps), { route: "wake", via: "none", reason: "no triage provider is declared" });
  assert.equal(net.calls.length, 0);
  assert.deepEqual([lines, reads], [[], []], "no diagnostic and no key read on a host that declares no triage");
  assert.deepEqual(withTriage().triage, { provider: "none" });
});

test("provider none, written explicitly: the same", async () => {
  const { deps, net, lines } = rig({ provider: "none" });
  for (const order of orders(5)) assert.equal((await triageOrder(order, deps)).via, "none");
  assert.equal(net.calls.length, 0);
  assert.deepEqual(lines, []);
});

test("the key missing: every order wakes, no throw, fetch zero times, ONE diagnostic across 50 orders", async () => {
  const { deps, net, lines } = rig(JEV, undefined, () => { throw new Error(`ENOENT: no such file ${KEY_PATH}`); });
  for (const order of orders(50)) assert.deepEqual(await triageOrder(order, deps), { route: "wake", via: "none", reason: "triage-unavailable" });
  assert.equal(net.calls.length, 0);
  assert.equal(lines.length, 1, "recorded once per process, not once per order");
  assert.match(lines[0], /triage-unavailable/);
  assert.ok(!lines[0].includes(KEY_PATH), "the line does not carry the path the read error named");
});

test("CONTROL for the key-missing test: a readable key does reach the API, and 50 orders read the key once", async () => {
  const { deps, net, lines, reads } = rig(JEV, { body: digestible() });
  for (const order of orders(50)) assert.equal((await triageOrder(order, deps)).route, "digest");
  assert.equal(net.calls.length, 50);
  assert.deepEqual(reads, [KEY_PATH], "the key is read once per process");
  assert.deepEqual(lines, []);
});

test("Jev enabled: an informational order digests at 0.95, the same at 0.89 under a 0.9 floor wakes, the floor is inclusive and a no-cause order wakes with zero calls", async () => {
  const digest = rig(JEV, { body: digestible(0.95) });
  const routed = await triageOrder(ORDER, digest.deps);
  assert.deepEqual([routed.route, routed.via, routed.confidence], ["digest", "jev", 0.95]);
  assert.match(routed.reason, /asks nothing of this seat/);
  assert.equal(routed.answers?.["asks-this-seat"], "no", "the line that says why it was held carries the answers");
  const wakes = rig(JEV, { body: answered({ "asks-this-seat": "yes" }) });
  assert.equal((await triageOrder(ORDER, wakes.deps)).route, "wake");
  const low = rig(JEV, { body: digestible(0.89) });
  const lowResult = await triageOrder(ORDER, low.deps);
  assert.deepEqual([lowResult.route, lowResult.via, lowResult.confidence], ["wake", "jev", 0.89]);
  assert.equal(low.net.calls.length, 1, "CONTROL: the same order did reach the API");
  for (const noCause of [{ ...ORDER, cause: undefined }, { ...ORDER, cause: "" }, { ...ORDER, cause: "(no cause)" }]) {
    const none = rig(JEV, { body: digestible(0.99) });
    assert.equal((await triageOrder(noCause, none.deps)).route, "wake");
    assert.equal(none.net.calls.length, 0);
  }
  const exactlyAtFloor = rig(JEV, { body: digestible(0.9) });
  assert.equal((await triageOrder(ORDER, exactlyAtFloor.deps)).route, "digest", "the floor is inclusive");
});

test("a hand-built host that omits minConfidence gets the declared 0.9 floor, not 1", async () => {
  const handBuilt = (reply: Reply) => ({ ...rig(JEV, reply).deps, host: { triage: { provider: "jev", keyPath: KEY_PATH } } });
  assert.equal((await triageOrder(ORDER, handBuilt({ body: digestible(0.95) }))).route, "digest");
  assert.equal((await triageOrder(ORDER, handBuilt({ body: digestible(0.89) }))).route, "wake", "CONTROL: under 0.9 it still wakes");
});

test("the request is five atomic yes/no questions over six structured fields, and the order's text is not among them", async () => {
  const { deps, net } = rig(JEV, { body: answered({}) });
  const withText = { ...ORDER, prompt: "SECRET-ORDER-TEXT written by an agent", cost: "$0.1000" };
  await triageOrder(withText, deps);
  const { url, init } = net.calls[0];
  const sent = JSON.parse(init.body);
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(sent.model, "jev-latest");
  assert.deepEqual(sent.state, ORDER, "exactly cause, causeKey, session, the age of the last delivery, mainRed and chairmanDirection");
  assert.deepEqual(Object.keys(sent.questions), ["asks-this-seat", "repeat", "names-red-main", "names-chairman-direction", "informational-only"]);
  for (const question of Object.values<any>(sent.questions)) {
    assert.equal(question.type, "choice");
    assert.deepEqual(Object.keys(question.criteria), ["yes", "no"]);
  }
  assert.equal(init.body.includes("SECRET-ORDER-TEXT"), false, "the whole request body, not only the state");
  assert.equal(init.body.includes("$0.1000"), false, "an order's cost is not a field of the state");
});

test("a field the caller does not know is absent from the state, and a delivery known not to exist is null", async () => {
  const { deps, net } = rig(JEV, { body: answered({}) });
  await triageOrder({ cause: "org-health", causeKey: "ceo/org-health/1", session: "ceo" }, deps);
  await triageOrder({ cause: "org-health", causeKey: "ceo/org-health/1", session: "ceo", lastDeliveredMinutesAgo: null, mainRed: false, chairmanDirection: false }, deps);
  assert.deepEqual(JSON.parse(net.calls[0].init.body).state, { cause: "org-health", causeKey: "ceo/org-health/1", session: "ceo" });
  assert.deepEqual(JSON.parse(net.calls[1].init.body).state.lastDeliveredMinutesAgo, null);
});

test("a failing API wakes: HTTP 500, a timeout, a thrown fetch, and bodies with no usable answers", async () => {
  const failures: [string, Reply][] = [
    ["HTTP 500", { status: 500, body: {} }],
    ["timeout", { hangs: true }],
    ["throws", { throws: true }],
    ["no answers", { body: {} }],
    ["no choice", { body: { answers: Object.fromEntries(NAMES.map((n) => [n, { confidence: 0.99 }])) } }],
    ["unknown label", { body: { answers: Object.fromEntries(NAMES.map((n) => [n, { choice: "maybe", confidence: 0.99 }])) } }],
    ["no confidence", { body: { answers: Object.fromEntries(NAMES.map((n) => [n, { choice: "yes" }])) } }],
    ["null body", { body: null }],
  ];
  for (const [name, reply] of failures) {
    const { deps, net } = rig(JEV, reply);
    const result = await triageOrder(ORDER, deps);
    assert.deepEqual([result.route, result.via], ["wake", "none"], name);
    assert.equal(net.calls.length, 1, `${name}: CONTROL, the call was made`);
  }
});

test("haiku, an unknown provider and a minConfidence of 1.5 are REFUSED, each naming the key", () => {
  assert.throws(() => withTriage({ provider: "haiku" }), /`triage\.provider` `haiku` is not built; the Haiku triage is row B's/);
  assert.throws(() => withTriage({ provider: "gpt" }), /`triage\.provider` it must be one of jev, none/);
  assert.throws(() => withTriage({ ...JEV, minConfidence: 1.5 }), /`triage\.minConfidence`/);
  assert.throws(() => withTriage({ ...JEV, minConfidence: -0.1 }), /`triage\.minConfidence`/);
  assert.throws(() => withTriage({ ...JEV, minConfidence: "0.9" }), /`triage\.minConfidence`/);
  assert.throws(() => withTriage({ ...JEV, keyPath: "key" }), /`triage\.keyPath` it must be an absolute path/);
  assert.throws(() => withTriage({ provider: "jev" }), /`triage\.keyPath`/);
  assert.throws(() => withTriage("jev"), /`triage` it must be an object/);
  assert.deepEqual(withTriage(JEV).triage, JEV, "CONTROL: the same declaration without the fault is accepted");
  assert.deepEqual(withTriage({ provider: "jev", keyPath: KEY_PATH }).triage, JEV, "minConfidence defaults to the bar #4187 declared, 0.9");
  assert.ok(Object.isFrozen(withTriage(JEV).triage));
});

test("the fake key's text appears in nothing the run printed or returned", async () => {
  const everything: unknown[] = [];
  for (const [triage, reply] of [[JEV, { body: digestible() }], [JEV, { status: 500 }], [JEV, { throws: true }]] as [unknown, Reply][]) {
    const { deps, lines } = rig(triage, reply);
    for (const order of orders(3)) everything.push(await triageOrder(order, deps));
    everything.push(lines, deps.host);
  }
  const unreadable = rig(JEV, undefined, () => { throw new Error(`cannot read ${FAKE_KEY}`); });
  everything.push(await triageOrder(ORDER, unreadable.deps), unreadable.lines);
  assert.equal(JSON.stringify(everything).includes(FAKE_KEY), false);
  // CONTROL: the search can find it. The one place the key legitimately goes is the request header, and the rig's fetch records it.
  const sent = rig(JEV, { body: digestible() });
  await triageOrder(ORDER, sent.deps);
  assert.ok(JSON.stringify(sent.net.calls).includes(FAKE_KEY));
});

// --- the composition, in code (#4631) ---------------------------------------------------------------------------------------------------------------------------------------
const ask = (say: Partial<Record<QuestionName, string>>, age: number | null | undefined = undefined) => compose({ ...QUIET, ...say }, age);

test("compose: a red main or a chairman direction always wakes, and the same answers without it digest (the negative control)", () => {
  const informational = { "asks-this-seat": "no" } as const;
  assert.equal(ask(informational).route, "digest", "CONTROL: it asks nothing of this seat, nothing red, digests");
  assert.equal(ask({ ...informational, "names-red-main": "yes" }).route, "wake");
  assert.equal(ask({ ...informational, "names-chairman-direction": "yes" }).route, "wake");
  assert.equal(ask({ repeat: "yes", "names-red-main": "yes" }, 5).route, "wake", "a repeat that names a red main still wakes");
  assert.equal(ask({ repeat: "yes", "names-chairman-direction": "yes" }, 5).route, "wake");
});

test("compose: a repeat inside the hour digests, at the hour it wakes, and an answer the facts contradict does not hold an order", () => {
  assert.equal(ask({ repeat: "yes" }, REPEAT_WINDOW_MINUTES - 1).route, "digest");
  assert.equal(ask({ repeat: "yes" }, REPEAT_WINDOW_MINUTES).route, "wake", "the hour itself is not inside it");
  assert.equal(ask({ repeat: "yes" }, null).route, "wake", "no delivery is known");
  assert.equal(ask({ repeat: "yes" }, undefined).route, "wake", "nothing is known about deliveries");
  assert.equal(ask({ repeat: "no" }, 5).route, "wake", "CONTROL: the provider said it is not a repeat");
});

test("compose: ONE answer that it asks nothing of this seat digests, informational only digests unless it also asks something of this seat, and nothing else digests", () => {
  assert.equal(ask({ "asks-this-seat": "no" }).route, "digest", "one confident answer is enough: informational-only stayed `no`");
  assert.equal(ask({ "informational-only": "yes", "asks-this-seat": "no" }).route, "digest");
  assert.equal(ask({ "informational-only": "yes", "asks-this-seat": "yes" }).route, "wake", "contradictory answers are a wake");
  assert.equal(ask({ "asks-this-seat": "yes" }).route, "wake");
  assert.equal(ask({}).route, "wake", "five quiet answers are not a reason to hold anything");
  for (const route of ["wake", "digest"]) assert.notEqual(route, "drop");
});

test("the fallback of every question wakes, so no question left unanswered can hold an order", () => {
  const fallbacks = Object.fromEntries(NAMES.map((name) => [name, QUESTIONS[name].fallback])) as Record<QuestionName, string>;
  assert.equal(compose(fallbacks, 5).route, "wake");
  assert.deepEqual(fallbacks, { "asks-this-seat": "yes", repeat: "no", "names-red-main": "yes", "names-chairman-direction": "yes", "informational-only": "no" });
});

test("a red main or a chairman direction in the state wakes BEFORE anything is asked; the same order with neither is asked", async () => {
  for (const flagged of [{ mainRed: true }, { chairmanDirection: true }]) {
    const { deps, net } = rig(JEV, { body: digestible(0.99) });
    const result = await triageOrder({ ...ORDER, ...flagged }, deps);
    assert.deepEqual([result.route, result.via, net.calls.length], ["wake", "none", 0]);
  }
  const control = rig(JEV, { body: digestible(0.99) });
  assert.equal((await triageOrder(ORDER, control.deps)).route, "digest");
  assert.equal(control.net.calls.length, 1);
});

test("the provider naming a red main or a chairman direction wakes an order whose state says neither", async () => {
  for (const say of [{ "names-red-main": "yes" }, { "names-chairman-direction": "yes" }] as const) {
    const { deps } = rig(JEV, { body: answered({ ...say, "asks-this-seat": "no" }) });
    assert.equal((await triageOrder(ORDER, deps)).route, "wake");
  }
});

test("a repeat the provider reports digests only when the state holds a delivery inside the hour", async () => {
  const repeat = { body: answered({ repeat: "yes" }) };
  assert.equal((await triageOrder({ ...ORDER, lastDeliveredMinutesAgo: 30 }, rig(JEV, repeat).deps)).route, "digest");
  assert.equal((await triageOrder({ ...ORDER, lastDeliveredMinutesAgo: 61 }, rig(JEV, repeat).deps)).route, "wake");
  assert.equal((await triageOrder({ ...ORDER, lastDeliveredMinutesAgo: null }, rig(JEV, repeat).deps)).route, "wake");
});

test("one answer under its floor takes its own fallback and nothing else changes: a low asks-this-seat, red-main, chairman-direction, informational or repeat answer wakes", async () => {
  const lowered = (low: QuestionName, floor: number, say: Partial<Record<QuestionName, string>>) => {
    const body = answered(say, 0.95);
    (body.answers[low] as { confidence: number }).confidence = floor - 0.01;
    return { body };
  };
  const digestAnswers = { "asks-this-seat": "no" } as const;
  const wakes = async (reply: { body: unknown }) => (await triageOrder(ORDER, rig(JEV, reply).deps)).route;
  // the host's own floor (0.9 here) governs the answer that holds an order alone; the two wake guards have their own, lower floor
  assert.equal(await wakes(lowered("asks-this-seat", JEV.minConfidence, digestAnswers)), "wake");
  assert.equal(await wakes(lowered("names-red-main", WAKE_GUARD_FLOOR, digestAnswers)), "wake");
  assert.equal(await wakes(lowered("names-chairman-direction", WAKE_GUARD_FLOOR, digestAnswers)), "wake");
  assert.equal(await wakes(lowered("informational-only", JEV.minConfidence, { "informational-only": "yes" })), "wake");
  assert.equal(await wakes(lowered("repeat", REPEAT_FLOOR, { repeat: "yes" })), "wake");
  assert.equal(await wakes(lowered("repeat", REPEAT_FLOOR, digestAnswers)), "digest", "CONTROL: a low answer that cannot hold the order changes nothing");
});

test("THE RECORDED SHAPE (a11ign#4627 item 2): asks-this-seat=no at 0.9 and the other four under 0.7 digests, where a flat 0.7 woke it, and the line keeps what was said", async () => {
  const HOST_07 = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.7 };
  const reply = mixed({
    "asks-this-seat": ["no", 0.9], repeat: ["no", 0.4], "names-red-main": ["no", 0.5], "names-chairman-direction": ["no", 0.4], "informational-only": ["no", 0.3],
  });
  const { deps } = rig(HOST_07, { body: reply });
  const t = await triageOrder(ORDER, deps);
  assert.deepEqual([t.route, t.via, t.confidence], ["digest", "jev", 0.3]);
  assert.deepEqual(t.answers, { "asks-this-seat": "no", repeat: "no", "names-red-main": "no", "names-chairman-direction": "no", "informational-only": "no" });
  assert.deepEqual(t.said, {
    "asks-this-seat": { value: "no", confidence: 0.9 }, repeat: { value: "no", confidence: 0.4 }, "names-red-main": { value: "no", confidence: 0.5 },
    "names-chairman-direction": { value: "no", confidence: 0.4 }, "informational-only": { value: "no", confidence: 0.3 },
  });
  // NEGATIVE CONTROL: the same five answers under the flat 0.7 the questions used to share. The two wake guards fall back to `yes`, which wakes.
  const flat = Object.fromEntries(NAMES.map((name) => { const { minConfidence: _own, ...question } = QUESTIONS[name]; return [name, question]; }));
  const decision = await decide("wake-triage", {}, flat, { ...deps, switches: { "wake-triage": true } });
  const used = Object.fromEntries(NAMES.map((name) => [name, String(decision.answers[name].value)])) as Record<QuestionName, string>;
  assert.equal(used["names-red-main"], "yes");
  assert.equal(compose(used, 30).route, "wake");
});

test("a red main named at 0.3 wakes, whatever else is confident, and a `no` under the wake guard's floor wakes too; the line keeps the value the floor replaced", async () => {
  const HOST_07 = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.7 };
  const sure = { "asks-this-seat": ["no", 0.95], repeat: ["yes", 0.95] } as const;
  const named = await triageOrder(ORDER, rig(HOST_07, { body: mixed({ ...sure, "names-red-main": ["yes", 0.3] }) }).deps);
  assert.deepEqual([named.route, named.answers?.["names-red-main"], named.said?.["names-red-main"]], ["wake", "yes", { value: "yes", confidence: 0.3 }]);
  assert.equal((await triageOrder(ORDER, rig(HOST_07, { body: mixed({ ...sure, "names-chairman-direction": ["yes", 0.3] }) }).deps)).route, "wake");
  const unsure = await triageOrder(ORDER, rig(HOST_07, { body: mixed({ ...sure, "names-red-main": ["no", WAKE_GUARD_FLOOR - 0.1] }) }).deps);
  assert.deepEqual([unsure.route, unsure.answers?.["names-red-main"], unsure.said?.["names-red-main"]], ["wake", "yes", { value: "no", confidence: WAKE_GUARD_FLOOR - 0.1 }]);
  assert.equal((await triageOrder(ORDER, rig(HOST_07, { body: mixed(sure) }).deps)).route, "digest", "CONTROL: the same confident answers with the guards answered `no` digest");
});

test("a repeat the provider is 0.6 sure of digests when the state holds the delivery, and an unanswered question has a `said` with neither value nor confidence", async () => {
  const HOST_07 = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.7 };
  const reply = mixed({ repeat: ["yes", 0.6] });
  assert.equal((await triageOrder({ ...ORDER, lastDeliveredMinutesAgo: 30 }, rig(HOST_07, { body: reply }).deps)).route, "digest");
  assert.equal((await triageOrder({ ...ORDER, lastDeliveredMinutesAgo: 61 }, rig(HOST_07, { body: reply }).deps)).route, "wake");
  const body = mixed({ "asks-this-seat": ["no", 0.95] });
  (body.answers as Record<string, unknown>)["informational-only"] = { type: "choice", choice: "perhaps", confidence: 0.9 };
  const t = await triageOrder(ORDER, rig(HOST_07, { body }).deps);
  assert.deepEqual([t.route, t.said?.["informational-only"], t.answers?.["informational-only"]], ["digest", {}, "no"]);
});

test("one malformed answer among five is that question's fallback and not a failed read: the others still count", async () => {
  const body = answered({ "asks-this-seat": "no" }, 0.99);
  (body.answers["names-red-main"] as { choice: string }).choice = "maybe";
  const result = await triageOrder(ORDER, rig(JEV, { body }).deps);
  assert.deepEqual([result.route, result.via], ["wake", "jev"], "the red-main question fell back to yes, which wakes");
  const otherwise = answered({ "asks-this-seat": "no" }, 0.99);
  (otherwise.answers["repeat"] as { choice: string }).choice = "maybe";
  assert.equal((await triageOrder(ORDER, rig(JEV, { body: otherwise }).deps)).route, "digest", "CONTROL: a malformed repeat falls back to no, which cannot hold an order, and the rest digest it");
});

test("the use switched off: a host with a provider and a key asks nobody and wakes", async () => {
  const { deps, net, lines } = rig(JEV, { body: digestible(0.99) });
  const off = await triageOrder(ORDER, { ...deps, switches: { "wake-triage": false } });
  assert.deepEqual([off.route, off.via, off.reason, net.calls.length, lines], ["wake", "none", "the use is switched off", 0, []]);
  assert.equal((await triageOrder(ORDER, deps)).route, "digest", "CONTROL: the same host with no switch is on, because its declaration is the opt-in");
});
