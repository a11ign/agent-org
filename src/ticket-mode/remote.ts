// @ts-check
// module: the SSH tunnel to another machine's instance -- read its key once per connection, and hold the connection open
//
// THE PAGE'S SERVICE OPENS THE CONNECTION ITSELF. For an ssh connection it runs `ssh <target> agent-org ticket:remote-info`, which prints the
// remote instance's port, key and terminal address, then `ssh -N` forwarding a Unix socket here to that instance's port, and a free port on this machine's
// 127.0.0.1 to its terminal service when it serves one. Both run with BatchMode and no TTY, so a prompt for a password fails rather than
// hangs, and with no connection sharing, agent or X11 forwarding, so the person's ssh config cannot keep a forward alive past `stop`. A tunnel
// that drops is opened again, slower each time it fails, up to every 5 seconds, until the service closes. `remote-proxy.ts` passes the page's
// calls through it.
//
// A DEAD TUNNEL IS NOTICED BY THE FIRST REQUEST THAT FAILS ON IT (A11-270). ssh's keepalive takes up to 45 seconds to end a tunnel whose link
// is gone, and every request in that time would fail. `restart` opens it again at once. Each open after the first reuses the info the last
// good one read, so it is one ssh handshake, not a node start on the remote: the info is read again after `forget` (the remote refused the
// key), when an open with the kept info fails, and on a second restart with no answer between. A third gets no restart until a request is
// `answered` again. A request that finds the tunnel down waits up to 3 seconds for a retry due within them, rather than be answered the old
// reason during a reconnect that takes under one.
//
// THE INSTANCE'S FORWARD IS A SOCKET IN A DIRECTORY ONLY THIS USER CAN ENTER, NOT A PORT. A port picked free and then bound by ssh seconds later
// can be taken first by another process, which would then be sent the key. The terminal's forward is a port, because the browser opens it.
//
// THE REMOTE KEY STAYS IN THIS PROCESS'S MEMORY. It is never on a command line (ssh carries it back on stdout), never in a log line or an
// answer to the page. A reason that came from the remote is cut of anything shaped like a key before it is shown.
//
// The process runner is injected, so the tests drive every path with a fake that records argv and plays the tunnel up, down or failing.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshConnection } from "./connections.ts";

/** How a process ended: its exit code, null when a signal ended it, and the end of what it wrote to stderr. */
export type Exit = Readonly<{ code: number | null; stderr: string }>;

/** What this module runs. A test replaces each part. */
export type Runner = Readonly<{
  /** Run `argv` to its end, cut at `timeoutMs`. */
  run(argv: readonly string[], timeoutMs: number): Promise<Exit & Readonly<{ stdout: string }>>;
  /** Start `argv` and leave it running. */
  start(argv: readonly string[]): Readonly<{ exited: Promise<Exit>; stop(): void }>;
  /** A port on 127.0.0.1 that nothing listens on now. */
  freePort(): Promise<number>;
  /** A new Unix socket path in a directory only this user can enter, and what removes the directory. */
  privateSocket(): Readonly<{ path: string; remove(): void }>;
  /** Whether something accepts a connection at the Unix socket `path`. */
  listening(path: string): Promise<boolean>;
}>;

/** What `ticket:remote-info` prints: the remote instance's port, its key, and its terminal address template or null. */
export type RemoteInfo = Readonly<{ port: number; key: string; terminal: string | null }>;

/** An open tunnel to a remote instance: what it answers as, the socket here that reaches it, and the port here that reaches its terminal. */
export type Link = RemoteInfo & Readonly<{ socket: string; terminalLocal: number | null }>;

/** A remote that cannot be reached now, and why, in words a person can act on. */
export class Unreachable extends Error {}

