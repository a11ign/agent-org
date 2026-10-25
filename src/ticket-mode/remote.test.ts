// no-token: gh -- ssh is a fake runner that records argv and plays the tunnel up, down or failing; nothing is run
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { SshConnection } from "./connections.ts";
import { createRemotes, localTerminal, parseRemoteInfo, processRunner, redact, terminalPort, tunnelArgv, Unreachable, type Exit, type Runner } from "./remote.ts";

const KEY = "b".repeat(48);
const PERSONAL: SshConnection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const INFO = JSON.stringify({ port: 4747, key: KEY, terminal: TERMINAL });
const SSH = ["-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

type Tunnel = { argv: readonly string[]; stopped: boolean; drop(exit: Exit): void };

/** A runner that runs nothing: it records every argv, answers the info read with `info`, and hands each tunnel to the test to drop. */
function fakeRunner({ info = { code: 0, stdout: INFO, stderr: "" } as Exit & { stdout: string }, up = true as boolean | (() => boolean) } = {}) {
  const runs: (readonly string[])[] = [];
  const tunnels: Tunnel[] = [];
  const removed: string[] = [];
  let ports = 50001;
  let sockets = 0;
  const runner: Runner = {
    run: async (argv) => { runs.push(argv); return info; },
    start(argv) {
      let drop!: (exit: Exit) => void;
      const exited = new Promise<Exit>((done) => { drop = done; });
      const tunnel: Tunnel = { argv, stopped: false, drop };
      tunnels.push(tunnel);
      return { exited, stop: () => { tunnel.stopped = true; drop({ code: null, stderr: "" }); } };
    },
    freePort: async () => ports++,
    privateSocket: () => { const path = `/private/s${++sockets}/board.sock`; return { path, remove: () => { removed.push(path); } }; },
    listening: async () => (typeof up === "function" ? up() : up),
  };
  return { runner, runs, tunnels, removed };
}

/** Timers the test fires by hand: what is scheduled, after how long, and whether it was cancelled, against a clock the test moves. */
function fakeTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const clock = { ms: 0 };
  const schedule = (fn: () => void, ms: number) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { timers, schedule, clock, now: () => clock.ms };
}

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** Open `r`'s tunnel, then drop it with `stderr` as ssh's last words, and let the drop be seen. */
async function openThenDrop(r: Pick<ReturnType<typeof remotes>, "remotes" | "tunnels">, stderr: string): Promise<void> {
  await r.remotes.reach("personal");
  r.tunnels[0].drop({ code: 255, stderr });
  await settle();
}

function remotes(options: Parameters<typeof fakeRunner>[0] = {}, upMs?: number) {
  const fake = fakeRunner(options);
  const clock = fakeTimers();
  const logs: string[] = [];
  const made = createRemotes([PERSONAL], { runner: fake.runner, log: (line) => logs.push(line), schedule: clock.schedule, now: clock.now, upMs });
  return { ...fake, ...clock, logs, remotes: made };
}

test("a remote is reached by reading its port, key and terminal over ssh once, then forwarding a private socket to the board and a port to its terminal", async () => {
  const r = remotes();
  const link = await r.remotes.reach("personal");
  assert.deepEqual(link, { port: 4747, key: KEY, terminal: TERMINAL, socket: "/private/s1/board.sock", terminalLocal: 50001 });
  assert.deepEqual(r.runs, [["ssh", ...SSH, "-o", "ClearAllForwardings=yes", "--", "agents", "agent-org ticket:remote-info"]]);
  assert.deepEqual(r.tunnels.map((t) => t.argv), [[
    "ssh", "-N", ...SSH, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "StreamLocalBindMask=0177",
    "-L", "/private/s1/board.sock:127.0.0.1:4747", "-L", "127.0.0.1:50001:127.0.0.1:7318", "--", "agents",
  ]]);
  assert.equal(await r.remotes.reach("personal"), link, "an open tunnel is reused");
  assert.equal(r.runs.length + r.tunnels.length, 2, "and nothing more is run");
  const everything = [...r.runs.flat(), ...r.tunnels.flatMap((t) => t.argv), ...r.logs].join("\n");
  assert.equal(everything.includes(KEY), false, "the key is never on a command line or in a log");
});

