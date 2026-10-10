// #4384: the triage seam. A fake `fetch`, a fake `readKey` and a fake diagnostic only: no network, no real key, no file read.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostConfig } from "./host-config.ts";
import { compose, DIGEST_MAX_P_ASKS, DIGEST_MAX_P_GUARD, DIGEST_MIN_P_INFORMATIONAL, DIGEST_MIN_P_REPEAT, freshState, QUESTIONS, REPEAT_WINDOW_MINUTES, triageOrder, type QuestionName, type Readings } from "./triage-provider.ts";

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
/** One answer as the API sends it: P(yes) is the confidence of a `yes` and its complement for a `no`. */
const reply1 = (choice: string, confidence: number) => ({ type: "choice", choice, confidence, probabilities: { yes: choice === "yes" ? confidence : 1 - confidence, no: choice === "yes" ? 1 - confidence : confidence } });
/** All five answered at one confidence, `say` overriding the quiet answers. */
const answered = (say: Partial<Record<QuestionName, string>>, confidence = 0.95) => ({
  answers: Object.fromEntries(NAMES.map((name) => [name, reply1({ ...QUIET, ...say }[name], confidence)])),
});
/** Held for the digest: informational only, asking nothing of this seat. */
const digestible = (confidence = 0.95) => answered({ "asks-this-seat": "no", "informational-only": "yes" }, confidence);
/** Each question answered at its OWN confidence, `[choice, confidence]`, the rest quiet at 0.95: what a provider that is sure of one thing and not of the others sends. */
const mixed = (say: Partial<Record<QuestionName, readonly [string, number]>>, base: Partial<Record<QuestionName, string>> = {}) => ({
  answers: Object.fromEntries(NAMES.map((name) => {
    const [choice, confidence] = say[name] ?? [{ ...QUIET, ...base }[name], 0.95];
    return [name, reply1(choice, confidence)];
  })),
});
/** The probabilities `compose` reads: P(yes) per question, `say` overriding a quiet reading (asks the seat, nothing else). */
const QUIET_P: Readings = { "asks-this-seat": 0.95, repeat: 0.05, "names-red-main": 0.05, "names-chairman-direction": 0.05, "informational-only": 0.05 };

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

test("Jev enabled: an informational order digests at p = 0.95 and at p = 0.75, where the old 0.9 floor woke it; the threshold is inclusive; a no-cause order wakes with zero calls", async () => {
  const digest = rig(JEV, { body: digestible(0.95) });
  const routed = await triageOrder(ORDER, digest.deps);
  assert.deepEqual([routed.route, routed.via, routed.confidence], ["digest", "jev", 0.95]);
  assert.match(routed.reason, /informational only/);
  assert.equal(routed.answers?.["informational-only"], "yes", "the line that says why it was held carries the answers");
  assert.deepEqual(routed.probabilities?.["informational-only"], 0.95, "and the probabilities it was composed on");
  const wakes = rig(JEV, { body: answered({ "asks-this-seat": "yes" }) });
  assert.equal((await triageOrder(ORDER, wakes.deps)).route, "wake");
  const middling = rig(JEV, { body: mixed({ "informational-only": ["yes", 0.75], "asks-this-seat": ["no", 0.75] }) });
  const middlingResult = await triageOrder(ORDER, middling.deps);
  assert.deepEqual([middlingResult.route, middlingResult.via, middlingResult.confidence], ["digest", "jev", 0.75]);
  assert.equal(middling.net.calls.length, 1, "CONTROL: the same order did reach the API");
  const unsure = rig(JEV, { body: mixed({ "informational-only": ["yes", 0.6] }, { "asks-this-seat": "no" }) });
  assert.equal((await triageOrder(ORDER, unsure.deps)).route, "wake", "p(informational) 0.6 is under 0.65");
  for (const noCause of [{ ...ORDER, cause: undefined }, { ...ORDER, cause: "" }, { ...ORDER, cause: "(no cause)" }]) {
    const none = rig(JEV, { body: digestible(0.99) });
    assert.equal((await triageOrder(noCause, none.deps)).route, "wake");
    assert.equal(none.net.calls.length, 0);
  }
  const exactlyAt = rig(JEV, { body: mixed({ "informational-only": ["yes", DIGEST_MIN_P_INFORMATIONAL] }, { "asks-this-seat": "no" }) });
  assert.equal((await triageOrder(ORDER, exactlyAt.deps)).route, "digest", "the informational threshold is inclusive");
});

