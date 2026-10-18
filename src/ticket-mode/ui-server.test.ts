// no-token: gh -- the instance is a real `createBoard` on 127.0.0.1 with Linear and the pool injected; ssh is a fake runner
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { browserSessions, browserSessionsPath } from "./browser-sessions.ts";
import { createConnections, readConnections, type Connection, type ConnectionsRead } from "./connections.ts";
import { createRemotes, type Runner } from "./remote.ts";
import { httpForward, type Forward } from "./remote-proxy.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { boardViewScript, createUi, labelFiltersScript, pairedBy } from "./ui-server.ts";

const REMOTE_KEY = "c".repeat(48);
const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;

/** The labels this machine's instance gives its ticket, which the page reads through a connection like every other field. */
const LABELS = [{ name: "Fleet", group: "Goal" }, { name: "Bug", group: null }];

/** A server for `handle` on a free port on 127.0.0.1: its base address, and what closes it. */
async function listen(handle: (port: number) => (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const handler = handle(port);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** This machine's instance, a real one, on its own port with its own key, and the state directory both services share. */
async function instance() {
  const stateDir = tmpDir("ticket-ui-state-");
  const key = boardKey(boardKeyPath(stateDir));
  const seen: IncomingMessage["headers"][] = [];
  const pool = { tick: async () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {} };
  const source: TicketSource = { assigned: async () => [{ ...ticket("NBF-1"), labels: LABELS }], read: async () => null, download: async () => [] };
  const served = await listen((port) => {
    const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir, tickets: { port, terminal: "http://127.0.0.1:7318/?ws={workspace}" } });
    const board = createBoard({ settings, source, key, queuePath: join(stateDir, "queue.json"), choicePath: join(stateDir, "choice.json"), pool, now: () => 7 });
    return (req, res) => { seen.push(req.headers); return board.handle(req, res); };
  });
  return { ...served, stateDir, key, seen };
}

/** An ssh runner that reaches "the remote" with `REMOTE_KEY`, or one whose ssh always fails, recording what it is asked to run. */
function sshRunner(fails = false) {
  const ran: (readonly string[])[] = [];
  const runner: Runner = {
    run: async (argv) => {
      ran.push(argv);
      return fails ? { code: 255, stdout: "", stderr: "agents: Permission denied (publickey)." } : { code: 0, stdout: JSON.stringify({ port: 4747, key: REMOTE_KEY, terminal: null }), stderr: "" };
    },
    start: (argv) => { ran.push(argv); return { exited: new Promise(() => {}), stop: () => {} }; },
    freePort: async () => 50001,
    privateSocket: () => ({ path: "/private/board.sock", remove: () => {} }),
    listening: async () => true,
  };
  return { ran, runner };
}

/** The page's service for `list`, in front of this machine's real instance, with ssh connections answered by `forward` or failing. */
async function ui(list: readonly Connection[], { refusal = null, sshFails = false }: { refusal?: string | null; sshFails?: boolean } = {}) {
  const local = await instance();
  const ssh = sshRunner(sshFails);
  const forwarded: { path: string; key: string; host: string }[] = [];
  const read: ConnectionsRead = { connections: list, refusal, migrated: null };
  const remotes = createRemotes(list.filter((c) => c.kind === "ssh") as never, { runner: ssh.runner, log: () => {}, schedule: () => () => {} });
  const connections = createConnections(list, { local: { port: local.port, keyPath: boardKeyPath(local.stateDir) }, remotes });
  const forward: Forward = async (target, request) => {
    if ("origin" in target.address) return httpForward(target, request);
    forwarded.push({ path: request.path, key: target.key, host: target.host });
    return { status: 200, body: JSON.stringify({ entries: [], max: 1, paused: false }) };
  };
  const sessions = browserSessions(browserSessionsPath(local.stateDir), () => 7);
  const served = await listen((port) => createUi({ port, key: local.key, sessions, read, connections, forward }).handle);
  return { ...served, local, ssh, forwarded, close: async () => { await served.close(); await local.close(); } };
}