test("a remote that serves no terminal, or one off its loopback, gets the board's forward only", () => {
  assert.deepEqual(tunnelArgv(PERSONAL, "/s/board.sock", 4747, null).filter((_, i, all) => all[i - 1] === "-L"), ["/s/board.sock:127.0.0.1:4747"]);
  assert.equal(terminalPort(null), null);
  assert.equal(terminalPort("http://desk.lan:7318/"), null);
});

test("a remote's terminal address is moved to the local forwarded port only on the remote's own loopback, and one that is not http is dropped", () => {
  assert.equal(terminalPort(TERMINAL), 7318);
  assert.equal(terminalPort("http://localhost/x"), 80);
  assert.equal(terminalPort("https://127.0.0.1?x"), 443);
  assert.equal(terminalPort("http://127.0.0.1:99999/"), null, "a port ssh would refuse takes no forward");
  assert.equal(terminalPort("http://127.0.0.1.evil.example:7318/"), null, "a host that only starts with the loopback address is not it");
  assert.equal(localTerminal(TERMINAL, 50002), "http://127.0.0.1:50002/?ws={workspace}&pane={pane}&view=terminal");
  assert.equal(localTerminal("http://localhost:7318/{key}", 50002), "http://127.0.0.1:50002/{key}");
  assert.equal(localTerminal("http://desk.lan:7318/", 50002), "http://desk.lan:7318/");
  assert.equal(localTerminal(TERMINAL, null), null, "a loopback terminal with no tunnel has no link");
  assert.equal(localTerminal("javascript:alert(1)//127.0.0.1", 50002), null);
  assert.equal(localTerminal(null, 50002), null);
});

test("a tunnel that drops is marked down with why, and it is opened again later each time it fails", async () => {
  const r = remotes();
  await openThenDrop(r, "Connection to agents closed by remote host.\n");
  assert.deepEqual(r.removed, ["/private/s1/board.sock"], "the socket's directory is removed with its tunnel");
  assert.deepEqual(r.timers.map((t) => t.ms), [500], "A11-270: the first try again is half a second after the drop");
  assert.match(r.logs.at(-1)!, /^ticket:ui: cannot reach personal over SSH: the tunnel dropped: .*Trying again, up to every 5 seconds$/);
  r.timers[0].fn();
  await settle();
  const again = await r.remotes.reach("personal");
  assert.equal(again.socket, "/private/s2/board.sock", "a new tunnel on a new socket");
  assert.deepEqual([again.port, again.key, again.terminal], [4747, KEY, TERMINAL], "with the info it had");
  assert.equal(r.runs.length, 1, "A11-270: the info is kept, so ticket:remote-info is not run again for the new tunnel");
  r.tunnels[1].drop({ code: 255, stderr: "" });
  await settle();
  assert.deepEqual(r.timers.map((t) => t.ms), [500, 500], "an opened tunnel starts the wait over");
});

