// no-token: none -- the calls go to a server on the loopback address of this process; nothing leaves the machine
//
// A11-359: the board's pooled keep-alive sockets to Linear went stale and were reset (`ECONNRESET`, `UND_ERR_SOCKET`). `freshFetch` opens a connection for each call and closes it after, so a socket is never used twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { freshFetch, freshFetchWith } from "./fresh-fetch.ts";

/** A server on a free port, which counts the connections it is given and the requests each one carried, and hands each request to `answer`. */
async function serve(answer: (request: IncomingMessage, connection: { requests: number }, socket: Socket, respond: (status: number, body?: string, headers?: Record<string, string>) => void) => void) {
  const connections: { requests: number }[] = [];
  const received: { method?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    const connection = connectionOf.get(request.socket) as { requests: number };
    connection.requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
      answer(request, connection, request.socket, (status, body = "", headers = {}) => { response.writeHead(status, headers); response.end(body); });
    });
  });
  const connectionOf = new WeakMap<Socket, { requests: number }>();
  server.on("connection", (socket) => { const connection = { requests: 0 }; connections.push(connection); connectionOf.set(socket, connection); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, connections, received, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("A11-359: every call is made on a connection of its own, which is closed after it: a server that resets the first reuse of a socket never sees one", async () => {
  // Linear's side: a connection that has served one request is closed by the far end when it is used again.
  const world = await serve((_request, connection, socket, respond) => {
    if (connection.requests > 1) socket.destroy();
    else respond(200, "{}", { "content-type": "application/json" });
  });
  try {
    for (let call = 0; call < 5; call += 1) {
      const response = await freshFetch(`${world.url}/graphql`, { method: "POST", headers: { Authorization: "k" }, body: "{}" });
      assert.equal(response.status, 200, `call ${call + 1}`);
    }
    assert.equal(world.connections.length, 5, "five calls, five connections");
    assert.deepEqual(world.connections.map((c) => c.requests), [1, 1, 1, 1, 1], "none carried a second request");
    assert.equal(world.received.every((r) => r.headers.connection === "close"), true, "each asked for its connection to be closed");
  } finally {
    await world.close();
  }
});

test("A11-359: the method, the headers and the body reach the server as given, and the answer's status, headers and body come back", async () => {
  const world = await serve((_request, _connection, _socket, respond) => respond(201, JSON.stringify({ ok: true }), { "content-type": "application/json", "x-request": "r-1" }));
  try {
    const response = await freshFetch(`${world.url}/x`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "lin_key", Connection: "keep-alive" }, body: JSON.stringify({ query: "q" }) });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-request"), "r-1");
    assert.deepEqual(await response.json(), { ok: true });
    const [seen] = world.received;
    assert.deepEqual([seen.method, seen.headers.authorization, seen.headers["content-type"], seen.body], ["POST", "lin_key", "application/json", JSON.stringify({ query: "q" })]);
    assert.equal(seen.headers.connection, "close", "a caller's keep-alive does not keep the connection");
  } finally {
    await world.close();
  }
});

test("A11-359: a connection that is reset fails the call as fetch does, with the reason in its cause, and one refused does the same", async () => {
  const world = await serve((_request, _connection, socket) => socket.destroy());
  const down = `http://127.0.0.1:${(await (async () => { const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const port = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return port; })())}`;
  try {
    await assert.rejects(freshFetch(`${world.url}/x`), (err: unknown) => err instanceof TypeError && err.message === "fetch failed" && (err.cause as { code?: string }).code === "ECONNRESET");
    await assert.rejects(freshFetch(`${down}/x`), (err: unknown) => err instanceof TypeError && err.message === "fetch failed" && (err.cause as { code?: string }).code === "ECONNREFUSED");
  } finally {
    await world.close();
  }
});

test("A11-359: a server that accepts the call and says nothing fails it at its deadline, and an abort fails it at once", async () => {
  const world = await serve(() => undefined);
  try {
    await assert.rejects(freshFetchWith(50)(`${world.url}/x`), (err: unknown) => err instanceof TypeError && err.message === "fetch failed" && (err.cause as { code?: string }).code === "UND_ERR_HEADERS_TIMEOUT");
    const controller = new AbortController();
    const pending = freshFetch(`${world.url}/x`, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stopped")), 20);
    await assert.rejects(pending, /stopped/);
  } finally {
    await world.close();
  }
});

test("A11-359: a redirect is followed, and the key stays behind when it leaves the origin", async () => {
  const storage = await serve((_request, _connection, _socket, respond) => respond(200, "the file", { "content-type": "text/plain" }));
  const origin = await serve((_request, _connection, _socket, respond) => respond(302, "", { location: `${storage.url}/stored/file.md` }));
  try {
    const response = await freshFetch(`${origin.url}/uploads/file.md`, { headers: { Authorization: "lin_key" } });
    assert.equal(await response.text(), "the file");
    assert.equal(origin.received[0].headers.authorization, "lin_key");
    assert.equal(storage.received[0].headers.authorization, undefined, "the key is sent to the origin it was meant for and no other");
  } finally {
    await origin.close();
    await storage.close();
  }
});

test("A11-359: an answer with no body (204) is an empty Response", async () => {
  const world = await serve((_request, _connection, _socket, respond) => respond(204));
  try {
    const response = await freshFetch(`${world.url}/x`);
    assert.deepEqual([response.status, await response.text()], [204, ""]);
  } finally {
    await world.close();
  }
});

test("A11-359: more than five redirects fail the call as fetch fails it, and are not handed back as an answer", async () => {
  const world = await serve((_request, _connection, _socket, respond) => respond(302, "", { location: "/again" }));
  try {
    await assert.rejects(freshFetch(`${world.url}/x`), (err: unknown) => err instanceof TypeError && err.message === "fetch failed" && /redirects/.test(String((err.cause as Error).message)));
    assert.equal(world.connections.length, 6, "the call and its five redirects");
  } finally {
    await world.close();
  }
});
