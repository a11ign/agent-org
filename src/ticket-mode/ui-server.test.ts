// no-token: gh -- the instance is a real `createBoard` on 127.0.0.1 with Linear and the pool injected; ssh is a fake runner
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeExposure } from "../plugins/fakes/exposure.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { browserSessions, browserSessionsPath } from "./browser-sessions.ts";
import { createConnections, readConnections, type Connection, type ConnectionsRead } from "./connections.ts";
import { createRemotes, type Runner } from "./remote.ts";
import { createLastKnown, lastKnownDir } from "./last-known.ts";
import { httpForward, type Forward } from "./remote-proxy.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createUi, endedPage, isEnded, missingBuildPage, pairedBy, sameTerminal } from "./ui-server.ts";
import type { TerminalMint } from "./terminal-pair.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

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
async function instance(mintTerminal?: () => Promise<TerminalMint>, { queue, terminal = "http://127.0.0.1:7318/?ws={workspace}" }: { queue?: object; terminal?: string } = {}) {
  const stateDir = tmpDir("ticket-ui-state-");
  if (queue !== undefined) writeFileSync(join(stateDir, "queue.json"), JSON.stringify(queue));
  const key = boardKey(boardKeyPath(stateDir));
  const seen: IncomingMessage["headers"][] = [];
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  const source: TicketSource = createFakeTracker([{ ...ticket("NBF-1"), labels: LABELS }]);
  const served = await listen((port) => {
    const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir, tickets: { port, terminal } });
    const board = createBoard({ settings, source, codeHost: createFakeCodeHost(), key, queuePath: join(stateDir, "queue.json"), choicePath: join(stateDir, "choice.json"), pool, now: () => 7, mintTerminal });
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
async function ui(list: readonly Connection[], { refusal = null, sshFails = false, mintTerminal, queue, terminal, lookupFails = false, uiBuilds, remembering }: { refusal?: string | null; sshFails?: boolean;
  mintTerminal?: () => Promise<TerminalMint>; queue?: object; terminal?: string; lookupFails?: boolean; uiBuilds?: readonly string[]; remembering?: { stateDir: string; down: { value: boolean } } } = {}) {
  const local = await instance(mintTerminal, { queue, terminal });
  const ssh = sshRunner(sshFails);
  const forwarded: { path: string; key: string; host: string }[] = [];
  const read: ConnectionsRead = { connections: list, refusal, migrated: null };
  const remotes = createRemotes(list.filter((c) => c.kind === "ssh") as never, { runner: ssh.runner, log: () => {}, schedule: () => () => {} });
  const connections = createConnections(list, { local: { port: local.port, keyPath: boardKeyPath(local.stateDir) }, remotes });
  const forward: Forward = async (target, request) => {
    // A lookup the instance cannot answer for is a failed one, which a worker link still redirects past (A11-129).
    if (lookupFails && request.path === "/api/terminal-run") return { status: 500, body: "{}" };
    if ("origin" in target.address) return httpForward(target, request);
    if (remembering?.down.value) throw new Error("socket hang up");
    forwarded.push({ path: request.path, key: target.key, host: target.host });
    return { status: 200, body: JSON.stringify({ entries: [], max: 1, paused: false }) };
  };
  const sessions = browserSessions(browserSessionsPath(local.stateDir), () => 7);
  const served = await listen((port) => createUi({ port, key: local.key, sessions, read, connections, forward, uiBuilds, ...(remembering === undefined ? {} : { lastKnown: createLastKnown(lastKnownDir(remembering.stateDir)) }) }).handle);
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
  const u = await ui([WORK], { uiBuilds: [builtUi().root] });
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
    assert.match(await page.text(), /<title>Next root<\/title>/, "a paired browser's / is the built UI");
    assert.equal((await pairWith(u.base, code)).status, 401, "a code pairs one browser");
  } finally {
    await u.close();
  }
});