const WORK: Connection = { name: "work", kind: "local" };
const PERSONAL: Connection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };
const pairWith = (base: string, code: string) => fetch(`${base}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });

async function pairedCookie(base: string, key: string): Promise<string> {
  const { code } = await (await fetch(`${base}/api/pair-code`, { method: "POST", headers: { "x-ticket-token": key } })).json() as { code: string };
  return String((await pairWith(base, code)).headers.get("set-cookie")).split(";")[0];
}

test("a browser that has not paired gets the pairing page and no API, and a code from ticket:pair gets it a cookie that lasts a year", async () => {
  const u = await ui([WORK]);
  try {
    assert.equal((await fetch(`${u.base}/c/work/api/queue`)).status, 401);
    const unpaired = await fetch(`${u.base}/`);
    assert.equal(unpaired.status, 200);
    assert.match(await unpaired.text(), /<title>Pair this browser<\/title>/);
    assert.equal((await fetch(`${u.base}/?token=${u.local.key}`, { redirect: "manual" })).headers.get("set-cookie"), null, "the key in a URL pairs nothing");
    const { code } = await (await fetch(`${u.base}/api/pair-code`, { method: "POST", headers: { "x-ticket-token": u.local.key } })).json() as { code: string };
    const paired = await pairWith(u.base, code);
    assert.equal(paired.status, 200);
    const cookie = String(paired.headers.get("set-cookie"));
    assert.match(cookie, /^ticket_session=[0-9a-f]{48}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
    assert.equal(cookie.includes(u.local.key), false, "the browser gets a session of its own, not the key");
    const page = await fetch(`${u.base}/`, { headers: { cookie: cookie.split(";")[0] } });
    assert.match(await page.text(), /<title>Ticket queue<\/title>/);
    assert.equal((await pairWith(u.base, code)).status, 401, "a code pairs one browser");
  } finally {
    await u.close();
  }
});

test("a wrong code, a pairing request that is too big or not an object, and a browser asking for a code are each refused", async () => {
  const u = await ui([WORK]);
  try {
    const wrong = await pairWith(u.base, "ABCD-EFGH");
    assert.equal(wrong.status, 401);
    assert.match((await wrong.json() as { error: string }).error, /wrong, used or out of date\. Run agent-org ticket:pair/);
    const { code } = await (await fetch(`${u.base}/api/pair-code`, { method: "POST", headers: { "x-ticket-token": u.local.key } })).json() as { code: string };
    for (const body of ["null", "[]", "{", JSON.stringify({ code, pad: "x".repeat(2048) })]) assert.equal((await fetch(`${u.base}/pair`, { method: "POST", body })).status, 400, body.slice(0, 20));
    const cookie = String((await pairWith(u.base, code)).headers.get("set-cookie")).split(";")[0];
    assert.notEqual(cookie, "null", "the bad requests left the code live");
    const browser = await fetch(`${u.base}/api/pair-code`, { method: "POST", headers: { cookie } });
    assert.equal(browser.status, 403);
    assert.match((await browser.json() as { error: string }).error, /made with the board key: run agent-org ticket:pair/);
  } finally {
    await u.close();
  }
});

test("a paired browser's call is passed on to this machine's instance with its key and its own Host, and never the browser's cookie", async () => {
  const u = await ui([WORK]);
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const queue = await fetch(`${u.base}/c/work/api/queue`, { headers: { cookie } });
    assert.equal(queue.status, 200);
    assert.deepEqual((await queue.json() as { entries: unknown[] }).entries, []);
    const config = await (await fetch(`${u.base}/c/work/api/config`, { headers: { cookie } })).json() as { terminal: string };
    assert.equal(config.terminal, "http://127.0.0.1:7318/?ws={workspace}", "this machine's terminal is linked as it is");
    const posted = await fetch(`${u.base}/c/work/api/paused`, { method: "POST", headers: { cookie, "Content-Type": "application/json", origin: u.base }, body: JSON.stringify({ paused: false }) });
    assert.equal(posted.status, 200);
    assert.equal((await posted.json() as { paused: boolean }).paused, false, "the instance took the write");
    const last = u.local.seen.at(-1)!;
    assert.equal(last.host, `127.0.0.1:${u.local.port}`, "the instance's DNS-rebinding guard sees its own host, not the page's");
    assert.equal(last["x-ticket-token"], u.local.key);
    assert.equal(last.cookie, undefined);
    assert.equal(last.origin, undefined);
  } finally {
    await u.close();
  }
});

test("an unpaired request and a script holding the key are passed on to no instance, and neither runs ssh", async () => {
  const u = await ui([WORK, PERSONAL]);
  try {
    for (const name of ["work", "personal"]) {
      assert.equal((await fetch(`${u.base}/c/${name}/api/queue`)).status, 401, name);
      const script = await fetch(`${u.base}/c/${name}/api/queue`, { headers: { "x-ticket-token": u.local.key } });
      assert.equal(script.status, 403, name);
      assert.match((await script.json() as { error: string }).error, /only a paired browser is passed on to an instance/);
    }
    assert.equal(u.local.seen.length, 0, "this machine's instance was sent nothing");
    assert.equal(u.ssh.ran.length, 0, "no ssh for a request that is not passed on");
    const cookie = await pairedCookie(u.base, u.local.key);
    const unknown = await fetch(`${u.base}/c/gone/api/queue`, { headers: { cookie } });
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json() as { error: string }).error, /no connection gone/);
  } finally {
    await u.close();
  }
});

test("another host, a write from another origin, and an encoded path out of the allowlist are refused before any instance is called", async () => {
  const u = await ui([WORK]);
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    // fetch sets Host itself, so a DNS-rebound name is sent with node:http.
    const rebound = await new Promise<{ status: number; body: string }>((done, fail) => {
      const req = httpRequest(`${u.base}/c/work/api/queue`, { headers: { cookie, host: "evil.example" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", fail);
      req.end();
    });
    assert.equal(rebound.status, 403);
    assert.match(rebound.body, /answers only to its own host/);
    const crossSite = await fetch(`${u.base}/c/work/api/paused`, { method: "POST", headers: { cookie, origin: "https://evil.example" }, body: "{}" });
    assert.equal(crossSite.status, 403);
    assert.match((await crossSite.json() as { error: string }).error, /a write from another origin/);
    const escaped = await fetch(`${u.base}/c/work/api/queue/NBF-1/%2e%2e/%2e%2e/pair-code`, { method: "POST", headers: { cookie }, body: "{}" });
    assert.equal(escaped.status, 403);
    assert.equal(u.local.seen.length, 0, "this machine's instance was sent nothing");
  } finally {
    await u.close();
  }
});

test("a paired browser's call to an ssh connection carries that instance's key, which reaches no command line and no answer", async () => {
  const u = await ui([WORK, PERSONAL]);
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const viewed = await fetch(`${u.base}/c/personal/api/queue`, { headers: { cookie } });
    assert.equal(viewed.status, 200);
    assert.equal((await viewed.text()).includes(REMOTE_KEY), false);
    assert.deepEqual(u.forwarded, [{ path: "/api/queue", key: REMOTE_KEY, host: "127.0.0.1:4747" }]);
    assert.equal(u.ssh.ran.flat().join(" ").includes(REMOTE_KEY), false, "the remote's key is on no command line");
  } finally {
    await u.close();
  }
});

test("a connection that cannot be reached answers its reason, and every other connection keeps answering", async () => {
  const u = await ui([WORK, PERSONAL], { sshFails: true });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const down = await fetch(`${u.base}/c/personal/api/queue`, { headers: { cookie } });
    assert.equal(down.status, 502);
    assert.deepEqual(await down.json(), { error: "cannot reach personal over SSH: agents: Permission denied (publickey)." });
    assert.equal((await fetch(`${u.base}/c/work/api/queue`, { headers: { cookie } })).status, 200);
  } finally {
    await u.close();
  }
});

test("the page is told each connection's name and how it is reached, never its target, address or key file, and why a file was refused", async () => {
  const lab: Connection = { name: "lab", kind: "https", origin: "https://agents.example.ts.net", keyFile: "/keys/lab" };
  const u = await ui([WORK, PERSONAL, lab], { refusal: null });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const text = await (await fetch(`${u.base}/api/connections`, { headers: { cookie } })).text();
    assert.deepEqual(JSON.parse(text), { connections: [{ name: "work", kind: "local" }, { name: "personal", kind: "ssh" }, { name: "lab", kind: "https" }], refusal: null });
    for (const secret of ["agents", "example.ts.net", "/keys/lab"]) assert.equal(text.includes(secret), false, secret);
  } finally {
    await u.close();
  }
  const empty = readConnections(tmpDir("ticket-ui-no-connections-"));
  const implicit = await ui(empty.connections, { refusal: "connections.json is refused, so only this machine's instance is shown: it is not valid JSON" });
  try {
    const cookie = await pairedCookie(implicit.base, implicit.local.key);
    assert.deepEqual(await (await fetch(`${implicit.base}/api/connections`, { headers: { cookie } })).json(),
      { connections: [{ name: "local", kind: "local" }], refusal: "connections.json is refused, so only this machine's instance is shown: it is not valid JSON" });
    assert.equal((await fetch(`${implicit.base}/c/local/api/queue`, { headers: { cookie } })).status, 200, "with no connections file the page shows this machine's instance");
  } finally {
    await implicit.close();
  }
});

test("a request is paired by the board key in its header, or by a session the service opened in its cookie, and never by the key as a cookie", () => {
  const KEY = "a".repeat(48);
  const sessions = { holds: (value: string) => value === "s".repeat(48) };
  assert.equal(pairedBy({ headers: { "x-ticket-token": KEY } }, KEY, sessions), "key");
  assert.equal(pairedBy({ headers: { cookie: `x=1; ticket_session=${"s".repeat(48)}` } }, KEY, sessions), "browser");
  assert.equal(pairedBy({ headers: { cookie: `ticket_session=${KEY}` } }, KEY, sessions), null, "the key never pairs a browser");
  assert.equal(pairedBy({ headers: { "x-ticket-token": "wrong", cookie: `ticket_session=${"s".repeat(48)}` } }, KEY, sessions), null, "a header, once sent, decides");
  assert.equal(pairedBy({ headers: {} }, KEY, sessions), null);
});

test("the page's logic is served as JavaScript the browser can import, and it is the tested module, types stripped", async () => {
  const script = boardViewScript();
  assert.doesNotMatch(script, /:\s*readonly ViewTicket\[\]|export type /, "no type annotation reaches the browser");
  const file = join(tmpDir("ticket-board-view-"), "board-view.mjs");
  writeFileSync(file, script);
  const view = await import(pathToFileURL(file).href);
  const tickets = [{ key: "A-1", title: "x", status: "Backlog", statusOrder: 0, priority: 2, project: "P" }];
  assert.deepEqual(view.visibleTickets(tickets, { projects: new Set(["P"]) }).map((t: { key: string }) => t.key), ["A-1"], "the browser's copy filters as the tested one does");
});

test("the label filters are served as JavaScript the browser can import, types stripped, and filter as the tested module does", async () => {
  const script = labelFiltersScript();
  assert.doesNotMatch(script, /export type |: readonly Labelled\[\]/, "no type annotation reaches the browser");
  const file = join(tmpDir("ticket-label-filters-"), "label-filters.mjs");
  writeFileSync(file, script);
  const filters = await import(pathToFileURL(file).href);
  const tickets = [{ key: "A-1", labels: [{ name: "Fleet", group: "Goal" }] }, { key: "A-2", labels: [] }];
  assert.deepEqual(filters.withLabels(tickets, new Set([filters.labelChoice("Goal", "Fleet")])).map((t: { key: string }) => t.key), ["A-1"]);
});

test("a paired browser gets both of the page's modules, and a ticket's labels reach it through a connection with nothing new passed on", async () => {
  const u = await ui([WORK]);
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    for (const path of ["/board-view.js", "/label-filters.js"]) {
      const served = await fetch(`${u.base}${path}`, { headers: { cookie } });
      assert.equal(served.status, 200, path);
      assert.match(String(served.headers.get("content-type")), /^text\/javascript/, path);
    }
    assert.equal((await fetch(`${u.base}/label-filters.js`)).status, 401, "an unpaired browser gets no module");
    const tickets = await (await fetch(`${u.base}/c/work/api/tickets`, { headers: { cookie } })).json() as { labels?: unknown }[];
    assert.deepEqual(tickets[0].labels, LABELS, "the Pick route the page already reads carries them");
  } finally {
    await u.close();
  }
});

/** The page on the tailnet: its MagicDNS name is what `name` answers, on the tailnet's port 9443, in front of no connections. */
async function tailnetPage(name: () => Promise<string | null>) {
  const stateDir = tmpDir("ticket-ui-tailnet-");
  const key = boardKey(boardKeyPath(stateDir));
  const sessions = browserSessions(browserSessionsPath(stateDir), () => 7);
  const read: ConnectionsRead = { connections: [], refusal: null, migrated: null };
  const connections = createConnections([], { local: { port: 4747, keyPath: boardKeyPath(stateDir) } });
  const served = await listen((port) => createUi({ port, key, sessions, read, connections, tailnet: { port: 9443, name } }).handle);
  return { ...served, key };
}

/** A request to the page with `host` as its Host header: node:http, since fetch sets its own. */
function sendAs(base: string, host: string, path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; setCookie: string }>((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers: { host, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, setCookie: String(res.headers["set-cookie"] ?? "") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("with the page on the tailnet, the machine's name at the tailnet port is answered, and any other Host is refused", async () => {
  const u = await tailnetPage(async () => "agents.tail1234.ts.net");
  try {
    assert.equal((await sendAs(u.base, "agents.tail1234.ts.net:9443", "/")).status, 200, "the tailnet name at 9443 gets the pairing page");
    for (const host of ["agents.tail1234.ts.net:4748", "agents.tail1234.ts.net", "other.tail1234.ts.net:9443", "evil.example"]) {
      const rejected = await sendAs(u.base, host, "/");
      assert.equal(rejected.status, 403, host);
      assert.match(rejected.body, /answers only to its own host/);
    }
    assert.equal((await sendAs(u.base, `127.0.0.1:${u.port}`, "/")).status, 200, "the loopback Host still works");
  } finally {
    await u.close();
  }
});

test("while the name cannot be read, a tailnet Host is refused, and the name is asked only for a Host that is not the page's own loopback", async () => {
  let asked = 0;
  const u = await tailnetPage(async () => { asked++; return null; });
  try {
    await sendAs(u.base, `127.0.0.1:${u.port}`, "/");
    assert.equal(asked, 0, "the loopback Host asks for no name");
    assert.equal((await sendAs(u.base, "agents.tail1234.ts.net:9443", "/")).status, 403);
    assert.equal(asked, 1);
  } finally {
    await u.close();
  }
});

test("a write from the tailnet is allowed from its own origin, and refused from another", async () => {
  const u = await tailnetPage(async () => "agents.tail1234.ts.net");
  try {
    const own = await sendAs(u.base, "agents.tail1234.ts.net:9443", "/pair", { method: "POST", headers: { origin: "https://agents.tail1234.ts.net:9443", "content-type": "application/json" }, body: "{}" });
    assert.equal(own.status, 401, "the origin is its own, so only the pairing code refuses it");
    const cross = await sendAs(u.base, "agents.tail1234.ts.net:9443", "/pair", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    assert.equal(cross.status, 403);
    assert.match(cross.body, /a write from another origin/);
  } finally {
    await u.close();
  }
});

test("a code from ticket:pair pairs a browser over the tailnet, and the paired browser reaches the page there", async () => {
  const u = await tailnetPage(async () => "agents.tail1234.ts.net");
  try {
    const host = "agents.tail1234.ts.net:9443";
    const minted = await sendAs(u.base, host, "/api/pair-code", { method: "POST", headers: { "x-ticket-token": u.key } });
    assert.equal(minted.status, 200);
    const { code } = JSON.parse(minted.body) as { code: string };
    const paired = await sendAs(u.base, host, "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    assert.equal(paired.status, 200);
    const cookie = paired.setCookie.split(";")[0];
    assert.match(cookie, /^ticket_session=/);
    assert.equal((await sendAs(u.base, host, "/api/connections", { headers: { cookie } })).status, 200);
  } finally {
    await u.close();
  }
});
