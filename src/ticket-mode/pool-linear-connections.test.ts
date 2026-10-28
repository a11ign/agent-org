// no-token: gh -- herdr, git and the code host are injected; the tracker is the real Linear client over the real fresh-connection fetch, calling a server on the loopback address of this process
//
// A11-359, before merge: a Linear whose side closes the first reuse of a socket (as it did, within an hour of each restart) lets the call succeed, and queued runs start while the project read fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { freshFetch } from "../fresh-fetch.ts";
import { LINEAR_API, linearSource } from "../../plugins/linear/linear.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { TicketSource } from "./source.ts";

/** A Linear on the loopback address. A connection that has carried a request is closed by this side when it is used again. The project read is answered 500 every time. */
async function linearThatResetsReuse() {
  const uses = new Map<Socket, number>();
  const queries: string[] = [];
  let reset = 0;
  const server = createServer((request, response) => {
    const used = (uses.get(request.socket) ?? 0) + 1;
    uses.set(request.socket, used);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (used > 1) { reset += 1; request.socket.destroy(); return; }
      const { query } = JSON.parse(Buffer.concat(chunks).toString()) as { query: string };
      queries.push(query.includes("inverseRelations") ? "blockers" : query.includes("summary: description") ? "projects" : "other");
      if (query.includes("summary: description") && !query.includes("inverseRelations")) { response.writeHead(500); response.end("down"); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { k0: { nodes: [{ inverseRelations: { nodes: [] } }] }, k1: { nodes: [{ inverseRelations: { nodes: [] } }] } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  /** The transport the board gives the tracker, aimed at this server instead of api.linear.app. */
  const transport = ((input: string | URL | Request, init?: RequestInit) => freshFetch(String(input).replace(LINEAR_API, origin), init)) as typeof fetch;
  return { transport, origin, queries, uses, resets: () => reset, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("A11-359: over the board's fresh-connection fetch, a Linear that closes the first reuse of a socket never resets a call: every call is on a socket of its own", async () => {
  const linear = await linearThatResetsReuse();
  try {
    const source = linearSource({ key: "k", fetch: linear.transport, sleep: async () => undefined });
    for (let call = 0; call < 4; call += 1) assert.deepEqual([...(await source.blockers!(["NBF-1"])).get("NBF-1") ?? []], [], `call ${call + 1}`);
    assert.equal(linear.resets(), 0, "no socket was used twice, so none was reset");
    assert.deepEqual([...linear.uses.values()], [1, 1, 1, 1], "four calls on four sockets");
  } finally {
    await linear.close();
  }
});

test("A11-359: the same Linear resets a call on a pooled connection, so the test above is of the failure the board had", async () => {
  const linear = await linearThatResetsReuse();
  try {
    const pooled = (input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(LINEAR_API, linear.origin), init);
    const source = linearSource({ key: "k", fetch: pooled as typeof fetch, sleep: async () => undefined, attemptMs: 2_000 });
    // The retry of the client is not the point here: with it, the pooled call is also made good, on a connection the pool opens again. What matters is the reset the board saw.
    for (let call = 0; call < 3; call += 1) await source.blockers!(["NBF-1"]);
    assert.equal(linear.resets() > 0, true, "a socket that was used again was closed by Linear");
  } finally {
    await linear.close();
  }
});

test("A11-359: queued runs start while the project read fails and the blocker reads ride out a reused-socket reset", async () => {
  const linear = await linearThatResetsReuse();
  try {
    const fake = createFakeTracker();
    const tracker = linearSource({ key: "k", fetch: linear.transport, sleep: async () => undefined });
    const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords, blockers: tracker.blockers, projectSummaries: tracker.projectSummaries };
    const { pool, entry } = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 10, source });
    await pool.tick();
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "running"], "both start though every project read was answered 500");
    assert.equal(linear.queries.includes("projects"), true, "the project read was made, and failed");
    assert.equal(linear.resets(), 0);
  } finally {
    await linear.close();
  }
});