test("A11-202: the pairing page takes a paired browser back to the address it was asked for, with its query and anchor", async () => {
  const u = await ui([WORK], { uiBuilds: [builtUi().root] });
  try {
    const page = await (await fetch(`${u.base}/runs/A11-1?connection=work`)).text();
    assert.match(page, /<title>Pair this browser<\/title>/);
    assert.ok(page.includes("location.replace(location.pathname + location.search + location.hash)"), "the page returns to its own address and not to /");
    assert.equal(page.includes('location.replace("/")'), false);
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

test("A11-195: an SSH connection read once and then not reachable answers 502 with its sentence and the last read, and this machine's own failure carries none", async () => {
  const down = { value: false };
  const u = await ui([WORK, PERSONAL], { remembering: { stateDir: tmpDir("ticket-ui-last-known-"), down } });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const live = await fetch(`${u.base}/c/personal/api/queue`, { headers: { cookie } });
    assert.equal(live.status, 200);
    down.value = true;
    const gone = await fetch(`${u.base}/c/personal/api/queue`, { headers: { cookie } });
    assert.equal(gone.status, 502);
    const body = await gone.json() as { error: string; lastKnown: { value: unknown; readAt: string } };
    assert.equal(body.error, "cannot reach personal's instance over SSH: socket hang up. Is agent-org ticket:serve running there?");
    assert.deepEqual(body.lastKnown.value, { entries: [], max: 1, paused: false });
    assert.ok(Number.isFinite(Date.parse(body.lastKnown.readAt)));
    const unread = await fetch(`${u.base}/c/personal/api/tickets`, { headers: { cookie } });
    assert.equal(unread.status, 502);
    assert.equal("lastKnown" in await unread.json(), false, "a path nothing was read from has none");
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

test("a ticket's labels reach a paired browser through a connection, with nothing new passed on", async () => {
  const u = await ui([WORK]);
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const tickets = await (await fetch(`${u.base}/c/work/api/tickets`, { headers: { cookie } })).json() as { labels?: unknown }[];
    assert.deepEqual(tickets[0].labels, LABELS, "the Pick route the page already reads carries them");
  } finally {
    await u.close();
  }
});

/** The page on the tailnet: its MagicDNS name is what `name` answers through the exposure, on the tailnet's port 9443, in front of no connections. */
async function tailnetPage(name: () => Promise<string | null>) {
  const named = Object.assign(createFakeExposure("placeholder", { ui: 9443, terminal: 9444 }), { machineName: name, hosts: ({ name: machine, port }: { name: string; port: number }) => [`${machine}:${port}`], origins: ({ name: machine, port }: { name: string; port: number }) => [`https://${machine}:${port}`] });
  return pageOver(named);
}

/** The page in front of no connections, served by `exposure`. */
async function pageOver(exposure: ReturnType<typeof createFakeExposure>) {
  const stateDir = tmpDir("ticket-ui-exposed-");
  const key = boardKey(boardKeyPath(stateDir));
  const sessions = browserSessions(browserSessionsPath(stateDir), () => 7);
  const read: ConnectionsRead = { connections: [], refusal: null, migrated: null };
  const connections = createConnections([], { local: { port: 4747, keyPath: boardKeyPath(stateDir) } });
  const served = await listen((port) => createUi({ port, key, sessions, read, connections, exposure }).handle);
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

const PLAIN = "http://127.0.0.1:7318/?ws=w1";

test("a paired browser that follows a worker link is redirected to the plain link with the worker's pairing code, and no store or referrer keeps it", async () => {
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const u = await ui([WORK], { mintTerminal: async () => ({ code: "654321" }) });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const res = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent(PLAIN)}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "http://127.0.0.1:7318/?ws=w1&pair=654321");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.ok(!logged.join("").includes("654321"), "the code is not logged");
  } finally {
    process.stderr.write = write;
    await u.close();
  }
});

test("a worker link whose terminal cannot mint a code redirects to the plain link, unchanged", async () => {
  const u = await ui([WORK], { mintTerminal: async () => ({ code: null, note: "the worker terminal did not answer on 127.0.0.1:7318" }) });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const res = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent(PLAIN)}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), PLAIN, "the link is sent as it was, and the browser pairs by hand");
  } finally {
    await u.close();
  }
});

