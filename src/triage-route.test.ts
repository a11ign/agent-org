// #4385: routing manager wakes by the triage provider. A fake provider (or a fake `fetch` under the real one), a fake ledger and a private directory only: no network, no key.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseHostConfig } from "./host-config.ts";
import { DIGEST_FLUSH_MS, NEEDED_ACTION_PROXY, OUTCOME_WINDOW_MS, carriedKeys, digestDue, flushOrders, namesRedMain, readDigest, ridingDigest, routeOrders, routable, settleRidden, type GateOrder, type RouteDeps } from "./triage-route.ts";
import { freshState, QUESTIONS, type Triage } from "./triage-provider.ts";

const T0 = 1_000_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const hostWith = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: "/fake/key", minConfidence: 0.9 };
const order = (n: number, session = "product-manager"): GateOrder => ({ session, causeKey: `${session}/org-health/${n}`, cause: "org-health", prompt: `prompt ${n}` });
const made: string[] = [];
const digestFile = () => { const dir = mkdtempSync(join(tmpdir(), "triage-route-")); made.push(dir); return join(dir, "state", "triage-digest"); };
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A provider that answers `route` for everything and counts what it was asked. */
function fakeProvider(route: Triage["route"], confidence = 0.95) {
  const asked: string[] = [];
  const triage = (async (o: { causeKey?: string }) => { asked.push(String(o.causeKey)); return { route, via: "jev", confidence, reason: "fake" }; }) as unknown as RouteDeps["triage"];
  return { triage, asked };
}
const deps = (path: string, extra: Partial<RouteDeps> = {}): RouteDeps => ({ host: hostWith(JEV), digestPath: path, now: () => T0, ...extra });
const keys = (orders: readonly GateOrder[]) => orders.map((o) => o.causeKey);

test("a digest answer holds the order, and a drop answer does the same: nothing is undelivered or deleted", async () => {
  for (const route of ["digest", "drop"] as const) {
    const path = digestFile();
    const { triage } = fakeProvider(route);
    const out = await routeOrders([order(1), order(2)], deps(path, { triage }));
    assert.deepEqual(out.deliver, []);
    assert.deepEqual(readDigest(path).map((h) => [h.causeKey, h.prompt, h.triage.route]), [["product-manager/org-health/1", "prompt 1", route], ["product-manager/org-health/2", "prompt 2", route]]);
  }
});

const QUESTION_NAMES = ["asks-this-seat", "repeat", "names-red-main", "names-chairman-direction", "informational-only"];
/** The five answers, quiet unless `say` names one, all at `confidence`. */
const answersFor = (say: Record<string, string>, confidence: number) => ({
  answers: Object.fromEntries(QUESTION_NAMES.map((name) => [name, { type: "choice", choice: say[name] ?? "no", probabilities: {}, confidence }])),
});
/** The real provider over a fake `fetch`: every request body is kept, and `reply` decides the answer. */
function realProvider(reply: () => unknown) {
  const bodies: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return reply(); }) as unknown as typeof fetch;
  const lines: string[] = [];
  const triageDeps = { fetch: fetchFn, readKey: () => "k", state: freshState(), diagnostic: (line: string) => lines.push(line) };
  return { triageDeps, bodies, lines };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const INFORMATIONAL = { "informational-only": "yes" };
/** The order a red main produces (`trunk-red.ts`), here for the manager that was told of it first on 2026-10-10. */
const RED_MAIN_ORDER: GateOrder = { session: "product-manager", causeKey: "product-manager/trunk-red/pr-lab#61/019a00ad", cause: "trunk-red", prompt: "MAIN IS RED IN `lab`" };

