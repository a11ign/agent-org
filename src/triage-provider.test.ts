// #4384: the triage seam. A fake `fetch`, a fake `readKey` and a fake diagnostic only: no network, no real key, no file read.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostConfig } from "./host-config.mjs";
import { freshState, triageOrder } from "./triage-provider.ts";

const FAKE_KEY = "tsk-FAKE-0123456789-do-not-print";
const KEY_PATH = "/fake/typesafe/key";
const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.9 };
const ORDER = { cause: "answer-owed", causeKey: "product-manager/answer-owed/row-1", session: "product-manager", cost: "$0.1000" };

type Reply = { status?: number; body?: unknown; throws?: boolean; hangs?: boolean };
const answer = (choice: string, confidence: number) => ({ answers: { q: { type: "choice", choice, probabilities: {}, confidence } } });

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
function rig(triage: unknown, reply: Reply | (() => Reply) = { body: answer("wake", 1) }, readKey?: (path: string) => string) {
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
  const { deps, net, lines, reads } = rig(JEV, { body: answer("drop", 0.95) });
  for (const order of orders(50)) assert.equal((await triageOrder(order, deps)).route, "drop");
  assert.equal(net.calls.length, 50);
  assert.deepEqual(reads, [KEY_PATH], "the key is read once per process");
  assert.deepEqual(lines, []);
});

test("Jev enabled: drop and digest at 0.95 route; drop at 0.89 under a 0.9 floor wakes; a no-cause order wakes with zero calls", async () => {
  const drop = rig(JEV, { body: answer("drop", 0.95) });
  assert.deepEqual(await triageOrder(ORDER, drop.deps), { route: "drop", via: "jev", confidence: 0.95, reason: "jev answered drop" });
  const digest = rig(JEV, { body: answer("digest", 0.95) });
  assert.equal((await triageOrder(ORDER, digest.deps)).route, "digest");
  const low = rig(JEV, { body: answer("drop", 0.89) });
  const lowResult = await triageOrder(ORDER, low.deps);
  assert.deepEqual([lowResult.route, lowResult.via, lowResult.confidence], ["wake", "jev", 0.89]);
  assert.equal(low.net.calls.length, 1, "CONTROL: the same order did reach the API");
  for (const noCause of [{ ...ORDER, cause: undefined }, { ...ORDER, cause: "" }, { ...ORDER, cause: "(no cause)" }]) {
    const none = rig(JEV, { body: answer("drop", 0.99) });
    assert.equal((await triageOrder(noCause, none.deps)).route, "wake");
    assert.equal(none.net.calls.length, 0);
  }
  const exactlyAtFloor = rig(JEV, { body: answer("drop", 0.9) });
  assert.equal((await triageOrder(ORDER, exactlyAtFloor.deps)).route, "drop", "the floor is inclusive");
});

test("the request is the one-question choice the row describes", async () => {
  const { deps, net } = rig(JEV, { body: answer("wake", 1) });
  await triageOrder(ORDER, deps);
  const { url, init } = net.calls[0];
  const sent = JSON.parse(init.body);
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(sent.model, "jev-latest");
  assert.deepEqual(sent.state, ORDER);
  assert.deepEqual(Object.keys(sent.questions), ["q"]);
  assert.equal(sent.questions.q.type, "choice");
  assert.deepEqual(Object.keys(sent.questions.q.criteria), ["wake", "digest", "drop"]);
});

test("a failing API wakes: HTTP 500, a timeout, a thrown fetch, and bodies with no answers.q.choice", async () => {
  const failures: [string, Reply][] = [
    ["HTTP 500", { status: 500, body: {} }],
    ["timeout", { hangs: true }],
    ["throws", { throws: true }],
    ["no answers", { body: {} }],
    ["no choice", { body: { answers: { q: { confidence: 0.99 } } } }],
    ["unknown label", { body: answer("escalate", 0.99) }],
    ["no confidence", { body: { answers: { q: { choice: "drop" } } } }],
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
  for (const [triage, reply] of [[JEV, { body: answer("drop", 0.95) }], [JEV, { status: 500 }], [JEV, { throws: true }]] as [unknown, Reply][]) {
    const { deps, lines } = rig(triage, reply);
    for (const order of orders(3)) everything.push(await triageOrder(order, deps));
    everything.push(lines, deps.host);
  }
  const unreadable = rig(JEV, undefined, () => { throw new Error(`cannot read ${FAKE_KEY}`); });
  everything.push(await triageOrder(ORDER, unreadable.deps), unreadable.lines);
  assert.equal(JSON.stringify(everything).includes(FAKE_KEY), false);
  // CONTROL: the search can find it. The one place the key legitimately goes is the request header, and the rig's fetch records it.
  const sent = rig(JEV, { body: answer("drop", 0.95) });
  await triageOrder(ORDER, sent.deps);
  assert.ok(JSON.stringify(sent.net.calls).includes(FAKE_KEY));
});
