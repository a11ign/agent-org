// @ts-check
// module: the instances the board's page can show, from `~/.config/agent-org/connections.json`, and how each is reached
//
// EACH MACHINE RUNS ONE INSTANCE, BOUND TO 127.0.0.1. A connection names one: `{ "local": true }` is this machine's, read with the key in
// its state directory. `{ "ssh": "<target>" }` is the one on the machine `ssh <target>` reaches, exactly as `herdr --remote <target>` takes
// it, through the tunnel `remote.ts` opens. `{ "https": "<address>", "keyFile": "<path>" }` is one a person has exposed on purpose behind
// TLS, read with the key they copied into a mode-600 file here.
//
// NO FILE IS THIS MACHINE'S INSTANCE ALONE, as `{ "local": { "local": true } }`. A file that breaks a rule below is refused by name, and the
// page then shows that implicit connection only, rather than guess which of the file's connections were meant. A `profiles.json`, the file
// this one replaced, is read as connections when there is no `connections.json`, and the log says so. It is read until the next major version.
//
// THE KEY NEVER CROSSES A NETWORK IN THE CLEAR. Plain http to a host other than this machine's loopback is refused when the file is read,
// before any key is sent. A key file another user owns or can read is refused when it is read, as the instance's own key file is.
//
// THE TARGET REACHES `ssh`'S ARGUMENTS, so it is held to a shape: a name, `user@host`, `host:port` or `ssh://...`, never one that starts with `-`
// (which `ssh` would read as an option) or holds a space or a shell character. `agentOrg`, the remote's command, is run by the remote's shell, so it
// is held to a plain path.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readBoardKey } from "./board-key.ts";
import { createRemotes, localTerminal, redact, Unreachable, type Remotes } from "./remote.ts";

export type LocalConnection = Readonly<{ name: string; kind: "local" }>;
export type SshConnection = Readonly<{ name: string; kind: "ssh"; ssh: string; agentOrg: string }>;
export type HttpsConnection = Readonly<{ name: string; kind: "https"; origin: string; keyFile: string }>;
export type Connection = LocalConnection | SshConnection | HttpsConnection;

/** The connections read, why the file was refused or null, and the profiles file read in its place or null. */
export type ConnectionsRead = Readonly<{ connections: readonly Connection[]; refusal: string | null; migrated: string | null }>;

/** How the page's call reaches an instance: its key, the `Host` it answers to, where to send, and the terminal address the page is given. */
export type Target = Readonly<{
  key: string;
  host: string;
  address: Readonly<{ socket: string } | { origin: string }>;
  terminal: (template: string | null) => string | null;
}>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SSH_TARGET = /^[A-Za-z0-9_.@:/[\]%][A-Za-z0-9_.@:/[\]%-]*$/;
const COMMAND = /^[A-Za-z0-9_./~][A-Za-z0-9_./~-]*$/;
const DEFAULT_AGENT_ORG = "agent-org";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FIELDS = ["local", "ssh", "agentOrg", "https", "keyFile"];
const IMPLICIT: readonly Connection[] = [{ name: "local", kind: "local" }];
const KEY_FILE_REMEDIES = { missing: "copy that instance's board.key there, with mode 600", remake: "copy that instance's board.key there again, with mode 600" };

/** The directory agent-org's config files are in: under `$XDG_CONFIG_HOME` when it is an absolute path, as the XDG rule says, and `~/.config` otherwise. */
export function configDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME;
  return join(base !== undefined && isAbsolute(base) ? base : join(home, ".config"), "agent-org");
}

/** The connections `value` names, in its order. THROWS naming the rule the first bad entry breaks. */
export function parseConnections(value: unknown, home: string = homedir()): Connection[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("it must be a JSON object of connection name to connection");
  const connections = Object.entries(value).map(([name, entry]) => parseConnection(name, entry, home));
  const locals = connections.filter((connection) => connection.kind === "local");
  if (locals.length > 1) throw new Error(`at most one connection can be { "local": true }, this machine's instance, and ${locals.length} are`);
  if (connections.length === 0) throw new Error("it names no connection");
  return connections;
}

function parseConnection(name: string, entry: unknown, home: string): Connection {
  if (!NAME.test(name)) throw new Error(`connection name "${name}" must be 1 to 32 letters, digits, - or _, starting with a letter or digit`);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`connection ${name} must be an object`);
  const fields = entry as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((field) => !FIELDS.includes(field));
  if (unknown.length > 0) throw new Error(`connection ${name} has a field no connection takes: ${unknown.join(", ")}`);
  const kinds = ["local", "ssh", "https"].filter((kind) => fields[kind] !== undefined);
  if (kinds.length !== 1) throw new Error(`connection ${name} must name exactly one of local, ssh or https, and names ${kinds.length === 0 ? "none" : kinds.join(" and ")}`);
  /** Refuses a field this kind of connection does not take. */
  const takesOnly = (allowed: readonly string[], kind: string) => {
    const others = Object.keys(fields).filter((field) => !allowed.includes(field));
    if (others.length > 0) throw new Error(`connection ${name} is ${kind}, so it takes no ${others.join(" or ")}`);
  };
  if (fields.local !== undefined) {
    if (fields.local !== true) throw new Error(`connection ${name}: local must be true, or left out`);
    takesOnly(["local"], "local");
    return { name, kind: "local" };
  }
  if (fields.ssh !== undefined) {
    takesOnly(["ssh", "agentOrg"], "reached over ssh");
    if (typeof fields.ssh !== "string" || !SSH_TARGET.test(fields.ssh)) {
      throw new Error(`connection ${name}: ssh must be an ssh target such as "agents" or "me@host", not starting with - and with no spaces or shell characters`);
    }
    const agentOrg = fields.agentOrg ?? DEFAULT_AGENT_ORG;
    if (typeof agentOrg !== "string" || !COMMAND.test(agentOrg)) throw new Error(`connection ${name}: agentOrg must be a plain path to agent-org on that machine`);
    return { name, kind: "ssh", ssh: fields.ssh, agentOrg };
  }
  takesOnly(["https", "keyFile"], "reached over https");
  return { name, kind: "https", origin: instanceOrigin(name, fields.https), keyFile: keyFilePath(name, fields.keyFile, home) };
}