test("the real provider's floor decides: 0.9 digests and 0.89 delivers, and a provider error delivers", async () => {
  const run = async (reply: () => unknown) => {
    const path = digestFile();
    const out = await routeOrders([order(1)], deps(path, { triage: undefined, triageDeps: realProvider(reply).triageDeps }));
    return { delivered: keys(out.deliver), held: readDigest(path).length };
  };
  assert.deepEqual(await run(() => ok(answersFor(INFORMATIONAL, 0.9))), { delivered: [], held: 1 });
  assert.deepEqual(await run(() => ok(answersFor(INFORMATIONAL, 0.89))), { delivered: ["product-manager/org-health/1"], held: 0 });
  assert.deepEqual(await run(() => { throw new Error("down"); }), { delivered: ["product-manager/org-health/1"], held: 0 });
  assert.deepEqual(await run(() => ({ ok: false, status: 503 })), { delivered: ["product-manager/org-health/1"], held: 0 });
});

test("the provider sees six structured facts per order and none of its text, and a fact the tick does not know is absent", async () => {
  const path = digestFile();
  const real = realProvider(() => ok(answersFor({}, 0.95)));
  const known = [order(1), { ...order(2), prompt: "SECRET agent-written body" }];
  const facts = { mainRed: false, deliveries: [{ at: T0 - 30 * MINUTE, key: known[0].causeKey, session: "product-manager" }] };
  await routeOrders(known, deps(path, { triage: undefined, triageDeps: real.triageDeps, facts }));
  const states = real.bodies.map((b) => b.state);
  assert.deepEqual(states, [
    { cause: "org-health", causeKey: "product-manager/org-health/1", session: "product-manager", lastDeliveredMinutesAgo: 30, mainRed: false, chairmanDirection: false },
    { cause: "org-health", causeKey: "product-manager/org-health/2", session: "product-manager", lastDeliveredMinutesAgo: null, mainRed: false, chairmanDirection: false },
  ]);
  assert.equal(JSON.stringify(real.bodies).includes("SECRET"), false);
  const blind = realProvider(() => ok(answersFor({}, 0.95)));
  await routeOrders([order(3)], deps(digestFile(), { triage: undefined, triageDeps: blind.triageDeps }));
  assert.deepEqual(blind.bodies[0].state, { cause: "org-health", causeKey: "product-manager/org-health/3", session: "product-manager", chairmanDirection: false });
});

test("only a delivery to the SAME seat of the SAME cause counts, and the newest one decides the age", async () => {
  const real = realProvider(() => ok(answersFor({}, 0.95)));
  const facts = { deliveries: [
    { at: T0 - 50 * MINUTE, key: order(1).causeKey, session: "product-manager" },
    { at: T0 - 10 * MINUTE, key: order(1).causeKey, session: "product-manager" },
    { at: T0 - 2 * MINUTE, key: order(1).causeKey, session: "ceo" },
    { at: T0 - 3 * MINUTE, key: order(2).causeKey, session: "product-manager" },
  ] };
  await routeOrders([order(1)], deps(digestFile(), { triage: undefined, triageDeps: real.triageDeps, facts }));
  assert.equal(real.bodies[0].state.lastDeliveredMinutesAgo, 10);
});

