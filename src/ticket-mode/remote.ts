// @ts-check
// module: another machine's board, reached over SSH -- read its key once, hold a tunnel to it, and pass a paired browser's API calls through
//
// THIS BOARD OPENS THE CONNECTION ITSELF. For a remote profile it runs `ssh <target> agent-org ticket:remote-info` once per connection, which
// prints the remote board's port, key and terminal address, then `ssh -N` forwarding a free port on this machine's 127.0.0.1 to that board's
// port, and a second one to its terminal service when it serves one. Both run with BatchMode and no TTY, so a prompt for a password fails
// rather than hangs. A tunnel that drops is opened again, slower each time it fails, until the board closes.
//
// THE REMOTE KEY STAYS IN THIS PROCESS'S MEMORY. It is never on a command line (ssh carries it back on stdout), never in a log line or an
// answer to the page, and is sent only in the `x-ticket-token` header the remote board already takes from scripts. A reason that came from
// the remote is cut of anything shaped like a key before it is shown.
//
// THE PAGE NEVER TALKS TO THE REMOTE. The request is rebuilt here with only what the remote needs: its own `Host` (so its DNS-rebinding guard
// accepts it), the key, and the JSON body. The browser's cookie, which is this board's session, is never sent on.
//
// The process runner is injected, so the tests drive every path with a fake that records argv and plays the tunnel up, down or failing.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import type { RemoteProfile } from "./profiles.ts";

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
  /** Whether something accepts a connection on 127.0.0.1:`port`. */
  listening(port: number): Promise<boolean>;
}>;

/** What `ticket:remote-info` prints: the remote board's port, its key, and its terminal address template or null. */
export type RemoteInfo = Readonly<{ port: number; key: string; terminal: string | null }>;

/** An open tunnel to a remote board: what it answers as, and the ports on this machine that reach it and its terminal. */
export type Link = RemoteInfo & Readonly<{ local: number; terminalLocal: number | null }>;

/** A remote that cannot be reached now, and why, in words a person can act on. */
export class Unreachable extends Error {}