/** The terminal template with the pane too, and the run whose terminal a link names: a finished new-ticket request on `w1:p1`. */
const TERMINAL_WITH_PANE = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const ENDED_QUEUE = { entries: [], max: 1, paused: true, writers: [{ id: "w1", request: "r", mode: "grill", form: {}, phase: "finished", queuedAt: 1, finishedAt: 5,
  failure: "its agent exited: its herdr workspace is gone", drafts: [], rejected: [], workspace: "w1", pane: "w1:p1" }] };

test("A11-129: a worker link whose run has ended answers a page that says so, with a link to the run and no code minted; a link to a live run still redirects with its code", async () => {
  let asked = 0;
  const u = await ui([WORK], { mintTerminal: async () => { asked += 1; return { code: "654321" }; }, queue: ENDED_QUEUE, terminal: TERMINAL_WITH_PANE });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const ended = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal")}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(ended.status, 200, "no redirect to a terminal that is gone");
    assert.equal(ended.headers.get("cache-control"), "no-store");
    const page = await ended.text();
    assert.match(page, /<h1>This run ended: failed<\/h1>/);
    assert.match(page, /its agent exited: its herdr workspace is gone/);
    assert.match(page, /href="\/tickets\?connection=work"/, "a writer run's request cards are on the Tickets page, which opens with the connection chosen");
    assert.equal(asked, 0, "no code is minted for a run that is over");
    const live = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent("http://127.0.0.1:7318/?ws=w9&pane=w9%3Ap1&view=terminal")}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(live.status, 302, "a link no run holds still redirects, as it always has");
    assert.equal(live.headers.get("location"), "http://127.0.0.1:7318/?ws=w9&pane=w9%3Ap1&view=terminal&pair=654321");
    assert.equal(asked, 1);
  } finally {
    await u.close();
  }
});

test("A11-129: a worker link whose run lookup fails still redirects, as it did before the lookup existed", async () => {
  const u = await ui([WORK], { queue: ENDED_QUEUE, terminal: TERMINAL_WITH_PANE, lookupFails: true, mintTerminal: async () => ({ code: null, note: "the worker terminal did not answer" }) });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const link = "http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal";
    const res = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent(link)}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302, "a failed lookup never blocks a good link");
    assert.equal(res.headers.get("location"), link, "the link goes out as it was, since no code could be minted either");
  } finally {
    await u.close();
  }
});