test("each case the row names, composed in code over a fake provider, with its negative control", async () => {
  const route = async (say: Record<string, string>, extra: Partial<RouteDeps> = {}, one: GateOrder = order(1)) => {
    const real = realProvider(() => ok(answersFor(say, 0.95)));
    const out = await routeOrders([one], deps(digestFile(), { triage: undefined, triageDeps: real.triageDeps, ...extra }));
    return { route: out.deliver.length === 1 ? "wake" : "digest", asked: real.bodies.length };
  };
  const repeatedAt = (minutesAgo: number) => ({ facts: { deliveries: [{ at: T0 - minutesAgo * MINUTE, key: order(1).causeKey, session: "product-manager" }] } });
  // the order that IS a red main's wakes, and asks nobody; another order of a tick that read a red main is asked as on a green one (#4878)
  assert.deepEqual(await route(INFORMATIONAL, { facts: { mainRed: true } }, RED_MAIN_ORDER), { route: "wake", asked: 0 });
  assert.deepEqual(await route(INFORMATIONAL, { facts: { mainRed: true } }), { route: "digest", asked: 1 }, "an order that does not name the red main is asked, red main or not");
  assert.deepEqual(await route(INFORMATIONAL, { facts: { mainRed: false } }), { route: "digest", asked: 1 }, "CONTROL: the same order with main green digests");
  // a chairman direction always wakes, and asks nobody
  assert.deepEqual(await route(INFORMATIONAL, {}, { ...order(1), startFresh: true }), { route: "wake", asked: 0 });
  // a repeat inside the hour digests; outside it, or with no delivery on record, it does not
  assert.deepEqual(await route({ repeat: "yes" }, repeatedAt(59)), { route: "digest", asked: 1 });
  assert.deepEqual(await route({ repeat: "yes" }, repeatedAt(60)), { route: "wake", asked: 1 });
  assert.deepEqual(await route({ repeat: "yes" }, { facts: { deliveries: [] } }), { route: "wake", asked: 1 });
  // informational only digests; one that asks something of this seat, and an ordinary order, wake
  assert.deepEqual(await route(INFORMATIONAL), { route: "digest", asked: 1 });
  assert.deepEqual(await route({ ...INFORMATIONAL, "asks-this-seat": "yes" }), { route: "wake", asked: 1 });
  assert.deepEqual(await route({ "asks-this-seat": "yes" }), { route: "wake", asked: 1 });
  // the provider's own reading of a red main or a chairman direction wins over the rest
  assert.deepEqual(await route({ ...INFORMATIONAL, "names-red-main": "yes" }), { route: "wake", asked: 1 });
  assert.deepEqual(await route({ ...INFORMATIONAL, "names-chairman-direction": "yes" }), { route: "wake", asked: 1 });
});

test("with the use switched off, the key unreadable or no provider declared, every order is delivered, asks nobody and holds nothing", async () => {
  const fixture = [order(1), order(2, "ceo"), order(3, "orchestrator")];
  const cases: [string, Partial<RouteDeps>][] = [];
  const real = realProvider(() => ok(answersFor(INFORMATIONAL, 0.99)));
  cases.push(["use switched off", { triage: undefined, triageDeps: { ...real.triageDeps, switches: { "wake-triage": false } } }]);
  const keyless = realProvider(() => ok(answersFor(INFORMATIONAL, 0.99)));
  cases.push(["key missing", { triage: undefined, triageDeps: { ...keyless.triageDeps, readKey: () => { throw new Error("ENOENT /fake/key"); } } }]);
  for (const [name, extra] of cases) {
    const path = digestFile();
    const out = await routeOrders(fixture, deps(path, extra));
    assert.deepEqual([name, keys(out.deliver), out.held.length], [name, keys(fixture), 0]);
  }
  assert.equal(real.bodies.length + keyless.bodies.length, 0, "neither case reached the network");
  const control = realProvider(() => ok(answersFor(INFORMATIONAL, 0.99)));
  const on = await routeOrders(fixture, deps(digestFile(), { triage: undefined, triageDeps: control.triageDeps }));
  assert.deepEqual([on.deliver.length, on.held.length, control.bodies.length], [0, 3, 3], "CONTROL: the same host with a readable key and the use on holds all three");
});

test("a red main in the tick wakes the order that names it and not the others: the 200 orders of 2026-10-10 are asked, and the red order is not (#4878)", async () => {
  const real = realProvider(() => ok(answersFor(INFORMATIONAL, 0.95)));
  const tick = [RED_MAIN_ORDER, order(1), order(2, "ceo"), order(3, "orchestrator")];
  const path = digestFile();
  const out = await routeOrders(tick, deps(path, { triage: undefined, triageDeps: real.triageDeps, facts: { mainRed: true } }));
  assert.deepEqual(keys(out.deliver), [RED_MAIN_ORDER.causeKey], "the red main's own order is delivered");
  assert.deepEqual(readDigest(path).map((h) => h.causeKey), [order(1).causeKey, order(2, "ceo").causeKey, order(3, "orchestrator").causeKey], "the other three are held, not woken");
  assert.equal(real.bodies.length, 3, "and the provider was asked about each of them: the red order is not sent");
  assert.deepEqual(real.bodies.map((b) => b.state.mainRed), [false, false, false]);
  // CONTROL: before this change `mainRed` reached every order, so the same tick asked nobody and woke all four.
  const named = await routeOrders([RED_MAIN_ORDER], deps(digestFile(), { triage: undefined, triageDeps: realProvider(() => ok(answersFor(INFORMATIONAL, 0.95))).triageDeps, facts: { mainRed: true } }));
  assert.deepEqual(keys(named.deliver), [RED_MAIN_ORDER.causeKey]);
});

