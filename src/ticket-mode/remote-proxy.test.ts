// no-token: gh -- each connection is a fixed target; the one "instance" listens on a Unix socket in a temporary directory for a test's length
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import type { Connection, Connections, Target } from "./connections.ts";
import { localTerminal, Unreachable } from "./remote.ts";
import { forwardHeaders, httpForward, passedOn, proxy, type Forward } from "./remote-proxy.ts";

const KEY = "b".repeat(48);
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";

const PERSONAL: Connection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };

/** The target of an ssh connection whose tunnel is `socket`, and whose terminal is forwarded to `terminalLocal`. */
const overSsh = (socket: string, terminalLocal: number | null = null): Target =>
  ({ key: KEY, host: "127.0.0.1:4747", address: { socket }, terminal: (template) => localTerminal(template, terminalLocal) });

/** Connections whose one, `connection`, always reaches `target`, or always fails with `reason`, counting each `forget`. */
function fixed(target: Target | string, connection: Connection = PERSONAL) {
  const counts = { forgot: 0 };
  const connections = {
    get: (name: string) => (name === connection.name ? connection : undefined),
    reach: async () => { if (typeof target === "string") throw new Unreachable(target); return target; },
    forget: () => { counts.forgot += 1; },
    close: () => {},
  } as Connections;
  return { remotes: connections, counts };
}

test("the instance is sent its own host, the key and the JSON body over the tunnel's socket, and never the browser's cookie or origin", async () => {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "ticket_session=remote" });
      res.end(JSON.stringify(req.url?.split("?")[0] === "/api/config" ? { terminal: TERMINAL, max: 2 } : { entries: [], max: 2, paused: false }));
    });
  });
  // A short directory: a socket's path is cut at 104 bytes on macOS, and the suite's own TMPDIR is longer than that.
  const dir = mkdtempSync("/tmp/ao-proxy-");
  const socket = join(dir, "board.sock");
  await new Promise<void>((done, fail) => { server.on("error", fail); server.listen(socket, done); });
  try {
    const { remotes } = fixed(overSsh(socket, 50002));
    const posted = await proxy(remotes, "personal", { method: "POST", path: "/api/paused", body: JSON.stringify({ paused: false }) });
    assert.deepEqual(posted, [200, { entries: [], max: 2, paused: false }]);
    assert.equal(seen[0].headers.host, "127.0.0.1:4747", "the remote's DNS-rebinding guard sees its own host");
    assert.equal(seen[0].headers["x-ticket-token"], KEY);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers.origin, undefined);
    assert.equal(seen[0].body, "{\"paused\":false}");
    assert.equal(seen[0].method, "POST");
    const [, config] = await proxy(remotes, "personal", { method: "GET", path: "/api/config", body: null });
    assert.deepEqual(config, { terminal: "http://127.0.0.1:50002/?ws={workspace}&pane={pane}&view=terminal", max: 2 }, "Open terminal goes through the tunnel too");
    const [, queried] = await proxy(remotes, "personal", { method: "GET", path: "/api/config?x=1", body: null });
    assert.equal((queried as { terminal: string }).terminal, "http://127.0.0.1:50002/?ws={workspace}&pane={pane}&view=terminal", "a query does not skip the rewrite");
    assert.equal(JSON.stringify([posted, config]).includes(KEY), false, "the key is in no answer");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(Object.keys(forwardHeaders({ host: "127.0.0.1:1", key: KEY }, null)).sort(), ["accept", "host", "x-ticket-token"], "nothing else is sent");
});

test("A11-129: a worker link's run lookup is passed on as a POST, and never as a GET", () => {
  assert.equal(passedOn("POST", "/api/terminal-run"), true);
  assert.equal(passedOn("GET", "/api/terminal-run"), false);
});

test("the worker terminal's pairing code is passed on as a POST, and never as a GET", () => {
  assert.equal(passedOn("POST", "/api/terminal-pair"), true);
  assert.equal(passedOn("GET", "/api/terminal-pair"), false);
});

