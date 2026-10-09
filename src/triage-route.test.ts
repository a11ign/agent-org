// #4385: routing manager wakes by the triage provider. A fake provider (or a fake `fetch` under the real one), a fake ledger and a private directory only: no network, no key.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseHostConfig } from "./host-config.ts";
import { DIGEST_FLUSH_MS, carriedKeys, digestDue, flushOrders, readDigest, ridingDigest, routeOrders, routable, settleRidden, type GateOrder, type RouteDeps } from "./triage-route.ts";
import { freshState, type Triage } from "./triage-provider.ts";

const T0 = 1_000_000_000_000;
const MINUTE = 60_000;
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

test("the real provider's floor decides: 0.9 digests and 0.89 delivers, and a provider error delivers", async () => {
  const answer = (confidence: number) => ({ answers: { q: { choice: "digest", confidence } } });
  const run = async (reply: () => unknown) => {
    const path = digestFile();
    const fetchFn = (async () => reply()) as unknown as typeof fetch;
    const out = await routeOrders([order(1)], deps(path, { triage: undefined, triageDeps: { fetch: fetchFn, readKey: () => "k", state: freshState(), diagnostic: () => {} } }));
    return { delivered: keys(out.deliver), held: readDigest(path).length };
  };
  const body = (confidence: number) => ({ ok: true, status: 200, json: async () => answer(confidence) });
  assert.deepEqual(await run(() => body(0.9)), { delivered: [], held: 1 });
  assert.deepEqual(await run(() => body(0.89)), { delivered: ["product-manager/org-health/1"], held: 0 });
  assert.deepEqual(await run(() => { throw new Error("down"); }), { delivered: ["product-manager/org-health/1"], held: 0 });
  assert.deepEqual(await run(() => ({ ok: false, status: 503 })), { delivered: ["product-manager/org-health/1"], held: 0 });
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