test("all five questions at the floor and informational-only yes digests; ONE answer under the floor wakes, and the floor itself is unchanged (#4878)", async () => {
  const at = (floor: number, confidences: Record<string, number> = {}) => ({
    answers: Object.fromEntries(QUESTION_NAMES.map((name) => [name, { type: "choice", choice: INFORMATIONAL[name as "informational-only"] ?? "no", probabilities: {}, confidence: confidences[name] ?? floor }])),
  });
  const run = async (reply: unknown) => {
    const path = digestFile();
    const out = await routeOrders([order(1)], deps(path, { triage: undefined, triageDeps: realProvider(() => ok(reply)).triageDeps }));
    return { delivered: keys(out.deliver), held: readDigest(path).map((h) => h.causeKey) };
  };
  const FLOOR = JEV.minConfidence;
  assert.deepEqual(await run(at(FLOOR)), { delivered: [], held: [order(1).causeKey] }, "POSITIVE: every answer at the floor, informational yes, routes to digest");
  for (const name of QUESTION_NAMES) {
    // An answer under the floor takes its question's fallback. `repeat` falls back to the very "no" it was answered, so it is the one question whose floor cannot change this route.
    const fallsBackToWhatWasSaid = QUESTIONS[name as keyof typeof QUESTIONS].fallback === (INFORMATIONAL[name as "informational-only"] ?? "no");
    const expected = fallsBackToWhatWasSaid ? { delivered: [], held: [order(1).causeKey] } : { delivered: [order(1).causeKey], held: [] };
    assert.deepEqual(await run(at(FLOOR, { [name]: FLOOR - 0.01 })), expected, `${name} one hundredth under the floor ${fallsBackToWhatWasSaid ? "changes nothing: its fallback is the answer it gave" : "wakes"}`);
  }
  assert.deepEqual(QUESTION_NAMES.filter((name) => QUESTIONS[name as keyof typeof QUESTIONS].fallback === (INFORMATIONAL[name as "informational-only"] ?? "no")), ["repeat"], "CONTROL: only repeat is such a question");
});

test("an asked line carries what the provider SAID of each question and at what confidence, so a floor can be read question by question (#4878)", async () => {
  const path = digestFile();
  const reply = answersFor({ "asks-this-seat": "no", "informational-only": "yes" }, 0.95);
  (reply.answers["informational-only"] as { confidence: number }).confidence = 0.3;
  await routeOrders([order(1)], deps(path, { triage: undefined, triageDeps: realProvider(() => ok(reply)).triageDeps }));
  const { asked } = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]);
  assert.deepEqual(asked.readings["informational-only"], { said: "yes", confidence: 0.3 }, "the choice the floor held back is on the line");
  assert.equal(asked.answers["informational-only"], "no", "while the value used is the question's fallback");
  assert.deepEqual(Object.keys(asked.readings).sort(), [...QUESTION_NAMES].sort());
  assert.equal(asked.triage.confidence, 0.3, "and the line's one confidence is still the weakest");
});

test("a red main is read off the order a red main produces, by cause or by key", () => {
  assert.equal(namesRedMain({ causeKey: "engineers/trunk-red/pr-4/abcd1234" }), true);
  assert.equal(namesRedMain({ causeKey: "x/y/z", cause: "trunk-red" }), true);
  assert.equal(namesRedMain({ causeKey: "product-manager/org-health/1" }), false);
  assert.equal(namesRedMain({ causeKey: "product-manager/trunk-red-noted/1" }), false, "a cause that merely starts the same is not it");
});