test("only the routes the page calls are passed on, by the method it calls them with, so a pairing code there is never asked for", async () => {
  for (const path of ["/api/config", "/api/tickets", "/api/people", "/api/parents", "/api/pick", "/api/queue", "/api/writer", "/api/settings"]) assert.equal(passedOn("GET", path), true, path);
  assert.equal(passedOn("POST", "/api/settings"), false, "the settings page reads its configuration and writes none of it");
  for (const path of ["/api/queue", "/api/queue-children", "/api/choice", "/api/publish", "/api/paused", "/api/max", "/api/queue/NBF-1/approve", "/api/queue/NBF-1/stop", "/api/queue/NBF-1/dismiss", "/api/queue/NBF-1/apply-edit", "/api/queue/NBF-1/discard-edit"]) {
    assert.equal(passedOn("POST", path), true, path);
  }
  for (const path of ["/api/writer/w1/stop", "/api/writer/w1/dismiss"]) {
    assert.equal(passedOn("POST", path), true, path);
  }
  // A11-124: the board makes the tickets, so a draft's approve and discard are no route the page calls any more.
  for (const path of ["/api/writer/w1/drafts/d1/approve", "/api/writer/w1/drafts/d1/discard"]) {
    assert.equal(passedOn("POST", path), false, `${path} is no route`);
  }
  for (const [method, path] of [["POST", "/api/pair-code"], ["POST", "/api/pair-code/"], ["POST", "/api/queue/NBF-1/../../pair-code"], ["GET", "/api/profiles"],
    ["DELETE", "/api/queue"], ["GET", "/api/paused"], ["POST", "/api/queue/NBF-1/drop"], ["DELETE", "/api/writer"], ["POST", "/api/writer/w1/drafts/d1/create"],
    ["POST", "/api/writer/w1/drafts/d1/approve/extra"], ["POST", "/api/writer/w1/../stop"]]) {
    assert.equal(passedOn(method, path), false, `${method} ${path}`);
  }
  let sent = 0;
  const counting: Forward = async () => { sent += 1; return { status: 200, body: "{}" }; };
  const { remotes } = fixed(overSsh("/s"));
  assert.deepEqual(await proxy(remotes, "personal", { method: "POST", path: "/api/pair-code?x=1", body: null }, counting),
    [403, { error: "POST /api/pair-code is not passed on to an instance" }]);
  assert.deepEqual(await proxy(remotes, "gone", { method: "GET", path: "/api/queue", body: null }, counting), [404, { error: "no connection gone" }]);
  assert.equal(sent, 0);
});

test("A11-76: Queue its children is passed on to an instance over SSH, with its body, and only as a POST", async () => {
  assert.equal(passedOn("POST", "/api/queue-children"), true);
  assert.equal(passedOn("GET", "/api/queue-children"), false, "it is a write, never a read");
  const sent: { method: string; path: string; body: string | null }[] = [];
  const recording: Forward = async (_target, request) => { sent.push(request); return { status: 200, body: JSON.stringify({ keys: ["A11-25"], note: null, queue: { entries: [] } }) }; };
  const body = JSON.stringify({ key: "A11-24", model: "opus", effort: "high", plan: false });
  const answer = await proxy(fixed(overSsh("/s")).remotes, "personal", { method: "POST", path: "/api/queue-children", body }, recording);
  assert.deepEqual(answer, [200, { keys: ["A11-25"], note: null, queue: { entries: [] } }]);
  assert.deepEqual(sent, [{ method: "POST", path: "/api/queue-children", body }]);
  const refused: Forward = async () => ({ status: 400, body: JSON.stringify({ error: "A11-30 has no open sub-issues: queue it as it is" }) });
  assert.deepEqual(await proxy(fixed(overSsh("/s")).remotes, "personal", { method: "POST", path: "/api/queue-children", body }, refused),
    [400, { error: "A11-30 has no open sub-issues: queue it as it is" }], "the instance's refusal reaches the page as it was");
});

test("an unreachable connection, an instance that does not answer and a refused key are each answered in words, and the key is read again after a refusal", async () => {
  const failing = fixed("agents: Permission denied (publickey).");
  assert.deepEqual(await proxy(failing.remotes, "personal", { method: "GET", path: "/api/queue", body: null }), [502, { error: "cannot reach personal over SSH: agents: Permission denied (publickey)." }]);
  const up = fixed(overSsh("/s"));
  const silent: Forward = async () => { throw new Error("socket hang up"); };
  assert.deepEqual(await proxy(up.remotes, "personal", { method: "GET", path: "/api/queue", body: null }, silent),
    [502, { error: "cannot reach personal's instance over SSH: socket hang up. Is agent-org ticket:serve running there?" }]);
  const refused: Forward = async () => ({ status: 401, body: "{\"error\":\"this browser is not paired\"}" });
  const [status, value] = await proxy(up.remotes, "personal", { method: "GET", path: "/api/queue", body: null }, refused);
  assert.equal(status, 502);
  assert.match((value as { error: string }).error, /^cannot reach personal over SSH: its instance refused the key/);
  assert.equal(up.counts.forgot, 1);
  const garbled: Forward = async () => ({ status: 200, body: "<html>" });
  assert.deepEqual(await proxy(up.remotes, "personal", { method: "GET", path: "/api/queue", body: null }, garbled), [502, { error: "personal's instance answered with something that is not JSON" }]);
});