const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const TUNNEL_OPTIONS = ["-N", ...SSH_OPTIONS, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
const INFO_MS = 30_000;
const UP_MS = 15_000;
const PROBE_MS = 200;
const FIRST_RETRY_MS = 2_000;
const LAST_RETRY_MS = 60_000;
const FORWARD_MS = 30_000;
const REASON_CHARS = 300;
const KEY_SHAPE = /^[0-9a-f]{48}$/;
const LOOPBACK_ORIGIN = /^(https?):\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?(?=[/?#]|$)/;

/** `text` with anything shaped like a key or a token cut out, kept to one short line. */
export function redact(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).filter((part) => part !== "").at(-1) ?? "";
  // 32 or more hex digits (a board key), or a run of 32 or more with a digit in it (a token). Never a word such as ssh's
  // `channel_setup_fwd_listener_tcpip`.
  return line.replace(/[0-9a-fA-F]{32,}|(?=[A-Za-z_-]*[0-9])[0-9A-Za-z_-]{32,}/g, "[redacted]").slice(0, REASON_CHARS);
}

/** The argv that reads the remote board's port, key and terminal. The key comes back on stdout, never goes out on argv. */
export function infoArgv(profile: RemoteProfile): string[] {
  return ["ssh", ...SSH_OPTIONS, "--", profile.ssh, `${profile.agentOrg} ticket:remote-info`];
}

/** The argv of the tunnel: this machine's `local` to the remote board, and `terminal`'s local port to its terminal service when it has one. */
export function tunnelArgv(profile: RemoteProfile, local: number, remote: number, terminal: Readonly<{ local: number; remote: number }> | null): string[] {
  const forwards = [`127.0.0.1:${local}:127.0.0.1:${remote}`, ...(terminal === null ? [] : [`127.0.0.1:${terminal.local}:127.0.0.1:${terminal.remote}`])];
  return ["ssh", ...TUNNEL_OPTIONS, ...forwards.flatMap((forward) => ["-L", forward]), "--", profile.ssh];
}

/** What `ticket:remote-info` printed. THROWS a reason that never quotes the output, which holds the key. */
export function parseRemoteInfo(stdout: string): RemoteInfo {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Unreachable("agent-org ticket:remote-info there printed something that is not JSON: is that machine's agent-org older than this one?");
  }
  const { port, key, terminal } = (value ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Unreachable("agent-org ticket:remote-info there gave no port");
  if (typeof key !== "string" || !KEY_SHAPE.test(key)) throw new Unreachable("agent-org ticket:remote-info there gave no board key");
  if (terminal !== null && typeof terminal !== "string") throw new Unreachable("agent-org ticket:remote-info there gave a terminal that is not an address");
  return { port: port as number, key, terminal };
}

/** Why reading the remote's info failed, from how `ssh` ended. */
function infoFailure(exit: Exit): string {
  if (exit.code === null) return "ssh did not answer in time";
  if (exit.code === 127) return "agent-org is not on the PATH of a non-interactive shell there: set agentOrg in the profile to its full path";
  const said = redact(exit.stderr);
  return said === "" ? `ssh exited ${exit.code}` : said;
}

/** The remote port a terminal address template serves on, when it is on the remote's own loopback and so needs a tunnel; null otherwise. */
export function terminalPort(template: string | null): number | null {
  const match = template === null ? null : LOOPBACK_ORIGIN.exec(template);
  if (match === null) return null;
  return match[2] !== undefined ? Number(match[2]) : match[1] === "https" ? 443 : 80;
}

/** `template` with its loopback origin moved to this machine's `local` port, which the tunnel forwards to the remote's terminal service. */
export function localTerminal(template: string | null, local: number | null): string | null {
  if (template === null || local === null || !LOOPBACK_ORIGIN.test(template)) return template;
  return template.replace(LOOPBACK_ORIGIN, (_, scheme: string) => `${scheme}://127.0.0.1:${local}`);
}

type Options = Readonly<{
  runner?: Runner;
  log?: (line: string) => void;
  /** Run `fn` after `ms`, and return what cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  upMs?: number;
}>;

type State =
  | { kind: "idle" }
  | { kind: "connecting"; pending: Promise<Link> }
  | { kind: "up"; link: Link; stop: () => void }
  | { kind: "down"; reason: string; cancel: () => void };

/** The tunnels to `profiles`, each opened the first time it is reached and held open until `close`. */
export function createRemotes(profiles: readonly RemoteProfile[], options: Options = {}) {
  const runner = options.runner ?? processRunner();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); });
  const upMs = options.upMs ?? UP_MS;
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const states = new Map<string, State>(profiles.map((profile) => [profile.name, { kind: "idle" }]));
  const failures = new Map<string, number>();
  let closed = false;

  async function open(profile: RemoteProfile): Promise<{ link: Link; tunnel: ReturnType<Runner["start"]> }> {
    const read = await runner.run(infoArgv(profile), INFO_MS);
    if (read.code !== 0) throw new Unreachable(infoFailure(read));
    const info = parseRemoteInfo(read.stdout);
    const local = await runner.freePort();
    const remoteTerminal = terminalPort(info.terminal);
    let terminalLocal: number | null = null;
    while (remoteTerminal !== null && (terminalLocal === null || terminalLocal === local)) terminalLocal = await runner.freePort();
    const tunnel = runner.start(tunnelArgv(profile, local, info.port, remoteTerminal === null || terminalLocal === null ? null : { local: terminalLocal, remote: remoteTerminal }));
    let ended: Exit | null = null;
    void tunnel.exited.then((exit) => { ended = exit; });
    for (const deadline = Date.now() + upMs; ; await new Promise((done) => setTimeout(done, PROBE_MS))) {
      if (ended !== null) throw new Unreachable(redact((ended as Exit).stderr) || `ssh exited ${(ended as Exit).code}`);
      if (await runner.listening(local)) return { link: { ...info, local, terminalLocal }, tunnel };
      if (Date.now() > deadline) {
        tunnel.stop();
        throw new Unreachable(`the tunnel did not open within ${Math.round(upMs / 1000)} seconds`);
      }
    }
  }

  /** Mark `profile` down for `reason`, and try again later, later each time it fails in a row. */
  function down(profile: RemoteProfile, reason: string): void {
    const count = (failures.get(profile.name) ?? 0) + 1;
    failures.set(profile.name, count);
    const delay = Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** (count - 1));
    log(`ticket:serve: cannot reach ${profile.name} over SSH: ${reason}. Trying again in ${Math.round(delay / 1000)} s`);
    const cancel = schedule(() => { if (!closed && states.get(profile.name)?.kind === "down") void connect(profile).catch(() => {}); }, delay);
    states.set(profile.name, { kind: "down", reason, cancel });
  }

  function connect(profile: RemoteProfile): Promise<Link> {
    const pending = open(profile).then(({ link, tunnel }) => {
      if (closed) {
        tunnel.stop();
        throw new Unreachable("the board is closing");
      }
      failures.delete(profile.name);
      states.set(profile.name, { kind: "up", link, stop: tunnel.stop });
      log(`ticket:serve: ${profile.name} is reached over SSH through 127.0.0.1:${link.local}`);
      void tunnel.exited.then((exit) => {
        const now = states.get(profile.name);
        if (closed || now?.kind !== "up" || now.link !== link) return;
        down(profile, `the tunnel dropped: ${redact(exit.stderr) || `ssh exited ${exit.code}`}`);
      });
      return link;
    }, (err: unknown) => {
      const reason = err instanceof Unreachable ? err.message : redact(String((err as Error)?.message ?? err));
      if (!closed) down(profile, reason);
      throw new Unreachable(reason);
    });
    states.set(profile.name, { kind: "connecting", pending });
    return pending;
  }

  return {
    /** Whether `name` is a remote profile. */
    has: (name: string): boolean => byName.has(name),
    /** The open tunnel to `name`, opened now when it has none. THROWS `Unreachable` with the reason when it cannot be reached. */
    async reach(name: string): Promise<Link> {
      const profile = byName.get(name);
      if (profile === undefined) throw new Unreachable(`no remote profile ${name}`);
      if (closed) throw new Unreachable("the board is closing");
      const state = states.get(name)!;
      if (state.kind === "up") return state.link;
      if (state.kind === "connecting") return state.pending;
      if (state.kind === "down") throw new Unreachable(state.reason);
      return connect(profile);
    },
    /** Close `name`'s tunnel, so the next request reads its key again: the remote refused the one held. */
    forget(name: string): void {
      const state = states.get(name);
      if (state?.kind === "up") state.stop();
      if (state?.kind === "down") state.cancel();
      if (state !== undefined && state.kind !== "connecting") states.set(name, { kind: "idle" });
    },
    /** Close every tunnel, and open none again. */
    close(): void {
      closed = true;
      for (const state of states.values()) {
        if (state.kind === "up") state.stop();
        if (state.kind === "down") state.cancel();
      }
    },
  };
}