test("A11-270: a remote that keeps failing is tried again later each time, never more than 5 seconds apart, and logged once per run of failures", async () => {
  const r = remotes({ info: { code: 255, stdout: "", stderr: "ssh: Could not resolve hostname agents: nodename nor servname provided\n" } });
  await assert.rejects(r.remotes.reach("personal"), /Could not resolve hostname agents/);
  for (let i = 0; i < 7; i++) {
    r.timers.at(-1)!.fn();
    await settle();
  }
  assert.deepEqual(r.timers.map((t) => t.ms), [500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
  assert.equal(r.tunnels.length, 0, "no tunnel is started for a remote whose key cannot be read");
  assert.equal(r.logs.length, 1);
});

test("A11-270: a restart stops the dead tunnel and opens a new one at once, with the kept info, and the remote is never marked down", async () => {
  const r = remotes();
  const first = await r.remotes.reach("personal");
  const reopened = await r.remotes.restart("personal", first.socket);
  await settle();
  assert.equal(r.tunnels[0].stopped, true, "the dead tunnel is stopped");
  assert.equal(reopened.socket, "/private/s2/board.sock");
  assert.equal(await r.remotes.reach("personal"), reopened, "the new tunnel is the one reached");
  assert.equal(r.runs.length, 1, "no ticket:remote-info for the new tunnel");
  assert.equal(r.timers.length, 0, "no wait: the stopped tunnel's end does not mark the remote down");
  assert.equal(r.logs.some((line) => line.startsWith("ticket:ui: cannot reach")), false);
  assert.match(r.logs.join("\n"), /ticket:ui: a request to personal over SSH failed on its tunnel: opening it again/);
});

test("A11-270: restarts with no answer between reuse the kept info, then read it again, then stop until a request is answered", async () => {
  const r = remotes();
  /** Restart the tunnel up now, as a request that failed on it would. */
  const restartUp = async () => r.remotes.restart("personal", (await r.remotes.reach("personal")).socket);
  await r.remotes.reach("personal");
  await restartUp();
  assert.deepEqual([r.tunnels.length, r.runs.length], [2, 1], "the first restart reuses the kept info");
  await restartUp();
  assert.deepEqual([r.tunnels.length, r.runs.length], [3, 2], "the second reads the info again, as the remote's port may have changed");
  const third = await restartUp();
  assert.deepEqual([r.tunnels.length, r.runs.length], [3, 2], "the third opens nothing: a stopped instance is not restarted on every poll");
  assert.equal(third.socket, "/private/s3/board.sock", "and the request is sent on the tunnel there is");
  assert.equal(r.logs.filter((line) => line.includes("failed on its tunnel")).length, 2);
  r.remotes.answered("personal", "/private/s1/board.sock");
  await restartUp();
  assert.equal(r.tunnels.length, 3, "an answer through a tunnel that is gone does not count");
  r.remotes.answered("personal", third.socket);
  await restartUp();
  assert.deepEqual([r.tunnels.length, r.runs.length], [4, 2], "after an answer, the next restart is the first again, with the kept info");
});

test("A11-270: a request waits at most 3 seconds for a retry it starts, then is answered the reason while the retry goes on", async () => {
  const hangs = { value: false };
  // A listening check that never answers: the open goes on as long as ssh takes to give up.
  const r = remotes({ up: () => (hangs.value ? new Promise<boolean>(() => {}) as unknown as boolean : true) });
  await openThenDrop(r, "Broken pipe\n");
  hangs.value = true;
  const reaching = r.remotes.reach("personal");
  await settle();
  const wait = r.timers.filter((t) => t.ms === 3000);
  assert.equal(wait.length, 1, "the wait is 3 seconds");
  wait[0].fn();
  await assert.rejects(reaching, /^Error: the tunnel dropped: Broken pipe$/);
  assert.equal(r.tunnels.length, 2, "the retry was started, and goes on");
});

test("A11-270: a restart for a tunnel already replaced answers the new one, and restarts at once share one open", async () => {
  const r = remotes();
  const first = await r.remotes.reach("personal");
  const [a, b] = await Promise.all([r.remotes.restart("personal", first.socket), r.remotes.restart("personal", first.socket)]);
  assert.equal(a, b, "two requests that failed together open one tunnel");
  assert.equal(await r.remotes.restart("personal", first.socket), a, "a request that failed on the old tunnel does not stop the new one");
  assert.equal(r.tunnels.length, 2);
  assert.equal(r.tunnels[1].stopped, false);
});

/** Remotes whose tunnels open, except while `failing.value` is set: then each ends with "Broken pipe" just as it would listen. */
function breakable() {
  const failing = { value: false };
  let tunnelOf: () => Tunnel = () => { throw new Error("no tunnel yet"); };
  const r = remotes({ up: () => { if (failing.value) tunnelOf().drop({ code: 255, stderr: "Broken pipe\n" }); return true; } });
  tunnelOf = () => r.tunnels.at(-1)!;
  return { ...r, failing };
}

test("A11-270: a restart of a remote that is down tries now instead of at its retry, and one that cannot open is down with its reason", async () => {
  const r = breakable();
  const first = await r.remotes.reach("personal");
  r.failing.value = true;
  await assert.rejects(r.remotes.restart("personal", first.socket), /^Error: Broken pipe$/);
  await settle();
  assert.deepEqual(r.timers.map((t) => t.ms), [500]);
  r.failing.value = false;
  await r.remotes.restart("personal", first.socket);
  assert.equal(r.timers[0].cancelled, true, "the waiting retry is not run as well");
});

test("A11-270: an open with the kept info that fails reads the info again on the next try, and forget drops the kept info too", async () => {
  const r = breakable();
  await openThenDrop(r, "Broken pipe\n");
  /** Run the retry scheduled `index`th, with its tunnel failing or opening. */
  const retry = async (index: number, failing: boolean) => {
    r.failing.value = failing;
    r.timers[index].fn();
    await settle();
  };
  await retry(0, true);
  assert.equal(r.runs.length, 1, "the first try again used the kept info");
  await retry(1, false);
  assert.equal(r.runs.length, 2, "after it failed, the info is read again");
  r.remotes.forget("personal");
  await r.remotes.reach("personal");
  assert.equal(r.runs.length, 3, "after forget, the info is read again");
});

test("A11-270: a request that finds the tunnel down just after it dropped makes the retry due within 3 seconds now, and waits for it", async () => {
  const r = remotes();
  await openThenDrop(r, "Timeout, server agents not responding.\n");
  const link = await r.remotes.reach("personal");
  assert.equal(link.socket, "/private/s2/board.sock", "the retry due in 500 ms is made at once and waited for");
  assert.equal(r.timers[0].cancelled, true);
});

test("A11-270: a request that finds the tunnel down with its retry more than 3 seconds off is answered the reason, and one 3 seconds off starts it now", async () => {
  const far = remotes({ info: { code: 255, stdout: "", stderr: "agents: Connection refused\n" } });
  await far.remotes.reach("personal").catch(() => {});
  for (let i = 0; i < 4; i++) {
    far.timers.at(-1)!.fn();
    await settle();
  }
  assert.equal(far.timers.at(-1)!.ms, 5000);
  far.clock.ms = 1000;
  const runs = far.runs.length;
  await assert.rejects(far.remotes.reach("personal"), /Connection refused/, "a retry 4 s off is not waited for");
  assert.equal(far.runs.length, runs, "and not started early");
  far.clock.ms = 2000;
  await assert.rejects(far.remotes.reach("personal"), /Connection refused/);
  assert.equal(far.runs.length, runs + 1, "one 3 s off is started now");
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

test("the info is read from the last line, past a login message, and a terminal that is not an http address is dropped", () => {
  assert.deepEqual(parseRemoteInfo(`Welcome to agents\n\n${JSON.stringify({ port: 4848, key: KEY, terminal: null })}\n`), { port: 4848, key: KEY, terminal: null });
  assert.equal(parseRemoteInfo(JSON.stringify({ port: 4848, key: KEY, terminal: "javascript:alert(1)" })).terminal, null);
  assert.equal(parseRemoteInfo(JSON.stringify({ port: 4848, key: KEY, terminal: 7 })).terminal, null);
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

test("a listener that answers just as the tunnel ends is not taken as the tunnel", async () => {
  let tunnelOf: (() => Tunnel) | null = null;
  const r = remotes({ up: () => { tunnelOf!().drop({ code: 255, stderr: "lost\n" }); return true; } });
  tunnelOf = () => r.tunnels[0];
  await assert.rejects(r.remotes.reach("personal"), /lost/);
});

test("close stops every tunnel, one still opening too, cancels every retry, and nothing is opened after it", async () => {
  const r = remotes();
  await r.remotes.reach("personal");
  r.remotes.close();
  assert.equal(r.tunnels[0].stopped, true);
  await settle();
  assert.equal(r.timers.length, 0, "a tunnel stopped by close is not opened again");
  await assert.rejects(r.remotes.reach("personal"), /the service is closing/);
  const opening = remotes({ up: false });
  const reaching = opening.remotes.reach("personal").catch((err: Error) => err);
  await settle();
  opening.remotes.close();
  assert.equal(opening.tunnels[0].stopped, true, "a tunnel still opening is stopped");
  assert.match(String(await reaching), /ssh exited null|closing/);
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

test("the real runner's socket is in a new directory only this user can enter, which remove deletes", () => {
  const socket = processRunner().privateSocket();
  const dir = dirname(socket.path);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  socket.remove();
  assert.equal(existsSync(dir), false);
});