test("an instance at an address is sent the address's own host and the key, and a lab that cannot be reached names its address", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"entries\":[]}"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  try {
    const local: Connection = { name: "work", kind: "local" };
    const target: Target = { key: KEY, host: `127.0.0.1:${port}`, address: { origin: `http://127.0.0.1:${port}` }, terminal: (template) => template };
    assert.deepEqual(await proxy(fixed(target, local).remotes, "work", { method: "GET", path: "/api/queue", body: null }), [200, { entries: [] }]);
    assert.equal(seen[0].host, `127.0.0.1:${port}`);
    assert.equal(seen[0]["x-ticket-token"], KEY);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  const lab: Connection = { name: "lab", kind: "https", origin: "https://agents.example.ts.net", keyFile: "/k" };
  assert.deepEqual(await proxy(fixed("/k can be read by other users (mode 644): run chmod 600 on it", lab).remotes, "lab", { method: "GET", path: "/api/queue", body: null }),
    [502, { error: "cannot reach lab at https://agents.example.ts.net: /k can be read by other users (mode 644): run chmod 600 on it" }]);
});

test("an https instance is reached over TLS: a server that does not speak it fails the call rather than receive the key in the clear", async () => {
  const received: Buffer[] = [];
  const plain = createTcpServer((socket) => { socket.on("data", (chunk: Buffer) => { received.push(chunk); socket.destroy(); }); });
  await new Promise<void>((done) => plain.listen(0, "127.0.0.1", done));
  const { port } = plain.address() as { port: number };
  try {
    const target: Target = { key: KEY, host: `127.0.0.1:${port}`, address: { origin: `https://127.0.0.1:${port}` }, terminal: () => null };
    await assert.rejects(httpForward(target, { method: "GET", path: "/api/queue", body: null }));
    assert.equal(Buffer.concat(received).toString("latin1").includes(KEY), false, "the key was never sent before the TLS handshake");
  } finally {
    await new Promise<void>((done) => plain.close(() => done()));
  }
});

test("a path that names another host stays on the instance's, and an answer too big to hold is refused", async () => {
  const paths: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/api/tickets" ? `"${"x".repeat(9 * 1024 * 1024)}"` : "{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  try {
    const target: Target = { key: KEY, host: `127.0.0.1:${port}`, address: { origin: `http://127.0.0.1:${port}` }, terminal: () => null };
    assert.equal((await httpForward(target, { method: "GET", path: "//evil.example/api/queue", body: null })).status, 200);
    assert.deepEqual(paths, ["//evil.example/api/queue"], "the request reached this instance, not evil.example");
    await assert.rejects(httpForward(target, { method: "GET", path: "/api/tickets", body: null }), /an answer over 8388608 bytes/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("A11-132: the Settings edits are passed on to the machine's own instance, and refused for an ssh or an https connection before anything is sent", async () => {
  const EDITS = ["/api/settings/preview", "/api/settings/save", "/api/settings/restore"];
  for (const path of EDITS) assert.equal(passedOn("POST", path), true, path);
  const LOCAL: Connection = { name: "local", kind: "local" };
  const LAB: Connection = { name: "lab", kind: "https", origin: "https://agents.example.ts.net", keyFile: "/k" };
  const sent: string[] = [];
  const forward = async (_target: Target, request: { path: string }) => { sent.push(request.path); return { status: 200, body: "{}" }; };
  const target = overSsh("/unused.sock");
  for (const path of EDITS) {
    assert.deepEqual(await proxy(fixed(target, LOCAL).remotes, "local", { method: "POST", path, body: "{}" }, forward), [200, {}]);
    const remotes: Connection[] = [PERSONAL, LAB];
    for (const remote of remotes) {
      const [status, body] = await proxy(fixed(target, remote).remotes, remote.name, { method: "POST", path, body: "{}" }, forward);
      assert.equal(status, 403, `${path} over ${remote.kind}`);
      assert.match((body as { error: string }).error, new RegExp(`${remote.name}'s settings are not changed from here`));
    }
  }
  assert.equal(sent.length, EDITS.length, "only the calls to the local instance were sent");
});