export type Remotes = ReturnType<typeof createRemotes>;

/** A request rebuilt for the remote board, and what it answered. */
export type Forward = (link: Link, request: Readonly<{ method: string; path: string; body: string | null }>) => Promise<Readonly<{ status: number; body: string }>>;

/** The request a remote board is sent: to the tunnel's port, as its own host, with its key, and nothing of the browser's. */
export function forwardHeaders(link: Pick<Link, "port" | "key">, body: string | null): Record<string, string> {
  return { host: `127.0.0.1:${link.port}`, "x-ticket-token": link.key, accept: "application/json", ...(body === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) };
}

/** Send the request over the tunnel to the remote board. */
export const httpForward: Forward = (link, { method, path, body }) => new Promise((done, fail) => {
  const outgoing = httpRequest({ host: "127.0.0.1", port: link.local, method, path, headers: forwardHeaders(link, body), timeout: FORWARD_MS }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => done({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
    response.on("error", fail);
  });
  outgoing.on("timeout", () => outgoing.destroy(new Error(`no answer within ${FORWARD_MS / 1000} seconds`)));
  outgoing.on("error", fail);
  outgoing.end(body ?? undefined);
});

/**
 * A paired browser's API call to remote profile `name`, passed through its tunnel: the status and JSON value to answer with. A remote that
 * cannot be reached answers 502 with "cannot reach <name> over SSH: <reason>". A remote that refuses the key has it read again next time.
 */
export async function proxy(remotes: Remotes, name: string, request: Readonly<{ method: string; path: string; body: string | null }>, forward: Forward = httpForward): Promise<[number, unknown]> {
  // The key makes a pairing code there, and a code pairs a browser with that board directly. Only this board is paired.
  if (/^\/api\/pair-code(?:[/?]|$)/.test(request.path)) return [403, { error: "another machine's board is not paired from here: only this board is" }];
  let link: Link;
  try {
    link = await remotes.reach(name);
  } catch (err) {
    return [502, { error: `cannot reach ${name} over SSH: ${err instanceof Unreachable ? err.message : redact(String(err))}` }];
  }
  let answer: Readonly<{ status: number; body: string }>;
  try {
    answer = await forward(link, request);
  } catch (err) {
    return [502, { error: `cannot reach ${name}'s board through SSH: ${redact(String((err as Error)?.message ?? err))}. Is agent-org ticket:serve running there?` }];
  }
  if (answer.status === 401) {
    remotes.forget(name);
    return [502, { error: `cannot reach ${name} over SSH: its board refused the key read from it, which is read again on the next request` }];
  }
  let value: unknown;
  try {
    value = JSON.parse(answer.body);
  } catch {
    return [502, { error: `${name}'s board answered with something that is not JSON` }];
  }
  if (request.path === "/api/config" && answer.status === 200 && value !== null && typeof value === "object") {
    const config = value as Record<string, unknown>;
    value = { ...config, terminal: localTerminal(typeof config.terminal === "string" ? config.terminal : null, link.terminalLocal) };
  }
  return [answer.status, value];
}

/** The runner that runs real processes. */
export function processRunner(): Runner {
  const TAIL = 4096;
  const launch = (argv: readonly string[]) => spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  return {
    run: (argv, timeoutMs) => new Promise((done) => {
      const child = launch(argv);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-TAIL); });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (err) => { clearTimeout(timer); done({ code: 127, stdout: "", stderr: err.message }); });
      child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
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
    listening: (port) => new Promise((done) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.on("connect", () => { socket.destroy(); done(true); });
      socket.on("error", () => done(false));
    }),
  };
}
