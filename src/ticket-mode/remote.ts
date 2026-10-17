// @ts-check
// module: the SSH tunnel to another machine's instance -- read its key once per connection, and hold the connection open
//
// THE PAGE'S SERVICE OPENS THE CONNECTION ITSELF. For an ssh connection it runs `ssh <target> agent-org ticket:remote-info`, which prints the
// remote instance's port, key and terminal address, then `ssh -N` forwarding a Unix socket here to that instance's port, and a free port on this machine's
// 127.0.0.1 to its terminal service when it serves one. Both run with BatchMode and no TTY, so a prompt for a password fails rather than
// hangs, and with no connection sharing, agent or X11 forwarding, so the person's ssh config cannot keep a forward alive past `stop`. A tunnel
// that drops is opened again, slower each time it fails, until the service closes. `remote-proxy.ts` passes the page's calls through it.
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
const FIRST_RETRY_MS = 2_000;
const LAST_RETRY_MS = 60_000;
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
  upMs?: number;
}>;

type Tunnel = ReturnType<Runner["start"]>;

type State =
  | { kind: "idle" }
  | { kind: "connecting"; pending: Promise<Link> }
  | { kind: "up"; link: Link; tunnel: Tunnel }
  | { kind: "down"; reason: string; cancel: () => void };

/** The tunnels to `connections`, each opened the first time it is reached and held open until `close`. */
export function createRemotes(connections: readonly SshConnection[], options: Options = {}) {
  const runner = options.runner ?? processRunner();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); });
  const upMs = options.upMs ?? UP_MS;
  const byName = new Map(connections.map((connection) => [connection.name, connection]));
  const states = new Map<string, State>(connections.map((connection) => [connection.name, { kind: "idle" }]));
  const failures = new Map<string, number>();
  /** Every tunnel started and not yet ended, opening or open, so `close` stops one still opening too. */
  const live = new Set<Tunnel>();
  let closed = false;

  async function open(connection: SshConnection): Promise<{ link: Link; tunnel: Tunnel }> {
    const read = await runner.run(infoArgv(connection), INFO_MS);
    if (read.code !== 0) throw new Unreachable(infoFailure(read));
    const info = parseRemoteInfo(read.stdout);
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
    if (closed) tunnel.stop();
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

  /** Mark `connection` down for `reason`, and try again later, later each time it fails in a row. The log says so once per run of failures. */
  function down(connection: SshConnection, reason: string): void {
    const count = (failures.get(connection.name) ?? 0) + 1;
    failures.set(connection.name, count);
    const delay = Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** (count - 1));
    if (count === 1) log(`ticket:ui: cannot reach ${connection.name} over SSH: ${reason}. Trying again, up to once a minute`);
    const cancel = schedule(() => { if (!closed && states.get(connection.name)?.kind === "down") void connect(connection).catch(() => {}); }, delay);
    states.set(connection.name, { kind: "down", reason, cancel });
  }

  function connect(connection: SshConnection): Promise<Link> {
    const pending = open(connection).then(({ link, tunnel }) => {
      if (closed) {
        tunnel.stop();
        throw new Unreachable("the service is closing");
      }
      failures.delete(connection.name);
      states.set(connection.name, { kind: "up", link, tunnel });
      log(`ticket:ui: ${connection.name} is reached over SSH`);
      void tunnel.exited.then((exit) => {
        const now = states.get(connection.name);
        if (closed || now?.kind !== "up" || now.link !== link) return;
        down(connection, `the tunnel dropped: ${redact(exit.stderr) || `ssh exited ${exit.code}`}`);
      });
      return link;
    }, (err: unknown) => {
      const reason = err instanceof Unreachable ? err.message : redact(String((err as Error)?.message ?? err));
      if (!closed) down(connection, reason);
      throw new Unreachable(reason);
    });
    states.set(connection.name, { kind: "connecting", pending });
    return pending;
  }

  return {
    /** Whether `name` is a remote connection. */
    has: (name: string): boolean => byName.has(name),
    /** The open tunnel to `name`, opened now when it has none. THROWS `Unreachable` with the reason when it cannot be reached. */
    async reach(name: string): Promise<Link> {
      const connection = byName.get(name);
      if (connection === undefined) throw new Unreachable(`no ssh connection ${name}`);
      if (closed) throw new Unreachable("the service is closing");
      const state = states.get(name)!;
      if (state.kind === "up") return state.link;
      if (state.kind === "connecting") return state.pending;
      if (state.kind === "down") throw new Unreachable(state.reason);
      return connect(connection);
    },
    /** Close `name`'s tunnel, so the next request reads its key again: the remote refused the one held. */
    forget(name: string): void {
      const state = states.get(name);
      if (state?.kind === "up") state.tunnel.stop();
      if (state?.kind === "down") state.cancel();
      if (state !== undefined && state.kind !== "connecting") states.set(name, { kind: "idle" });
    },
    /** Close every tunnel, opening or open, and open none again. */
    close(): void {
      closed = true;
      for (const tunnel of live) tunnel.stop();
      for (const state of states.values()) if (state.kind === "down") state.cancel();
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
