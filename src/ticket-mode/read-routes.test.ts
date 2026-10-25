// no-token: gh -- one server on 127.0.0.1 answers through `answerKeyed` with a stand-in route table; the tracker is a stand-in; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { type Api, answerKeyed, trackerReads } from "./read-routes.ts";
import type { Assignee, People, TicketSource } from "./source.ts";

const KEY = "b".repeat(48);

/** A server on a free port that answers every request through `answerKeyed` and `api`, and how to reach and close it. */
async function serving(api: Api): Promise<Readonly<{ port: number; server: Server }>> {
  let port = 0;
  const server = createServer((request, response) => { void answerKeyed(request, response, { port, key: KEY, api }); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  return { port, server };
}

const closing = (server: Server) => new Promise<void>((done) => { server.close(() => done()); });

/** The status of a GET that names `host` as its `Host`, which `fetch` does not let a caller set. */
const statusAsHost = (port: number, host: string) => new Promise<number>((done, fail) => {
  request({ host: "127.0.0.1", port, path: "/api/queue", headers: { host, "x-ticket-token": KEY } }, (response) => { response.resume(); done(response.statusCode ?? 0); }).on("error", fail).end();
});

test("a request is let in only from this server's host and with the key, and its route's answer, or its route's sentence as a 400, is sent", async () => {
  const asked: string[] = [];
  const { port, server } = await serving(async (method, path, body, query) => {
    asked.push(`${method} ${path} ${JSON.stringify(body)} ${query.toString()}`);
    if (path === "/api/fails") throw new Error("the route refused");
    return [201, { ok: true }];
  });
  try {
    const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
    const ok = await call("/api/queue?x=1", { headers: { "x-ticket-token": KEY } });
    assert.deepEqual([ok.status, await ok.json()], [201, { ok: true }]);
    const posted = await call("/api/max", { method: "POST", headers: { "x-ticket-token": KEY }, body: JSON.stringify({ max: 3 }) });
    assert.equal(posted.status, 201);
    const failed = await call("/api/fails", { headers: { "x-ticket-token": KEY } });
    assert.deepEqual([failed.status, await failed.json()], [400, { error: "the route refused" }]);
    const keyless = await call("/api/queue");
    assert.equal(keyless.status, 401);
    assert.equal(await statusAsHost(port, "evil.example"), 403);
    assert.deepEqual(asked, ["GET /api/queue {} x=1", "POST /api/max {\"max\":3} ", "GET /api/fails {} "], "no refused request reached the route table");
  } finally {
    await closing(server);
  }
});

test("whose key it is, is read once and kept, and a failed read is asked again", async () => {
  const me: Assignee = { id: "u1", name: "A Person" };
  let asks = 0;
  const source = { me: async () => { asks += 1; if (asks === 1) throw new Error("down"); return me; } } as unknown as TicketSource;
  const reads = trackerReads(source, { pick: "assigned" });
  assert.equal(await reads.whoAmI(), null, "the tracker was down");
  assert.equal(await reads.whoAmI(), me);
  assert.equal(await reads.whoAmI(), me);
  assert.equal(asks, 2);
});

test("who holds the open tickets is read once at a time and kept, and scopes are read one at a time only for assigned with people and scoped", async () => {
  let reads = 0;
  const people: People = { people: [], unassigned: 0, total: 0 };
  const source = { people: async () => { reads += 1; return people; }, scoped: async () => ({ tickets: [], next: null }) } as unknown as TicketSource;
  const assigned = trackerReads(source, { pick: "assigned" });
  const [first, second] = await Promise.all([assigned.whoHolds(), assigned.whoHolds()]);
  assert.equal(first, people);
  assert.equal(second, people);
  await assigned.whoHolds();
  assert.equal(reads, 1);
  assert.equal(assigned.scopesOnDemand(), true);
  assert.equal(trackerReads(source, { pick: { team: "NBF" } }).scopesOnDemand(), false);
  assert.equal(trackerReads({} as TicketSource, { pick: "assigned" }).scopesOnDemand(), false);
});