const SSH_OPTIONS = ["-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
const INFO_OPTIONS = [...SSH_OPTIONS, "-o", "ClearAllForwardings=yes"];
const TUNNEL_OPTIONS = ["-N", ...SSH_OPTIONS, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "StreamLocalBindMask=0177"];
const INFO_MS = 30_000;
const INFO_BYTES = 64 * 1024;
const UP_MS = 15_000;
const PROBE_MS = 200;
const FIRST_RETRY_MS = 500;
const LAST_RETRY_MS = 5_000;
/** A request that finds the tunnel down starts a retry due within this long, and waits for it this long at most. */
const REACH_WAIT_MS = 3_000;
/**
 * How many restarts a tunnel gets before a request is answered through it again: the first reuses the kept info, the second reads it again (the
 * remote's port may have changed). After that a request that fails is answered without one, so a stopped instance is not restarted on every poll.
 */
const MOST_RESTARTS = 2;
const REASON_CHARS = 300;
const SOCKET_PATH_BYTES = 100;
const KEY_SHAPE = /^[0-9a-f]{48}$/;
const LOOPBACK_ORIGIN = /^(https?):\/\/(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?(?=[/?#]|$)/;
const WEB_ADDRESS = /^https?:\/\//i;

/** `text` with anything shaped like a key or a token cut out, kept to one short line. */
export function redact(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).filter((part) => part !== "").at(-1) ?? "";
  // 32 or more hex digits (a board key), or a run of 32 or more with a digit in it (a token). Never a word such as ssh's
  // `channel_setup_fwd_listener_tcpip`.
  return line.replace(/[0-9a-fA-F]{32,}|(?=[A-Za-z_-]*[0-9])[0-9A-Za-z_-]{32,}/g, "[redacted]").slice(0, REASON_CHARS);
}

/** The argv that reads the remote instance's port, key and terminal. The key comes back on stdout, never goes out on argv. */
export function infoArgv(connection: SshConnection): string[] {
  return ["ssh", ...INFO_OPTIONS, "--", connection.ssh, `${connection.agentOrg} ticket:remote-info`];
}

/** The argv of the tunnel: `socket` here to the remote instance, and `terminal`'s local port to its terminal service when it has one. */
export function tunnelArgv(connection: SshConnection, socket: string, remote: number, terminal: Readonly<{ local: number; remote: number }> | null): string[] {
  const forwards = [`${socket}:127.0.0.1:${remote}`, ...(terminal === null ? [] : [`127.0.0.1:${terminal.local}:127.0.0.1:${terminal.remote}`])];
  return ["ssh", ...TUNNEL_OPTIONS, ...forwards.flatMap((forward) => ["-L", forward]), "--", connection.ssh];
}

/**
 * What `ticket:remote-info` printed, read from its last line, so a login message a shell prints first is passed over. A terminal that is not
 * an http address is dropped. THROWS a reason that never quotes the output, which holds the key.
 */
export function parseRemoteInfo(stdout: string): RemoteInfo {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new Unreachable("agent-org ticket:remote-info there printed something that is not JSON: is that machine's agent-org older than this one?");
  }
  const { port, key, terminal } = (value ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Unreachable("agent-org ticket:remote-info there gave no port");
  if (typeof key !== "string" || !KEY_SHAPE.test(key)) throw new Unreachable("agent-org ticket:remote-info there gave no board key");
  return { port: port as number, key, terminal: typeof terminal === "string" && WEB_ADDRESS.test(terminal) ? terminal : null };
}

/** Why reading the remote's info failed, from how `ssh` ended. */
function infoFailure(exit: Exit): string {
  if (exit.code === null) return "ssh did not answer in time";
  if (exit.code === 127) return "agent-org is not on the PATH of a non-interactive shell there: set agentOrg in the connection to its full path";
  const said = redact(exit.stderr);
  return said === "" ? `ssh exited ${exit.code}` : said;
}

/** The remote port a terminal address serves on when it is on the remote's own loopback, and so needs a tunnel. Null otherwise. */
export function terminalPort(template: string | null): number | null {
  const match = template === null ? null : LOOPBACK_ORIGIN.exec(template);
  if (match === null) return null;
  const port = match[2] !== undefined ? Number(match[2]) : match[1] === "https" ? 443 : 80;
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * The terminal address the page is given for a remote: one on the remote's loopback moved to `local`, the port here that the tunnel forwards
 * to it. One on the remote's loopback with no tunnel, or one that is not an http address, is null, so the page shows no link.
 */
export function localTerminal(template: string | null, local: number | null): string | null {
  if (template === null || !WEB_ADDRESS.test(template)) return null;
  if (!LOOPBACK_ORIGIN.test(template)) return template;
  if (local === null || terminalPort(template) === null) return null;
  return template.replace(LOOPBACK_ORIGIN, (_, scheme: string) => `${scheme}://127.0.0.1:${local}`);
}

type Options = Readonly<{
  runner?: Runner;
  log?: (line: string) => void;
  /** Run `fn` after `ms`, and return what cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The time now, in ms, against which a scheduled retry is due. */
  now?: () => number;
  upMs?: number;
}>;

type Tunnel = ReturnType<Runner["start"]>;

type State =
  | { kind: "idle" }
  | { kind: "connecting"; pending: Promise<Link> }
  | { kind: "up"; link: Link; tunnel: Tunnel }
  | { kind: "down"; reason: string; due: number; cancel: () => void };

/** Read `connection`'s port, key and terminal over ssh. THROWS `Unreachable` with why it cannot. */
async function readInfo(connection: SshConnection, runner: Runner): Promise<RemoteInfo> {
  const read = await runner.run(infoArgv(connection), INFO_MS);
  if (read.code !== 0) throw new Unreachable(infoFailure(read));
  return parseRemoteInfo(read.stdout);
}

type OpenOptions = Readonly<{ runner: Runner; upMs: number; live: Set<Tunnel>; closing: () => boolean; kept: RemoteInfo | undefined }>;

/**
 * Read `connection`'s info, or use `kept`, the info of its last good tunnel, then open its tunnel and wait for the socket to listen. `live` holds
 * every tunnel still running, and `closing` tells whether `close` has run.
 */
async function open(connection: SshConnection, { runner, upMs, live, closing, kept }: OpenOptions): Promise<{ link: Link; tunnel: Tunnel }> {
  const info = kept ?? await readInfo(connection, runner);
  const remoteTerminal = terminalPort(info.terminal);
  const terminalLocal = remoteTerminal === null ? null : await runner.freePort();
  const socket = runner.privateSocket();
  const tunnel = runner.start(tunnelArgv(connection, socket.path, info.port, remoteTerminal === null || terminalLocal === null ? null : { local: terminalLocal, remote: remoteTerminal }));
  live.add(tunnel);
  const ended: { exit: Exit | null } = { exit: null };
  void tunnel.exited.then((exit) => {
    ended.exit = exit;
    live.delete(tunnel);
    socket.remove();
  });
  if (closing()) tunnel.stop();
  for (const deadline = Date.now() + upMs; ; await new Promise((done) => setTimeout(done, PROBE_MS))) {
    // Listening is read before the exit, so a listener that answered from a tunnel that has since ended is not taken as open.
    const listening = await runner.listening(socket.path);
    if (ended.exit !== null) throw new Unreachable(redact(ended.exit.stderr) || `ssh exited ${ended.exit.code}`);
    if (listening) return { link: { ...info, socket: socket.path, terminalLocal }, tunnel };
    if (Date.now() > deadline) {
      tunnel.stop();
      throw new Unreachable(`the tunnel did not open within ${Math.round(upMs / 1000)} seconds`);
    }
  }
}

/** What every remote's tunnel shares: how processes are run and time is kept, the log, the tunnels still running, and whether `close` has run (the service is closing). */
type Shared = Readonly<{
  runner: Runner;
  log: (line: string) => void;
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  upMs: number;
  /** Every tunnel started and not yet ended, opening or open, so `close` stops one still opening too. */
  live: Set<Tunnel>;
  closing: () => boolean;
}>;

/** End what `state` holds: stop its tunnel when it is up, and cancel its retry when it is down. */
function halt(state: State): void {
  if (state.kind === "up") state.tunnel.stop();
  if (state.kind === "down") state.cancel();
}

/** Stop `tunnel`, opened as the service closed, and the reason to give for it. */
function stopAsClosing(tunnel: Tunnel): Unreachable {
  tunnel.stop();
  return new Unreachable("the service is closing");
}

/** `pending`, or the old `reason` once `REACH_WAIT_MS` has passed without it: a request waits for a reconnect that is close, not for a slow one. */
function within(schedule: Shared["schedule"], pending: Promise<Link>, reason: string): Promise<Link> {
  return new Promise((done, fail) => {
    const cancel = schedule(() => fail(new Unreachable(reason)), REACH_WAIT_MS);
    pending.then((link) => { cancel(); done(link); }, (err: unknown) => { cancel(); fail(err); });
  });
}

/** The tunnel to `connection`: opened the first time it is reached, opened again when it drops or a request finds it dead, until `close`. */
function createRemote(connection: SshConnection, shared: Shared) {
  const { runner, log, schedule, now, upMs, live, closing } = shared;
  const { name } = connection;
  let state: State = { kind: "idle" };
  /** How many opens in a row have failed. */
  let failures = 0;
  /** The info as the last good tunnel read it, so the next open needs no `ticket:remote-info`. */
  let kept: RemoteInfo | undefined;
  /** How many restarts since a request was last answered through the tunnel. */
  let unanswered = 0;

  /** Mark the remote down for `reason`, and try again later, later each time it fails in a row. The log says so once per run of failures. */
  function down(reason: string): void {
    failures += 1;
    const delay = Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1));
    if (failures === 1) log(`ticket:ui: cannot reach ${name} over SSH: ${reason}. Trying again, up to every ${LAST_RETRY_MS / 1000} seconds`);
    const retry = () => { if (!closing() && state.kind === "down") void connect().catch(() => {}); };
    state = { kind: "down", reason, due: now() + delay, cancel: schedule(retry, delay) };
  }

  /** Hold `tunnel` as the one up, and mark the remote down when it drops while it still is. */
  function opened(link: Link, tunnel: Tunnel): Link {
    if (closing()) throw stopAsClosing(tunnel);
    failures = 0;
    kept = { port: link.port, key: link.key, terminal: link.terminal };
    state = { kind: "up", link, tunnel };
    log(`ticket:ui: ${name} is reached over SSH`);
    void tunnel.exited.then((exit) => {
      if (closing() || state.kind !== "up" || state.link !== link) return;
      down(`the tunnel dropped: ${redact(exit.stderr) || `ssh exited ${exit.code}`}`);
    });
    return link;
  }

  function connect(): Promise<Link> {
    const pending = open(connection, { runner, upMs, live, closing, kept }).then(({ link, tunnel }) => opened(link, tunnel), (err: unknown) => {
      const reason = err instanceof Unreachable ? err.message : redact(String((err as Error)?.message ?? err));
      // The remote's port or key may have changed since the info was kept, so the next open reads it again.
      kept = undefined;
      if (!closing()) down(reason);
      throw new Unreachable(reason);
    });
    state = { kind: "connecting", pending };
    return pending;
  }

  /** The open tunnel, opened now when there is none, or when the retry it waits for is due within `REACH_WAIT_MS`. */
  function reach(): Promise<Link> {
    if (state.kind === "up") return Promise.resolve(state.link);
    if (state.kind === "connecting") return state.pending;
    if (state.kind === "down") {
      if (state.due - now() > REACH_WAIT_MS) return Promise.reject(new Unreachable(state.reason));
      const { reason } = state;
      state.cancel();
      return within(schedule, connect(), reason);
    }
    return connect();
  }

  return {
    reach,
    /** Open the tunnel again now, unless the one at `socket`, which a request found dead, has been replaced already, or restarting has not helped. */
    restart(socket: string): Promise<Link> {
      const was = state;
      if (was.kind === "connecting") return was.pending;
      if (was.kind === "up" && was.link.socket !== socket) return Promise.resolve(was.link);
      if (unanswered >= MOST_RESTARTS) return reach();
      unanswered += 1;
      // A restart that did not help: the remote's port or key may have changed, so this one reads them again.
      if (unanswered > 1) kept = undefined;
      log(`ticket:ui: a request to ${name} over SSH failed on its tunnel: opening it again`);
      // Connecting first, so the stopped tunnel's exit finds it no longer the one up and does not mark the remote down.
      const reopened = connect();
      halt(was);
      return reopened;
    },
    /** A request through the tunnel at `socket` was answered, so it works, and a request that fails on it later may restart it again. */
    answered: (socket: string): void => { if (state.kind === "up" && state.link.socket === socket) unanswered = 0; },
    /** Close the tunnel and drop the kept info, so the next request reads the key again. */
    forget(): void {
      kept = undefined;
      halt(state);
      if (state.kind !== "connecting") state = { kind: "idle" };
    },
    /** Stop the tunnel, or cancel the retry that is waiting. */
    halt: (): void => halt(state),
  };
}

/** The tunnels to `connections`, each opened the first time it is reached and held open until `close`. */
export function createRemotes(connections: readonly SshConnection[], options: Options = {}) {
  const live = new Set<Tunnel>();
  let closed = false;
  const shared: Shared = {
    runner: options.runner ?? processRunner(),
    log: options.log ?? ((line: string) => process.stderr.write(`${line}\n`)),
    schedule: options.schedule ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); }),
    now: options.now ?? Date.now,
    upMs: options.upMs ?? UP_MS,
    live,
    closing: () => closed,
  };
  const byName = new Map(connections.map((connection) => [connection.name, createRemote(connection, shared)]));
  /** `name`'s remote. THROWS `Unreachable` for a name that is no ssh connection, and once the service is closing. */
  const remote = (name: string) => {
    const found = byName.get(name);
    if (found === undefined) throw new Unreachable(`no ssh connection ${name}`);
    if (closed) throw new Unreachable("the service is closing");
    return found;
  };

  return {
    /** Whether `name` is a remote connection. */
    has: (name: string): boolean => byName.has(name),
    /** The open tunnel to `name`, opened now when it has none. THROWS `Unreachable` with the reason when it cannot be reached. */
    reach: async (name: string): Promise<Link> => remote(name).reach(),
    /**
     * Open `name`'s tunnel again now, with no wait: a request through the tunnel at `socket` failed, so it is dead although ssh has not ended
     * yet. A tunnel opened since that request is the one answered, and one opening is waited for. THROWS `Unreachable` when it cannot be opened.
     */
    restart: async (name: string, socket: string): Promise<Link> => remote(name).restart(socket),
    /** A request through `name`'s tunnel at `socket` was answered: the tunnel works, so it may be restarted again when it is found dead. */
    answered(name: string, socket: string): void {
      byName.get(name)?.answered(socket);
    },
    /** Close `name`'s tunnel, so the next request reads its key again: the remote refused the one held. */
    forget(name: string): void {
      byName.get(name)?.forget();
    },
    /** Close every tunnel, opening or open, and open none again. */
    close(): void {
      closed = true;
      for (const tunnel of live) tunnel.stop();
      for (const each of byName.values()) each.halt();
    },
  };
}