test("A11-129: only an answer naming an ended run ends a worker link, and the ended page shows each value as text, never as markup", () => {
  assert.equal(isEnded({ state: "live" }), false);
  assert.equal(isEnded({ state: "unknown" }), false);
  assert.equal(isEnded({ state: "ended", outcome: "weird", run: "w1" }), false, "an outcome the page does not name is not an ended run");
  assert.equal(isEnded(null), false);
  assert.equal(isEnded({ state: "ended", outcome: "finished", run: "NBF-1", kind: "ticket" }), true);
  const page = endedPage("a<b", { state: "ended", outcome: "finished", run: "NBF-1", kind: "ticket", reason: "<script>alert(1)</script>" });
  assert.match(page, /<h1>This run ended: finished<\/h1>/);
  assert.doesNotMatch(page, /<script>/, "the reason is text");
  assert.match(page, /&#60;script&#62;/);
  assert.match(page, /href="\/runs\/NBF-1\?connection=a%3Cb"/, "a ticket run links to its own page, with its connection chosen");
  assert.match(endedPage("work", { state: "ended", outcome: "failed", run: "p1", kind: "publish" }), /href="\/\?connection=work"/, "a publish run has no page of its own, so the board opens at its front page");
});

test("a worker link is followed only for a paired browser, and a link that is not this connection's worker terminal is refused before any code is asked for", async () => {
  let asked = 0;
  const u = await ui([WORK], { mintTerminal: async () => { asked += 1; return { code: "654321" }; } });
  try {
    const key = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent(PLAIN)}`, { headers: { "x-ticket-token": u.local.key }, redirect: "manual" });
    assert.equal(key.status, 403, "a script holding the key is not passed on");
    const cookie = await pairedCookie(u.base, u.local.key);
    for (const link of ["https://evil.example/?ws=w1", "http://127.0.0.1:9999/?ws=w1", "http://127.0.0.1:7318/?ws=w1&pane=w1", "http://127.0.0.1:7318/other?ws=w1", "javascript:alert(1)//?ws=w1", "http://127.0.0.1:7318/?ws="]) {
      const res = await fetch(`${u.base}/c/work/terminal?link=${encodeURIComponent(link)}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(res.status, 400, link);
      assert.equal(res.headers.get("location"), null, `${link}: no redirect`);
    }
    assert.equal((await fetch(`${u.base}/c/work/terminal`, { headers: { cookie }, redirect: "manual" })).status, 400, "a link is named");
    assert.equal((await fetch(`${u.base}/c/nobody/terminal?link=${encodeURIComponent(PLAIN)}`, { headers: { cookie }, redirect: "manual" })).status, 404);
    assert.equal(asked, 0, "no code is asked for on a refused link");
  } finally {
    await u.close();
  }
});

test("a paired browser cannot ask for a worker's code by calling the route itself: only a worker link gets one", async () => {
  const u = await ui([WORK], { mintTerminal: async () => ({ code: "654321" }) });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    const direct = await fetch(`${u.base}/c/work/api/terminal-pair`, { method: "POST", headers: { cookie, origin: u.base } });
    assert.equal(direct.status, 403);
    assert.equal((await direct.text()).includes("654321"), false);
  } finally {
    await u.close();
  }
});

test("a worker link's address is taken only when it is the connection's own terminal, with the same names and literal values", () => {
  const template = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
  assert.equal(sameTerminal("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal", template), "http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal");
  assert.equal(sameTerminal("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=other", template), null, "a literal value that differs");
  assert.equal(sameTerminal("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal&pair=1", template), null, "a name the template lacks");
  assert.equal(sameTerminal("http://localhost:7318/?ws=w1&pane=p&view=terminal", template), null, "another origin");
  assert.equal(sameTerminal("https://127.0.0.1:7318/?ws=w1&pane=p&view=terminal", template), null, "another scheme");
});

test("A11-162: a page whose exposure serves nothing (local) answers its loopback alone, and never asks the exposure for a name", async () => {
  const exposure = createFakeExposure();
  const u = await pageOver(exposure);
  try {
    assert.equal((await sendAs(u.base, `127.0.0.1:${u.port}`, "/")).status, 200);
    assert.equal((await sendAs(u.base, "agents.tail1234.ts.net:9443", "/")).status, 403, "a tailnet Host is not this page's");
    assert.deepEqual(exposure.calls, [], "and no name was asked of an exposure that serves nothing");
  } finally {
    await u.close();
  }
});

/** A built UI in a fresh folder, as Astro writes it under `base: "/"`, beside a file that is not the build's. */
function builtUi() {
  const base = tmpDir("ui-build-");
  const root = join(base, "build");
  const files: Record<string, string> = {
    "index.html": "<!doctype html><title>Next root</title>", "settings/index.html": "<!doctype html><title>Next settings</title>", "runs/index.html": "<!doctype html><title>Next runs</title>",
    "_astro/app.abc123.js": "console.log('app');", "favicon.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  writeFileSync(join(base, "package.json"), "{\"name\": \"not the build's\"}");
  return { base, root };
}

/** What a served file's headers say of its type and how long it is kept. */
const typeAndCache = (response: Response) => ({ type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), sniff: response.headers.get("x-content-type-options") });

