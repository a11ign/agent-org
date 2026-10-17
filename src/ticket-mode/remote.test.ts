// no-token: gh -- ssh is a fake runner that records argv and plays the tunnel; the one "remote board" is a server on 127.0.0.1 for a test's length
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { RemoteProfile } from "./profiles.ts";
import { createRemotes, forwardHeaders, httpForward, localTerminal, parseRemoteInfo, proxy, redact, terminalPort, tunnelArgv, Unreachable, type Exit, type Forward, type Link, type Runner } from "./remote.ts";

const KEY = "b".repeat(48);
const PERSONAL: RemoteProfile = { name: "personal", local: false, ssh: "agents", agentOrg: "agent-org" };
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const INFO = JSON.stringify({ port: 4747, key: KEY, terminal: TERMINAL });

type Tunnel = { argv: readonly string[]; stopped: boolean; drop(exit: Exit): void };

/** A runner that runs nothing: it records every argv, answers the info read with `info`, and hands each tunnel to the test to drop. */
function fakeRunner({ info = { code: 0, stdout: INFO, stderr: "" } as Exit & { stdout: string }, up = true, ports = [50001, 50002, 50003, 50004, 50005, 50006] } = {}) {
  const runs: (readonly string[])[] = [];
  const tunnels: Tunnel[] = [];
  const free = [...ports];
  const runner: Runner = {
    run: async (argv) => { runs.push(argv); return info; },
    start(argv) {
      let drop!: (exit: Exit) => void;
      const exited = new Promise<Exit>((done) => { drop = done; });
      const tunnel: Tunnel = { argv, stopped: false, drop };
      tunnels.push(tunnel);
      return { exited, stop: () => { tunnel.stopped = true; drop({ code: null, stderr: "" }); } };
    },
    freePort: async () => free.shift()!,
    listening: async () => up,
  };
  return { runner, runs, tunnels };
}

/** Timers the test fires by hand: what is scheduled, after how long, and whether it was cancelled. */
function fakeTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { timers, schedule };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function remotes(options: Parameters<typeof fakeRunner>[0] = {}, upMs?: number) {
  const fake = fakeRunner(options);
  const clock = fakeTimers();
  const logs: string[] = [];
  const made = createRemotes([PERSONAL], { runner: fake.runner, log: (line) => logs.push(line), schedule: clock.schedule, upMs });
  return { ...fake, ...clock, logs, remotes: made };
}