test("a digested order that comes back inside a day leaves ONE needed-action line that says it is a proxy", async () => {
  const path = digestFile();
  await routeOrders([order(1)], deps(path, { triage: fakeProvider("digest").triage }));
  settleRidden("product-manager/answer-owed/9", [order(1).causeKey], { digestPath: path, ledgerAppend: () => {}, now: () => T0 + 10 * MINUTE });
  const again = (afterMs: number) => routeOrders([order(1)], deps(path, { triage: fakeProvider("wake").triage, now: () => T0 + afterMs }));
  const outcomes = () => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => "outcome" in l).map((l) => l.outcome);
  assert.deepEqual(outcomes(), [], "CONTROL: a delivered order nobody offered again has no outcome");
  await again(3 * HOUR);
  assert.deepEqual(outcomes(), [{ at: T0 + 3 * HOUR, causeKey: order(1).causeKey, session: "product-manager", deliveredAt: T0 + 10 * MINUTE, "needed-action": true, proxy: NEEDED_ACTION_PROXY }]);
  assert.match(NEEDED_ACTION_PROXY, /PROXY/);
  await again(4 * HOUR);
  assert.equal(outcomes().length, 1, "offered a third time, still one line for that delivery");
  assert.deepEqual(readDigest(path), [], "an outcome line is not a held order");
});

test("no outcome line for what did not need one: not delivered yet, delivered outright, another seat, or more than a day later", async () => {
  const outcomesOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.includes('"outcome"')).length : 0);
  // held and never delivered: the gate emits it every tick, and that is not an outcome
  const stillHeld = digestFile();
  await routeOrders([order(1)], deps(stillHeld, { triage: fakeProvider("digest").triage }));
  await routeOrders([order(1)], deps(stillHeld, { triage: fakeProvider("digest").triage, now: () => T0 + 3 * HOUR }));
  assert.equal(outcomesOf(stillHeld), 0);
  // delivered outright (a wake), then offered again: it was never held
  const woken = digestFile();
  await routeOrders([order(1)], deps(woken, { triage: fakeProvider("wake").triage }));
  await routeOrders([order(1)], deps(woken, { triage: fakeProvider("wake").triage, now: () => T0 + 3 * HOUR }));
  assert.equal(outcomesOf(woken), 0);
  // held and delivered to one seat, offered to another with the same key
  const otherSeat = digestFile();
  await routeOrders([order(1)], deps(otherSeat, { triage: fakeProvider("digest").triage }));
  settleRidden("c", [order(1).causeKey], { digestPath: otherSeat, ledgerAppend: () => {}, now: () => T0 + MINUTE });
  await routeOrders([{ ...order(1), session: "ceo" }], deps(otherSeat, { triage: fakeProvider("wake").triage, now: () => T0 + 2 * HOUR }));
  assert.equal(outcomesOf(otherSeat), 0);
  // the day itself counts, a millisecond past it does not
  for (const [past, lines] of [[0, 1], [1, 0]] as const) {
    const path = digestFile();
    await routeOrders([order(1)], deps(path, { triage: fakeProvider("digest").triage }));
    settleRidden("c", [order(1).causeKey], { digestPath: path, ledgerAppend: () => {}, now: () => T0 + MINUTE });
    await routeOrders([order(1)], deps(path, { triage: fakeProvider("wake").triage, now: () => T0 + MINUTE + OUTCOME_WINDOW_MS + past }));
    assert.equal(outcomesOf(path), lines, `${past} ms past 24 hours`);
  }
});

