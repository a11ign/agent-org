// no-token: gh -- the tunnel is a fixed link; the one "remote board" listens on a Unix socket in a temporary directory for a test's length
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Unreachable, type Link, type Remotes } from "./remote.ts";
import { forwardHeaders, passedOn, proxy, type Forward } from "./remote-proxy.ts";

const KEY = "b".repeat(48);
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";

/** Remotes that always reach `link`, or always fail with `reason`, counting each `forget`. */
function fixed(link: Link | string) {
  const counts = { forgot: 0 };
  const remotes = {
    has: () => true,
    reach: async () => { if (typeof link === "string") throw new Unreachable(link); return link; },
    forget: () => { counts.forgot += 1; },
    close: () => {},
  } as unknown as Remotes;
  return { remotes, counts };
}

test("the remote board is sent its own host, the key and the JSON body over the tunnel's socket, and never the browser's cookie or origin", async () => {
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
    const { remotes } = fixed({ port: 4747, key: KEY, terminal: TERMINAL, socket, terminalLocal: 50002 });
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
  assert.deepEqual(Object.keys(forwardHeaders({ port: 1, key: KEY }, null)).sort(), ["accept", "host", "x-ticket-token"], "nothing else is sent");
});

test("only the routes the page calls are passed on, by the method it calls them with, so a pairing code there is never asked for", async () => {
  for (const path of ["/api/config", "/api/tickets", "/api/parents", "/api/queue"]) assert.equal(passedOn("GET", path), true, path);
  for (const path of ["/api/queue", "/api/choice", "/api/publish", "/api/paused", "/api/max", "/api/queue/NBF-1/approve", "/api/queue/NBF-1/stop"]) {
    assert.equal(passedOn("POST", path), true, path);
  }
  for (const [method, path] of [["POST", "/api/pair-code"], ["POST", "/api/pair-code/"], ["POST", "/api/queue/NBF-1/../../pair-code"], ["GET", "/api/profiles"],
    ["DELETE", "/api/queue"], ["GET", "/api/paused"], ["POST", "/api/queue/NBF-1/drop"]]) {
    assert.equal(passedOn(method, path), false, `${method} ${path}`);
  }
  let sent = 0;
  const counting: Forward = async () => { sent += 1; return { status: 200, body: "{}" }; };
  const { remotes } = fixed({ port: 4747, key: KEY, terminal: null, socket: "/s", terminalLocal: null });
  assert.deepEqual(await proxy(remotes, "personal", { method: "POST", path: "/api/pair-code?x=1", body: null }, counting),
    [403, { error: "POST /api/pair-code is not passed on to another machine's board" }]);
  assert.equal(sent, 0);
});

test("an unreachable remote, a board that does not answer and a refused key are each answered in words, and the key is read again after a refusal", async () => {
  const failing = fixed("agents: Permission denied (publickey).");
  assert.deepEqual(await proxy(failing.remotes, "personal", { method: "GET", path: "/api/queue", body: null }), [502, { error: "cannot reach personal over SSH: agents: Permission denied (publickey)." }]);
  const up = fixed({ port: 4747, key: KEY, terminal: null, socket: "/s", terminalLocal: null });
  const silent: Forward = async () => { throw new Error("socket hang up"); };
  assert.deepEqual(await proxy(up.remotes, "personal", { method: "GET", path: "/api/queue", body: null }, silent),
    [502, { error: "cannot reach personal's board through SSH: socket hang up. Is agent-org ticket:serve running there?" }]);
  const refused: Forward = async () => ({ status: 401, body: "{\"error\":\"this browser is not paired\"}" });
  const [status, value] = await proxy(up.remotes, "personal", { method: "GET", path: "/api/queue", body: null }, refused);
  assert.equal(status, 502);
  assert.match((value as { error: string }).error, /^cannot reach personal over SSH: its board refused the key/);
  assert.equal(up.counts.forgot, 1);
  const garbled: Forward = async () => ({ status: 200, body: "<html>" });
  assert.deepEqual(await proxy(up.remotes, "personal", { method: "GET", path: "/api/queue", body: null }, garbled), [502, { error: "personal's board answered with something that is not JSON" }]);
});