/** The instance's address as an origin. THROWS for one that is not an address alone, and for plain http to a host other than this machine. */
function instanceOrigin(name: string, value: unknown): string {
  let url: URL | null = null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`connection ${name}: https must be the instance's address, such as "https://agents.example.ts.net"`);
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`connection ${name}: https must be the instance's address alone, with no user, path, query or fragment`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`connection ${name}: plain http to ${url.host} is refused, because it would send the instance's key in the clear: use https`);
  }
  return url.origin;
}

function keyFilePath(name: string, value: unknown, home: string): string {
  const path = typeof value === "string" && value.startsWith("~/") ? join(home, value.slice(2)) : value;
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`connection ${name}: keyFile must be an absolute path, or one starting ~/, to a mode-600 file holding that instance's key`);
  return path;
}

/**
 * The connections in `dir`'s `connections.json`, or in its `profiles.json` when there is no `connections.json`. No file reads as this
 * machine's instance alone. A file that cannot be parsed or breaks a rule is refused naming why, and leaves this machine's instance alone.
 */
export function readConnections(dir: string = configDir(), read: (path: string) => string = (file) => readFileSync(file, "utf8"), home: string = homedir()): ConnectionsRead {
  for (const file of ["connections.json", "profiles.json"]) {
    const path = join(dir, file);
    let text: string;
    try {
      text = read(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { connections: IMPLICIT, refusal: `${path} cannot be read, so only this machine's instance is shown: ${String((err as Error)?.message ?? err)}`, migrated: null };
    }
    const migrated = file === "profiles.json" ? `read ${path} as the connections file: rename it to connections.json, as profiles.json is read only until the next major version` : null;
    try {
      return { connections: parseConnections(JSON.parse(text), home), refusal: null, migrated };
    } catch (err) {
      const reason = err instanceof SyntaxError ? "it is not valid JSON" : String((err as Error).message);
      return { connections: IMPLICIT, refusal: `${path} is refused, so only this machine's instance is shown: ${reason}`, migrated };
    }
  }
  return { connections: IMPLICIT, refusal: null, migrated: null };
}

/** How the page names the way a connection is reached, in its messages. */
export function via(connection: Connection): string {
  if (connection.kind === "local") return "on this machine";
  return connection.kind === "ssh" ? "over SSH" : `at ${connection.origin}`;
}

type Options = Readonly<{
  /** This machine's instance: its port, and the file its key is in. */
  local: Readonly<{ port: number; keyPath: string }>;
  remotes?: Remotes;
  readKey?: typeof readBoardKey;
}>;

/** What reaches each of `connections`. An ssh connection's tunnel is opened the first time it is reached, and held open until `close`. */
export function createConnections(connections: readonly Connection[], options: Options) {
  const byName = new Map(connections.map((connection) => [connection.name, connection]));
  const remotes = options.remotes ?? createRemotes(connections.filter((connection): connection is SshConnection => connection.kind === "ssh"));
  const readKey = options.readKey ?? readBoardKey;
  /** A key file's key, read on each reach so a key that changed is used at once. A file that cannot be used makes its connection unreachable. */
  const keyIn = (path: string, remedies?: Parameters<typeof readBoardKey>[2]): string => {
    try {
      return readKey(path, process.getuid?.(), remedies);
    } catch (err) {
      throw new Unreachable(redact(String((err as Error)?.message ?? err)));
    }
  };

  return {
    /** The connection named `name`, or undefined. */
    get: (name: string): Connection | undefined => byName.get(name),
    /** How to reach `name` now. THROWS `Unreachable` with the reason when it cannot be reached. */
    async reach(name: string): Promise<Target> {
      const connection = byName.get(name);
      if (connection === undefined) throw new Unreachable(`no connection ${name}`);
      if (connection.kind === "local") {
        const { port, keyPath } = options.local;
        return { key: keyIn(keyPath), host: `127.0.0.1:${port}`, address: { origin: `http://127.0.0.1:${port}` }, terminal: (template) => template };
      }
      if (connection.kind === "https") {
        return { key: keyIn(connection.keyFile, KEY_FILE_REMEDIES), host: new URL(connection.origin).host, address: { origin: connection.origin },
          terminal: (template) => localTerminal(template, null) };
      }
      const link = await remotes.reach(name);
      return { key: link.key, host: `127.0.0.1:${link.port}`, address: { socket: link.socket }, terminal: (template) => localTerminal(template, link.terminalLocal) };
    },
    /** Read `name`'s key again on its next reach: its instance refused the one held. Only an ssh connection holds one. */
    forget(name: string): void {
      if (byName.get(name)?.kind === "ssh") remotes.forget(name);
    },
    /** Close every tunnel, and open none again. */
    close: (): void => remotes.close(),
  };
}

export type Connections = ReturnType<typeof createConnections>;