test("provider none writes no outcome line, even for an order held under an earlier setting and offered again", async () => {
  const path = digestFile();
  await routeOrders([order(1)], deps(path, { triage: fakeProvider("digest").triage }));
  settleRidden("c", [order(1).causeKey], { digestPath: path, ledgerAppend: () => {}, now: () => T0 + MINUTE });
  const before = readFileSync(path, "utf8");
  const out = await routeOrders([order(1)], deps(path, { host: hostWith({ provider: "none" }), now: () => T0 + 3 * HOUR }));
  assert.deepEqual(keys(out.deliver), [order(1).causeKey]);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("an asked line carries the five answers, so a held order says why it was held", async () => {
  const path = digestFile();
  const real = realProvider(() => ok(answersFor(INFORMATIONAL, 0.95)));
  await routeOrders([order(1)], deps(path, { triage: undefined, triageDeps: real.triageDeps }));
  const line = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]);
  assert.deepEqual(line.asked.answers, { "asks-this-seat": "no", repeat: "no", "names-red-main": "no", "names-chairman-direction": "no", "informational-only": "yes" });
  assert.equal(line.asked.held, true);
});

test("a provider that throws delivers the order as before", async () => {
  const path = digestFile();
  const triage = (async () => { throw new Error("boom"); }) as unknown as RouteDeps["triage"];
  const out = await routeOrders([order(1)], deps(path, { triage }));
  assert.deepEqual(keys(out.deliver), ["product-manager/org-health/1"]);
});

test("a worker's order, a reviewer's, a no-cause order, a needs-decision order, a resume and a chairman-bound one are never asked about", async () => {
  const path = digestFile();
  const { triage, asked } = fakeProvider("digest");
  const untouched: GateOrder[] = [
    { session: "worker-7", causeKey: "worker-7/ready-row/1", cause: "ready-row", prompt: "p" },
    { session: "reviewer-9", causeKey: "reviewer-9/pr-review/1", cause: "pr-review", prompt: "p" },
    { session: "ceo", causeKey: "ceo//nocause", prompt: "a direct message" },
    { session: "ceo", causeKey: "ceo/answer-owed/1", cause: "answer-owed", prompt: "p", decision: true },
    { session: "ceo", causeKey: "ceo/answer-owed/2", cause: "answer-owed", prompt: "p", resume: true },
    { session: "ceo", causeKey: "ceo/chairman-reply/3", cause: "chairman-reply", prompt: "p" },
  ];
  const out = await routeOrders(untouched, deps(path, { triage }));
  assert.deepEqual(asked, []);
  assert.deepEqual(out.deliver, untouched);
  assert.equal(existsSync(path), false, "nothing asked, nothing written");
  assert.equal(routable(order(1)), true, "positive control: a manager's gate order IS routable");
  assert.equal(routable(order(1), new Set([order(1).causeKey])), false, "an order the tick wrote itself is excluded");
});

test("provider none (or no block) gives a byte-identical delivery list over 100 orders, asks nobody and writes nothing", async () => {
  const fixture = Array.from({ length: 100 }, (_, n) => order(n, ["ceo", "product-manager", "orchestrator", "worker-1"][n % 4]));
  for (const triage of [undefined, { provider: "none" }]) {
    const path = digestFile();
    const spy = fakeProvider("digest");
    const out = await routeOrders(fixture, deps(path, { host: hostWith(triage), triage: spy.triage }));
    assert.equal(JSON.stringify(out.deliver), JSON.stringify(fixture));
    assert.deepEqual([spy.asked, out.held, existsSync(path)], [[], [], false]);
  }
});

test("an order already held is not asked about again, and is not delivered by the gate emitting it again", async () => {
  const path = digestFile();
  const spy = fakeProvider("digest");
  await routeOrders([order(1)], deps(path, { triage: spy.triage }));
  const again = await routeOrders([order(1), order(2, "worker-3")], deps(path, { triage: spy.triage }));
  assert.deepEqual(spy.asked, ["product-manager/org-health/1"]);
  assert.deepEqual(keys(again.deliver), ["worker-3/org-health/2"]);
  assert.equal(readDigest(path).length, 1);
});