test("a remote is reached by reading its port, key and terminal over ssh once, then forwarding a free local port to each, with BatchMode and no TTY", async () => {
  const r = remotes();
  const link = await r.remotes.reach("personal");
  assert.deepEqual(link, { port: 4747, key: KEY, terminal: TERMINAL, local: 50001, terminalLocal: 50002 });
  assert.deepEqual(r.runs, [["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "agents", "agent-org ticket:remote-info"]]);
  assert.deepEqual(r.tunnels.map((t) => t.argv), [[
    "ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-L", "127.0.0.1:50001:127.0.0.1:4747", "-L", "127.0.0.1:50002:127.0.0.1:7318", "--", "agents",
  ]]);
  assert.equal(await r.remotes.reach("personal"), link, "an open tunnel is reused");
  assert.equal(r.runs.length + r.tunnels.length, 2, "and nothing more is run");
  const everything = [...r.runs.flat(), ...r.tunnels.flatMap((t) => t.argv), ...r.logs].join("\n");
  assert.equal(everything.includes(KEY), false, "the key is never on a command line or in a log");
});

test("a remote that serves no terminal, or one off its loopback, gets one forward only", () => {
  assert.deepEqual(tunnelArgv(PERSONAL, 50001, 4747, null).filter((part) => part.startsWith("127.0.0.1:")), ["127.0.0.1:50001:127.0.0.1:4747"]);
  assert.equal(terminalPort(null), null);
  assert.equal(terminalPort("http://desk.lan:7318/"), null);
});

test("a remote's terminal address is moved to the local forwarded port, and only when it is on the remote's own loopback", () => {
  assert.equal(terminalPort(TERMINAL), 7318);
  assert.equal(terminalPort("http://localhost/x"), 80);
  assert.equal(terminalPort("https://127.0.0.1?x"), 443);
  assert.equal(terminalPort("http://127.0.0.1.evil.example:7318/"), null, "a host that only starts with the loopback address is not it");
  assert.equal(localTerminal(TERMINAL, 50002), "http://127.0.0.1:50002/?ws={workspace}&pane={pane}&view=terminal");
  assert.equal(localTerminal("http://localhost:7318/{key}", 50002), "http://127.0.0.1:50002/{key}");
  assert.equal(localTerminal("http://desk.lan:7318/", 50002), "http://desk.lan:7318/");
  assert.equal(localTerminal(null, 50002), null);
});

test("a tunnel that drops is marked down with why, the reason is shown until it is opened again, and it is opened again later each time it fails", async () => {
  const r = remotes();
  await r.remotes.reach("personal");
  r.tunnels[0].drop({ code: 255, stderr: "Connection to agents closed by remote host.\n" });
  await settle();
  await assert.rejects(r.remotes.reach("personal"), (err: Error) => err instanceof Unreachable && err.message === "the tunnel dropped: Connection to agents closed by remote host.");
  assert.deepEqual(r.timers.map((t) => t.ms), [2000]);
  assert.match(r.logs.at(-1)!, /^ticket:serve: cannot reach personal over SSH: the tunnel dropped: .*Trying again in 2 s$/);
  r.timers[0].fn();
  await settle();
  await settle();
  const again = await r.remotes.reach("personal");
  assert.equal(again.local, 50003, "a new tunnel on a new port");
  assert.equal(r.runs.length, 2, "the key is read again for the new tunnel");
  r.tunnels[1].drop({ code: 255, stderr: "" });
  await settle();
  assert.deepEqual(r.timers.map((t) => t.ms), [2000, 2000], "an opened tunnel starts the wait over");
});

test("a remote that keeps failing is tried again later each time, up to a minute", async () => {
  const r = remotes({ info: { code: 255, stdout: "", stderr: "ssh: Could not resolve hostname agents: nodename nor servname provided\n" } });
  await assert.rejects(r.remotes.reach("personal"), /Could not resolve hostname agents/);
  for (let i = 0; i < 7; i++) {
    r.timers.at(-1)!.fn();
    await settle();
    await settle();
  }
  assert.deepEqual(r.timers.map((t) => t.ms), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(r.tunnels.length, 0, "no tunnel is started for a remote whose key cannot be read");
});

test("why a remote cannot be read is said in words a person can act on, and never quotes what holds the key", async () => {
  const cases: [Exit & { stdout: string }, RegExp][] = [
    [{ code: 255, stdout: "", stderr: "agents: Permission denied (publickey).\n" }, /^agents: Permission denied \(publickey\)\.$/],
    [{ code: 127, stdout: "", stderr: "zsh: command not found: agent-org" }, /not on the PATH of a non-interactive shell there: set agentOrg/],
    [{ code: null, stdout: "", stderr: "" }, /did not answer in time/],
    [{ code: 1, stdout: "", stderr: `ticket:remote-info: ${KEY} is odd\n` }, /^ticket:remote-info: \[redacted\] is odd$/],
    [{ code: 0, stdout: `oops ${KEY}`, stderr: "" }, /printed something that is not JSON/],
    [{ code: 0, stdout: JSON.stringify({ port: 4747, key: `${KEY}x`, terminal: null }), stderr: "" }, /gave no board key$/],
    [{ code: 0, stdout: JSON.stringify({ port: 0, key: KEY, terminal: null }), stderr: "" }, /gave no port$/],
  ];
  for (const [info, reason] of cases) {
    const r = remotes({ info });
    const err = await r.remotes.reach("personal").then(() => null, (e: Error) => e);
    assert.match(String(err?.message), reason, JSON.stringify(info));
    assert.equal([err?.message, ...r.logs].join("\n").includes(KEY), false, "the key is in no reason and no log");
  }
});

test("a tunnel that ends before it opens, or never opens, is a reason, and one that never opens is stopped", async () => {
  const early = remotes({ up: false });
  const reaching = early.remotes.reach("personal");
  await settle();
  early.tunnels[0].drop({ code: 255, stderr: "bind [127.0.0.1]:50001: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 50001\n" });
  await assert.rejects(reaching, /^Error: channel_setup_fwd_listener_tcpip: cannot listen to port: 50001$/);
  const never = remotes({ up: false }, 1);
  await assert.rejects(never.remotes.reach("personal"), /the tunnel did not open within 0 seconds/);
  assert.equal(never.tunnels[0].stopped, true);
});

test("close stops every tunnel and cancels every retry, and nothing is opened after it", async () => {
  const r = remotes();
  await r.remotes.reach("personal");
  r.remotes.close();
  assert.equal(r.tunnels[0].stopped, true);
  await settle();
  assert.equal(r.timers.length, 0, "a tunnel stopped by close is not opened again");
  await assert.rejects(r.remotes.reach("personal"), /the board is closing/);
  const down = remotes({ info: { code: 255, stdout: "", stderr: "x" } });
  await down.remotes.reach("personal").catch(() => {});
  down.remotes.close();
  assert.equal(down.timers[0].cancelled, true);
});

test("redact keeps the last line, cuts anything shaped like a key or a token, and stays short", () => {
  assert.equal(redact(`first\nsecond ${KEY} third\n\n`), "second [redacted] third");
  assert.equal(redact("ghp_" + "a1".repeat(18)), "[redacted]");
  assert.equal(redact("channel_setup_fwd_listener_tcpip: x"), "channel_setup_fwd_listener_tcpip: x", "a long word with no digit is not a key");
  assert.equal(redact("y ".repeat(400)).length, 300);
});

test("the remote board is sent its own host, the key and the JSON body, and never the browser's cookie or origin", async () => {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "ticket_session=remote" });
      res.end(JSON.stringify(req.url === "/api/config" ? { terminal: TERMINAL, max: 2 } : { entries: [], max: 2, paused: false }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const local = (server.address() as { port: number }).port;
  try {
    const link: Link = { port: 4747, key: KEY, terminal: TERMINAL, local, terminalLocal: 50002 };
    const fixed = { has: () => true, reach: async () => link, forget: () => {}, close: () => {} } as unknown as ReturnType<typeof createRemotes>;
    const posted = await proxy(fixed, "personal", { method: "POST", path: "/api/paused", body: JSON.stringify({ paused: false }) });
    assert.deepEqual(posted, [200, { entries: [], max: 2, paused: false }]);
    assert.equal(seen[0].headers.host, "127.0.0.1:4747", "the remote's DNS-rebinding guard sees its own host");
    assert.equal(seen[0].headers["x-ticket-token"], KEY);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers.origin, undefined);
    assert.equal(seen[0].body, "{\"paused\":false}");
    assert.equal(seen[0].method, "POST");
    const [, config] = await proxy(fixed, "personal", { method: "GET", path: "/api/config", body: null });
    assert.deepEqual(config, { terminal: "http://127.0.0.1:50002/?ws={workspace}&pane={pane}&view=terminal", max: 2 }, "Open terminal goes through the tunnel too");
    assert.equal(JSON.stringify([posted, config]).includes(KEY), false, "the key is in no answer");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  assert.deepEqual(Object.keys(forwardHeaders({ port: 1, key: KEY }, null)).sort(), ["accept", "host", "x-ticket-token"], "nothing else is sent");
});

test("an unreachable remote, a board that does not answer, a refused key and a pairing code are each answered in words, and the key is read again after a refusal", async () => {
  const reached: Link = { port: 4747, key: KEY, terminal: null, local: 1, terminalLocal: null };
  let forgot = 0;
  const failing = { has: () => true, reach: async () => { throw new Unreachable("agents: Permission denied (publickey)."); }, forget: () => {}, close: () => {} } as unknown as ReturnType<typeof createRemotes>;
  assert.deepEqual(await proxy(failing, "personal", { method: "GET", path: "/api/queue", body: null }), [502, { error: "cannot reach personal over SSH: agents: Permission denied (publickey)." }]);
  const up = { has: () => true, reach: async () => reached, forget: () => { forgot += 1; }, close: () => {} } as unknown as ReturnType<typeof createRemotes>;
  const silent: Forward = async () => { throw new Error("socket hang up"); };
  assert.deepEqual(await proxy(up, "personal", { method: "GET", path: "/api/queue", body: null }, silent),
    [502, { error: "cannot reach personal's board through SSH: socket hang up. Is agent-org ticket:serve running there?" }]);
  const refused: Forward = async () => ({ status: 401, body: "{\"error\":\"this browser is not paired\"}" });
  const [status, value] = await proxy(up, "personal", { method: "GET", path: "/api/queue", body: null }, refused);
  assert.equal(status, 502);
  assert.match((value as { error: string }).error, /^cannot reach personal over SSH: its board refused the key/);
  assert.equal(forgot, 1);
  let sent = 0;
  const counting: Forward = async () => { sent += 1; return { status: 200, body: "{}" }; };
  assert.deepEqual(await proxy(up, "personal", { method: "POST", path: "/api/pair-code", body: null }, counting), [403, { error: "another machine's board is not paired from here: only this board is" }]);
  assert.equal(sent, 0, "a pairing code for the remote is never asked for");
  assert.equal(typeof httpForward, "function");
});

test("parseRemoteInfo takes a port, a key and a terminal or null", () => {
  assert.deepEqual(parseRemoteInfo(JSON.stringify({ port: 4848, key: KEY, terminal: null })), { port: 4848, key: KEY, terminal: null });
  assert.throws(() => parseRemoteInfo(JSON.stringify({ port: 4848, key: KEY, terminal: 7 })), /terminal that is not an address/);
});