test("a hand-built host that omits minConfidence is still routed", async () => {
  const handBuilt = (reply: Reply) => ({ ...rig(JEV, reply).deps, host: { triage: { provider: "jev", keyPath: KEY_PATH } } });
  assert.equal((await triageOrder(ORDER, handBuilt({ body: digestible(0.95) }))).route, "digest");
  assert.equal((await triageOrder(ORDER, handBuilt({ body: mixed({ "informational-only": ["yes", 0.7] }, { "asks-this-seat": "no" }) }))).route, "digest", "the host's floor no longer decides the route: the probabilities do");
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

// --- the composition, on probabilities (#4889) ------------------------------------------------------------------------------------------------------------------------------
const ask = (say: Partial<Record<QuestionName, number | null>>, age: number | null | undefined = undefined) => compose({ ...QUIET_P, ...say }, age);
/** Informational and asking nothing of this seat, as the provider would read a digestible order. */
const INFORMATIONAL = { "informational-only": 0.75, "asks-this-seat": 0.1 } as const;

test("compose: an informational order at p = 0.75 digests, and the same readings with a guard at its threshold wake (the negative control)", () => {
  assert.equal(ask(INFORMATIONAL).route, "digest", "CONTROL: informational only, nothing red, digests");
  assert.equal(ask({ ...INFORMATIONAL, "names-red-main": DIGEST_MAX_P_GUARD }).route, "wake", "the guard's threshold is exclusive");
  assert.equal(ask({ ...INFORMATIONAL, "names-red-main": DIGEST_MAX_P_GUARD - 0.01 }).route, "digest");
  assert.equal(ask({ ...INFORMATIONAL, "names-chairman-direction": DIGEST_MAX_P_GUARD }).route, "wake");
  assert.equal(ask({ ...INFORMATIONAL, "names-chairman-direction": DIGEST_MAX_P_GUARD - 0.01 }).route, "digest");
});

test("compose: a red main wakes at any p, whatever else is confident", () => {
  for (const p of [0.2, 0.5, 0.9, 1]) {
    assert.equal(ask({ ...INFORMATIONAL, "names-red-main": p }).route, "wake", `informational at 0.75 with P(red main) ${p}`);
    assert.equal(ask({ ...INFORMATIONAL, "informational-only": 1, "names-red-main": p }).route, "wake", `informational at 1 with P(red main) ${p}`);
    assert.equal(ask({ repeat: 1, "names-red-main": p }, 5).route, "wake", `a repeat with P(red main) ${p}`);
  }
});

test("compose: an order that asks the seat something at p = 0.6 wakes, and one that asks at p under the threshold digests", () => {
  assert.equal(ask({ ...INFORMATIONAL, "asks-this-seat": 0.6 }).route, "wake");
  assert.equal(ask({ ...INFORMATIONAL, "asks-this-seat": DIGEST_MAX_P_ASKS }).route, "wake", "the asks threshold is exclusive");
  assert.equal(ask({ ...INFORMATIONAL, "asks-this-seat": DIGEST_MAX_P_ASKS - 0.01 }).route, "digest");
});

test("compose: one irrelevant low-confidence answer does not force a wake: `repeat` at any p, with the deciding four clear, still digests", () => {
  for (const p of [0, 0.5, 0.5001, 1]) assert.equal(ask({ ...INFORMATIONAL, repeat: p }).route, "digest", `P(repeat) ${p} is not a veto`);
  assert.equal(ask({ ...INFORMATIONAL, repeat: 0.5 }, null).route, "digest");
});

test("compose: nothing informational wakes, and a probability that was not given is never read as a `no`", () => {
  assert.equal(ask({ "informational-only": 0.64, "asks-this-seat": 0.1 }).route, "wake");
  assert.equal(ask({}).route, "wake", "quiet readings are not a reason to hold anything");
  for (const name of ["informational-only", "asks-this-seat", "names-red-main", "names-chairman-direction"] as const) {
    assert.equal(ask({ ...INFORMATIONAL, [name]: null }).route, "wake", `${name} not given`);
  }
  assert.equal(ask({ ...INFORMATIONAL, repeat: null }).route, "digest", "CONTROL: `repeat` not given cannot hold, and does not veto");
  for (const route of ["wake", "digest"]) assert.notEqual(route, "drop");
});

test("compose: a repeat inside the hour digests at p >= 0.5, at the hour it wakes, and a repeat the facts contradict does not hold an order", () => {
  assert.equal(ask({ repeat: 0.9 }, REPEAT_WINDOW_MINUTES - 1).route, "digest");
  assert.equal(ask({ repeat: DIGEST_MIN_P_REPEAT }, 5).route, "digest");
  assert.equal(ask({ repeat: DIGEST_MIN_P_REPEAT - 0.01 }, 5).route, "wake", "under the repeat threshold");
  assert.equal(ask({ repeat: 0.9 }, REPEAT_WINDOW_MINUTES).route, "wake", "the hour itself is not inside it");
  assert.equal(ask({ repeat: 0.9 }, null).route, "wake", "no delivery is known");
  assert.equal(ask({ repeat: 0.9 }, undefined).route, "wake", "nothing is known about deliveries");
  assert.equal(ask({ repeat: 0.9, "names-chairman-direction": 0.5 }, 5).route, "wake", "a repeat that names a chairman direction still wakes");
});

test("the fallback of every question wakes, so no question left unanswered can hold an order", () => {
  const fallbacks = Object.fromEntries(NAMES.map((name) => [name, QUESTIONS[name].fallback]));
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

test("the provider naming a red main or a chairman direction wakes an order whose state says neither, at any confidence", async () => {
  for (const name of ["names-red-main", "names-chairman-direction"] as const) {
    for (const confidence of [0.3, 0.6, 0.95]) {
      const { deps } = rig(JEV, { body: mixed({ [name]: ["yes", confidence] }, { "asks-this-seat": "no", "informational-only": "yes" }) });
      assert.equal((await triageOrder(ORDER, deps)).route, "wake", `${name} at ${confidence}`);
    }
  }
});

test("THE RECORDED SHAPE (#4889): the answers a flat 0.7 woke digest on their probabilities, and the line keeps the probabilities and what was said", async () => {
  const HOST_07 = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.7 };
  // the sort of reading the last records held: all five could not clear a flat 0.7 floor (p >= 0.85), and the four that decide are enough
  const reply = mixed({
    "informational-only": ["yes", 0.75], "asks-this-seat": ["no", 0.8], "names-red-main": ["no", 0.85], "names-chairman-direction": ["no", 0.83], repeat: ["no", 0.5],
  });
  const t = await triageOrder(ORDER, rig(HOST_07, { body: reply }).deps);
  assert.deepEqual([t.route, t.via, t.confidence], ["digest", "jev", 0.5]);
  assert.equal(t.probabilities?.["informational-only"], 0.75);
  assert.ok((t.probabilities?.["names-red-main"] ?? 1) < DIGEST_MAX_P_GUARD);
  assert.equal(t.said?.["informational-only"]?.confidence, 0.75);
  // MIX: the same answers at 0.8 for a red main as `yes` wake, as p = 0.8 > 0.2
  const red = mixed({ "informational-only": ["yes", 0.75], "asks-this-seat": ["no", 0.8], "names-red-main": ["yes", 0.8] });
  assert.equal((await triageOrder(ORDER, rig(HOST_07, { body: red }).deps)).route, "wake");
});

test("a malformed answer among five is `not given` and wakes when it is one of the four that decide", async () => {
  const malformed = (name: QuestionName, answer: unknown) => {
    const body = digestible(0.9);
    (body.answers as Record<string, unknown>)[name] = answer;
    return { body };
  };
  const wakes = async (name: QuestionName, answer: unknown) => (await triageOrder(ORDER, rig(JEV, malformed(name, answer)).deps)).route;
  for (const name of ["informational-only", "asks-this-seat", "names-red-main", "names-chairman-direction"] as const) {
    assert.equal(await wakes(name, { type: "choice", choice: "maybe", confidence: 0.99 }), "wake", `${name} malformed`);
  }
  // a well-formed answer with no distribution is read from its choice and confidence: `no` at 0.99 is P(yes) 0.005
  assert.equal(await wakes("names-red-main", { type: "choice", choice: "no", confidence: 0.99, probabilities: {} }), "digest", "CONTROL: no distribution, a confident `no`");
  assert.equal(await wakes("names-red-main", { type: "choice", choice: "yes", confidence: 0.2, probabilities: {} }), "wake", "no distribution, a `yes` at 0.2 is P(yes) 0.6");
  assert.equal(await wakes("repeat", { type: "choice", choice: "maybe", confidence: 0.99 }), "digest", "CONTROL: a malformed `repeat` is not a veto");
});

test("the use switched off: a host with a provider and a key asks nobody and wakes", async () => {
  const { deps, net, lines } = rig(JEV, { body: digestible(0.99) });
  const off = await triageOrder(ORDER, { ...deps, switches: { "wake-triage": false } });
  assert.deepEqual([off.route, off.via, off.reason, net.calls.length, lines], ["wake", "none", "the use is switched off", 0, []]);
  assert.equal((await triageOrder(ORDER, deps)).route, "digest", "CONTROL: the same host with no switch is on, because its declaration is the opt-in");
});