test("the held digest rides the next order its seat gets, and the carrier's delivery retires it into the ledger", async () => {
  const path = digestFile();
  await routeOrders([order(1), order(2), order(3, "ceo")], deps(path, { triage: fakeProvider("digest").triage }));
  const pending = readDigest(path);
  const real: GateOrder = { session: "product-manager", causeKey: "product-manager/answer-owed/9", prompt: "the real order" };
  const riding = ridingDigest([real, { ...real, session: "worker-1", causeKey: "worker-1/x/1" }], pending, T0 + 5 * MINUTE);
  assert.match(riding.orders[0].prompt, /^the real order\n\nHELD FOR YOUR NEXT ORDER/);
  assert.match(riding.orders[0].prompt, /prompt 1[\s\S]*prompt 2/);
  assert.equal(riding.orders[1].prompt, "the real order", "another seat's order carries nothing");
  assert.deepEqual(riding.rides.get(real.causeKey), ["product-manager/org-health/1", "product-manager/org-health/2"]);
  const ledger: string[] = [];
  settleRidden(real.causeKey, riding.rides.get(real.causeKey), { digestPath: path, ledgerAppend: (k) => ledger.push(k), now: () => T0 + 6 * MINUTE });
  assert.deepEqual(ledger, ["product-manager/org-health/1", "product-manager/org-health/2"]);
  assert.deepEqual(readDigest(path).map((h) => h.causeKey), ["ceo/org-health/3"], "only the other seat's item is still held");
});

test("a held order is flushed alone once its oldest item is 60 minutes old, and not a minute before", async () => {
  const path = digestFile();
  await routeOrders([order(1)], deps(path, { triage: fakeProvider("digest").triage }));
  const pending = readDigest(path);
  assert.equal(digestDue(pending, T0 + DIGEST_FLUSH_MS - 1), false);
  assert.deepEqual(flushOrders(pending, new Set(), T0 + DIGEST_FLUSH_MS - 1).orders, []);
  assert.equal(digestDue(pending, T0 + DIGEST_FLUSH_MS), true);
  const flushed = flushOrders(pending, new Set(), T0 + DIGEST_FLUSH_MS);
  assert.equal(flushed.orders.length, 1);
  assert.equal(flushed.orders[0].session, "product-manager");
  assert.match(flushed.orders[0].prompt, /prompt 1/);
  assert.deepEqual(flushed.rides.get(flushed.orders[0].causeKey), ["product-manager/org-health/1"]);
  assert.deepEqual(flushOrders(pending, carriedKeys(flushed.rides), T0 + DIGEST_FLUSH_MS).orders, [], "an item an order already carries is not flushed too");
});

test("every asked order leaves a line, held or delivered, with route, via and confidence", async () => {
  const path = digestFile();
  const answers: Triage[] = [{ route: "digest", via: "jev", confidence: 0.97, reason: "" }, { route: "wake", via: "jev", confidence: 0.99, reason: "" }, { route: "wake", via: "none", reason: "down" }];
  let next = 0;
  const triage = (async () => answers[next++]) as unknown as RouteDeps["triage"];
  await routeOrders([order(1), order(2), order(3)], deps(path, { triage }));
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).asked);
  assert.deepEqual(lines.map((l) => [l.causeKey.split("/")[2], l.triage, l.held]), [
    ["1", { route: "digest", via: "jev", confidence: 0.97 }, true],
    ["2", { route: "wake", via: "jev", confidence: 0.99 }, false],
    ["3", { route: "wake", via: "none" }, false],
  ]);
});

test("after a revert to provider none an order held earlier still rides and flushes", async () => {
  const path = digestFile();
  await routeOrders([order(1)], deps(path, { triage: fakeProvider("digest").triage }));
  const out = await routeOrders([order(2)], deps(path, { host: hostWith({ provider: "none" }) }));
  assert.deepEqual(keys(out.deliver), ["product-manager/org-health/2"]);
  assert.equal(flushOrders(readDigest(path), new Set(), T0 + DIGEST_FLUSH_MS).orders.length, 1);
});