export type Remotes = ReturnType<typeof createRemotes>;

/** The runner that runs real processes. */
export function processRunner(): Runner {
  const TAIL = 4096;
  const launch = (argv: readonly string[]) => spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  return {
    run: (argv, timeoutMs) => new Promise((done) => {
      const child = launch(argv);
      let stdout = "";
      let stderr = "";
      const finish = (exit: Exit & { stdout: string }) => { clearTimeout(timer); done(exit); };
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < INFO_BYTES) stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-TAIL); });
      // A process that ignores the kill, or one whose child holds the pipes open, still ends the wait.
      const timer = setTimeout(() => { child.kill("SIGKILL"); done({ code: null, stdout: "", stderr }); }, timeoutMs);
      child.on("error", (err) => finish({ code: 127, stdout: "", stderr: err.message }));
      child.on("close", (code) => finish({ code, stdout, stderr }));
    }),
    start(argv) {
      const child = launch(argv);
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-TAIL); });
      const exited = new Promise<Exit>((done) => {
        child.on("error", (err) => done({ code: 127, stderr: err.message }));
        child.on("close", (code) => done({ code, stderr }));
      });
      return { exited, stop: () => { child.kill("SIGTERM"); } };
    },
    freePort: () => new Promise((done, fail) => {
      const server = createServer();
      server.on("error", fail);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => done(port));
      });
    }),
    privateSocket() {
      // mkdtemp makes the directory with mode 700. The socket's own mode is set by ssh's StreamLocalBindMask. A socket's path is cut at 104
      // bytes on macOS, so a long TMPDIR gives way to /tmp.
      const base = join(tmpdir(), "agent-org-tunnel-XXXXXX", "board.sock").length <= SOCKET_PATH_BYTES ? tmpdir() : "/tmp";
      const dir = mkdtempSync(join(base, "agent-org-tunnel-"));
      return { path: join(dir, "board.sock"), remove: () => rmSync(dir, { recursive: true, force: true }) };
    },
    listening: (path) => new Promise((done) => {
      const socket = connect({ path });
      socket.on("connect", () => { socket.destroy(); done(true); });
      socket.on("error", () => done(false));
    }),
  };
}