/** The page's service over a built UI, and the cookie of a browser paired with it. */
async function pairedOverBuild(build = builtUi(), list: readonly Connection[] = [WORK]) {
  const u = await ui(list, { uiBuilds: [build.root] });
  return { ...build, u, cookie: await pairedCookie(u.base, u.local.key) };
}

/** A GET or HEAD over node:http, which keeps the path as written (fetch normalises `..`) and takes a Host of its own. */
function rawRequest(base: string, path: string, { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("A11-202: a paired browser is served the built page at / with no-cache and the page policy, and a route falls back to the page above it", async () => {
  const { u, cookie } = await pairedOverBuild();
  try {
    const page = await fetch(`${u.base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<!doctype html><title>Next root</title>");
    assert.deepEqual(typeAndCache(page), { type: "text/html; charset=utf-8", cache: "no-cache", sniff: "nosniff" });
    assert.match(String(page.headers.get("content-security-policy")), /script-src 'self' 'unsafe-inline'/);
    for (const [path, title] of [["/settings/", "Next settings"], ["/settings", "Next settings"], ["/settings/deep/route", "Next settings"], ["/runs/A11-1", "Next runs"], ["/boards/12", "Next root"]]) {
      assert.match(await (await fetch(`${u.base}${path}`, { headers: { cookie } })).text(), new RegExp(`<title>${title}</title>`), path);
    }
    const head = await rawRequest(u.base, "/", { method: "HEAD", headers: { cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers["cache-control"], "no-cache");
    assert.equal(head.body, "");
  } finally {
    await u.close();
  }
});

test("A11-202: /next and what is under it is redirected to the same address without it, with its query, and never to another origin", async () => {
  const { u, cookie } = await pairedOverBuild();
  try {
    for (const [from, to] of [["/next", "/"], ["/next/", "/"], ["/next?connection=x", "/?connection=x"], ["/next/tickets", "/tickets"], ["/next/runs/A11-1?connection=x", "/runs/A11-1?connection=x"],
      ["/next/settings/plugins", "/settings/plugins"], ["/next//evil.example", "/evil.example"], ["/next/%5Cevil.example", "/%5Cevil.example"]]) {
      const moved = await fetch(`${u.base}${from}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(moved.status, 302, from);
      assert.equal(moved.headers.get("location"), to, from);
      assert.equal(moved.headers.get("cache-control"), "no-store", `${from}: a redirect is not kept past the next release`);
    }
    const head = await rawRequest(u.base, "/next/runs", { method: "HEAD", headers: { cookie } });
    assert.deepEqual([head.status, head.headers.location], [302, "/runs"]);
    assert.equal((await fetch(`${u.base}/nextfoo`, { headers: { cookie }, redirect: "manual" })).status, 200, "/nextfoo is not under /next: it is a route like any other, answered with the root page");
    const post = await fetch(`${u.base}/next/tickets`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(post.status, 404, "only a read moves");
  } finally {
    await u.close();
  }
});

test("A11-202: /next is redirected with no build too, and a call is never redirected or answered with a page", async () => {
  const empty = tmpDir("ui-next-empty-");
  const u = await ui([WORK], { uiBuilds: [join(empty, "ui-build")] });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    assert.equal((await fetch(`${u.base}/next/runs`, { headers: { cookie }, redirect: "manual" })).headers.get("location"), "/runs");
    for (const path of ["/api/next", "/api/nothing", "/c/work/nothing", "/c/work/api"]) {
      const answer = await fetch(`${u.base}${path}`, { headers: { cookie } });
      assert.equal(answer.status, 404, path);
      assert.match(await answer.text(), /no route GET /, `${path}: the plain no-route answer, not the missing-build page`);
    }
  } finally {
    await u.close();
  }
});

test("A11-190: a hashed asset is cached for a year, an unhashed file is not, and a missing asset is a 404 and never a page", async () => {
  const { u, cookie } = await pairedOverBuild();
  try {
    const asset = await fetch(`${u.base}/_astro/app.abc123.js`, { headers: { cookie } });
    assert.deepEqual(typeAndCache(asset), { type: "text/javascript; charset=utf-8", cache: "public, max-age=31536000, immutable", sniff: "nosniff" });
    assert.equal(asset.headers.get("content-security-policy"), null, "a script is not a page");
    assert.deepEqual([asset.status, await asset.text()], [200, "console.log('app');"]);
    const icon = await fetch(`${u.base}/favicon.svg`, { headers: { cookie } });
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
    assert.equal(icon.headers.get("cache-control"), "no-cache", "its name does not change when its content does");
    for (const path of ["/_astro/gone.js", "/_astro/", "/missing.png", "/board-view.js", "/label-filters.js"]) {
      const gone = await fetch(`${u.base}${path}`, { headers: { cookie } });
      assert.equal(gone.status, 404, path);
      assert.equal(gone.headers.get("content-type"), "text/plain; charset=utf-8", path);
      assert.equal(await gone.text(), "not found", path);
    }
  } finally {
    await u.close();
  }
});

test("A11-190: a path out of the build, plain or encoded, and a link out of it, is a 404 that holds none of the file", async () => {
  const { base, root } = builtUi();
  symlinkSync(join(base, "package.json"), join(root, "link.json"));
  const u = await ui([WORK], { uiBuilds: [root] });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    for (const path of ["/%2e%2e/package.json", "/..%2fpackage.json", "/..%2f..%2fpackage.json", "/_astro/..%2f..%2fpackage.json", "/link.json", "/a%00b"]) {
      const answer = await rawRequest(u.base, path, { headers: { cookie } });
      assert.equal(answer.status, 404, path);
      assert.equal(answer.body.includes("not the build's"), false, path);
    }
  } finally {
    await u.close();
  }
});

test("A11-202: the pairing guards every page: an unpaired browser gets the pairing page, an unpaired asset or call gets 401, the key and a paired session are served, another Host is refused", async () => {
  const { root } = builtUi();
  const u = await ui([WORK], { uiBuilds: [root] });
  try {
    for (const path of ["/", "/tickets", "/runs/A11-1", "/settings/plugins", "/next/tickets"]) {
      const unpaired = await fetch(`${u.base}${path}`);
      assert.equal(unpaired.status, 200, path);
      assert.match(await unpaired.text(), /<title>Pair this browser<\/title>/, path);
    }
    for (const path of ["/_astro/app.abc123.js", "/favicon.svg", "/board-view.js", "/api/connections", "/c/work/api/queue", "/api/nothing"]) {
      assert.equal((await fetch(`${u.base}${path}`)).status, 401, `${path}: nothing but a page is shown before pairing`);
    }
    assert.equal((await fetch(`${u.base}/_astro/app.abc123.js`, { headers: { cookie: "ticket_session=nope" } })).status, 401);
    assert.match(await (await fetch(`${u.base}/`, { headers: { "x-ticket-token": "wrong" } })).text(), /<title>Pair this browser<\/title>/, "a wrong key is not paired");
    assert.equal((await rawRequest(u.base, "/", { method: "HEAD" })).status, 401, "a HEAD is not a pairing page");
    const keyed = await fetch(`${u.base}/`, { headers: { "x-ticket-token": u.local.key } });
    assert.match(await keyed.text(), /<title>Next root<\/title>/, "the board key is served the page");
    const cookie = await pairedCookie(u.base, u.local.key);
    assert.match(await (await fetch(`${u.base}/`, { headers: { cookie } })).text(), /<title>Next root<\/title>/);
    const rebound = await rawRequest(u.base, "/", { headers: { cookie, host: "evil.example" } });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.body.includes("Next root"), false);
    const post = await fetch(`${u.base}/`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(post.status, 404, "only a read is a page");
  } finally {
    await u.close();
  }
});

test("A11-202: with the same paired session, the page and a remote instance's calls are both answered, through the routes the board uses", async () => {
  const { u, cookie } = await pairedOverBuild(builtUi(), [WORK, PERSONAL]);
  try {
    assert.match(await (await fetch(`${u.base}/`, { headers: { cookie } })).text(), /<title>Next root<\/title>/);
    const list = await (await fetch(`${u.base}/api/connections`, { headers: { cookie } })).json() as { connections: { name: string }[] };
    assert.deepEqual(list.connections.map(({ name }) => name), ["work", "personal"]);
    const remote = await fetch(`${u.base}/c/personal/api/queue`, { headers: { cookie } });
    assert.equal(remote.status, 200);
    assert.deepEqual(u.forwarded, [{ path: "/api/queue", key: REMOTE_KEY, host: "127.0.0.1:4747" }], "the remote instance's own key went on, not the browser's session");
    assert.equal((await fetch(`${u.base}/_astro/app.abc123.js`, { headers: { cookie } })).status, 200);
    assert.equal(u.ssh.ran.flat().join(" ").includes(REMOTE_KEY), false);
  } finally {
    await u.close();
  }
});

test("A11-202: with no build, every page answers a plain 503 page that says the build is missing and how to get it, and the instance calls still answer", async () => {
  const empty = tmpDir("ui-next-empty-");
  mkdirSync(join(empty, "ui-build"));
  const candidates = [join(empty, "ui-build"), join(empty, "ui", "dist")];
  const u = await ui([WORK], { uiBuilds: candidates });
  try {
    const cookie = await pairedCookie(u.base, u.local.key);
    for (const path of ["/", "/tickets", "/settings/", "/runs/A11-1", "/_astro/app.abc123.js"]) {
      const answer = await fetch(`${u.base}${path}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(answer.status, 503, path);
      assert.equal(answer.headers.get("content-type"), "text/html; charset=utf-8", path);
      assert.equal(answer.headers.get("cache-control"), "no-store", path);
      assert.equal(answer.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'", path);
      const text = await answer.text();
      assert.match(text, /The UI build is missing/);
      assert.match(text, /pnpm ui:build/);
      assert.match(text, /install\.sh/);
      assert.equal(text.includes(candidates[0]), true, "it names where it looked");
      assert.doesNotMatch(text, /\n\s+at |Error:|node_modules/, "no stack trace");
    }
    const list = await (await fetch(`${u.base}/api/connections`, { headers: { cookie } })).json() as { connections: { name: string }[] };
    assert.deepEqual(list.connections.map(({ name }) => name), ["work"], "the connections are answered with no build");
    assert.equal((await fetch(`${u.base}/c/work/api/tickets`, { headers: { cookie } })).status, 200, "so is a call to an instance");
    assert.match(await (await fetch(`${u.base}/`)).text(), /<title>Pair this browser<\/title>/, "an unpaired browser is still asked to pair first");
  } finally {
    await u.close();
  }
});

test("A11-190: a file that cannot be read is a plain 404, never a stack trace", { skip: process.getuid?.() === 0 && "root reads any file" }, async () => {
  const { base, root } = builtUi();
  chmodSync(join(root, "_astro", "app.abc123.js"), 0o000);
  const { u, cookie } = await pairedOverBuild({ base, root });
  try {
    const answer = await fetch(`${u.base}/_astro/app.abc123.js`, { headers: { cookie } });
    assert.equal(answer.status, 404);
    assert.equal(await answer.text(), "not found");
  } finally {
    await u.close();
  }
});

test("A11-190: the missing-build page shows each directory as text, never as markup", () => {
  const page = missingBuildPage(["/v/<b>x</b>&\"y", "/v/ui/dist"]);
  assert.match(page, /<code>\/v\/&#60;b&#62;x&#60;\/b&#62;&#38;&#34;y<\/code>/);
  assert.equal(page.includes("<b>"), false);
  assert.match(page, /<code>\/v\/ui\/dist<\/code>/);
});
