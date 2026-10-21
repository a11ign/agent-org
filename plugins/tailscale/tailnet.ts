// @ts-check
// module: what the Tailscale plugin does with Tailscale's CLI -- the board's page and the worker terminal served on the tailnet with `tailscale serve`, never Funnel (A11-162: moved from
// `src/ticket-mode/tailnet.ts`, whole)
//
// TAILNET ONLY, BY WHAT THE BOARD'S OWN ENTRIES BUILD. Every serve command `serveArgv` builds for the board names one HTTPS port it serves, and the one that removes an entry names that
// port with `off`. The board's builders name no `funnel` argument, and nothing resets the whole serve config: the agents host serves other things (a Funnel on :443 for `/webhook`, a
// plain serve on :8443), and no command names them. A caller that asks for a path open to the internet (the event receiver's, contract 1.1) says so with `funnel: true`, and gets a
// `funnel` command for that one path. `portState` reads what a port carries, so the caller refuses a port that is public or taken, and the caller runs every command.
//
// PURE: what tailscale answers is passed in as text. The plugin runs tailscale through `deps.exec` (`exposure.ts`), so a test never reaches a real one.

export type TailscaleResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;
export type TailscaleRun = (args: string[]) => TailscaleResult;

/** The tailnet name and address of this machine, read from `tailscale status --json`. */
export type Self = Readonly<{ running: boolean; state: string; name: string | null; ip: string | null }>;

/** A tailnet this board is served on: its MagicDNS name and the HTTPS port `tailscale serve` listens on. */
export type Tailnet = Readonly<{ name: string; port: number }>;

/** Whether a machine's MagicDNS name is held to letters, digits, dots and dashes: it goes into a `Host` list, a URL and a template. */
const NAME = /^[a-z0-9.-]+$/;

/** How long a name's read waits before it is asked again after a failure. */
const RETRY_MS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `tailscale status --json`'s `Self`: its DNS name without the trailing dot, lower-cased; its first address; and whether it is Running. Null for text that is not JSON. */
export function parseStatus(text: string): Self | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const state = typeof parsed.BackendState === "string" ? parsed.BackendState : "unknown";
  const self = isObject(parsed.Self) ? parsed.Self : {};
  const dns = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return Object.freeze({ running: state === "Running", state, name: NAME.test(dns) ? dns : null, ip: typeof ips[0] === "string" ? ips[0] : null });
}

/** The name the board's `Host` may carry, read once from `tailscale status --json`; null when it cannot be read. */
export function readTailnetName(run: TailscaleRun): string | null {
  const result = run(statusArgv());
  if (result.status !== 0) return null;
  return parseStatus(result.stdout)?.name ?? null;
}

/**
 * A name read once it is read, and asked again no sooner than ten seconds after an attempt that found none. A `Host` the board does not know
 * costs no tailscale call past that, so a hostile page cannot make the board start a process per request.
 */
export function cachedTailnetName(read: () => Promise<string | null>, now: () => number = Date.now): () => Promise<string | null> {
  let name: string | null = null;
  let attempted = -Infinity;
  return async () => {
    if (name !== null) return name;
    if (now() - attempted < RETRY_MS) return null;
    attempted = now();
    name = await read();
    return name;
  };
}

/** The tailnet HTTPS ports the page and the terminal are served on when `tailnetPorts` names none (A11-144). */
export const TAILNET_PORT_DEFAULTS = Object.freeze({ ui: 9443, terminal: 9444 });

/** How long one `tailscale` call may take. */
export const TAILSCALE_MS = 20_000;

export const statusArgv = (): string[] => ["status", "--json"];
export const serveStatusArgv = (): string[] => ["serve", "status", "--json"];

/** A path under a port, as the caller names it (`/webhook`) and the `--set-path` flag takes it. */
const pathFlag = (path: string): string => `--set-path=${path}`;

/**
 * Serves `http://127.0.0.1:<local>` on the tailnet's HTTPS `port`, in the background. With a `path` it serves that path only; with `funnel` it is `tailscale funnel`, open to the internet
 * (`--yes` because nobody is at the terminal to answer Funnel's first-time prompt). The board's own call names neither.
 */
export function serveArgv(port: number, local: number, { path, funnel = false }: Readonly<{ path?: string; funnel?: boolean }> = {}): string[] {
  const target = `http://127.0.0.1:${local}`;
  const place = path === undefined ? [] : [pathFlag(path)];
  return funnel ? ["funnel", "--bg", "--yes", `--https=${port}`, ...place, target] : ["serve", "--bg", `--https=${port}`, ...place, target];
}

/** Removes the one entry on the tailnet's HTTPS `port` (or one `path` of it), and no other. */
export function removeArgv(port: number, { path, funnel = false }: Readonly<{ path?: string; funnel?: boolean }> = {}): string[] {
  const place = path === undefined ? [] : [pathFlag(path)];
  return funnel ? ["funnel", "--yes", `--https=${port}`, ...place, "off"] : ["serve", `--https=${port}`, ...place, "off"];
}

/** The proxy target a served port of this board is given: the loopback service on `local`. */
export const proxyOf = (local: number) => `http://127.0.0.1:${local}`;

/** The serve config's entries, by `<name>:<port>`: the web handlers, and the ones Funnel is on for. */
export type ServeStatus = Readonly<{ web: Readonly<Record<string, unknown>>; funnel: Readonly<Record<string, unknown>> }>;

/** `tailscale serve status --json`, or null for text that is not JSON. Empty output is an empty config. */
export function parseServeStatus(text: string): ServeStatus | null {
  if (text.trim() === "") return { web: {}, funnel: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  // A field that is present but not an object is not an empty config: it is unknown, so the caller refuses rather than reads it as free.
  const web = parsed.Web ?? {};
  const funnel = parsed.AllowFunnel ?? {};
  if (!isObject(web) || !isObject(funnel)) return null;
  return Object.freeze({ web, funnel });
}

/**
 * What a tailnet port carries: nothing (`free`), this board's own entry for the loopback `local` (`ours`), or another entry (`foreign`, with the
 * proxy it names). `funnel` is whether Funnel is on for the port, which makes it public whatever else it serves.
 */
export type PortState = Readonly<{ kind: "free" | "ours" | "foreign"; proxy: string | null; funnel: boolean }>;

/** The handlers of a serve entry, by their path. */
function handlersOf(entry: unknown): Record<string, unknown> {
  return isObject(entry) && isObject(entry.Handlers) ? entry.Handlers : {};
}

/** The proxy a handler forwards to, or null when it forwards nowhere this board names. */
function proxyOfHandler(handler: unknown): string | null {
  return isObject(handler) && typeof handler.Proxy === "string" ? handler.Proxy : null;
}

/** The state of `port` on `name`'s tailnet, against the loopback service the board serves there on `local`. */
export function portState(status: ServeStatus, name: string, port: number, local: number): PortState {
  const key = `${name}:${port}`;
  // Funnel is on unless its flag is absent or exactly false: a flag that is some other value is read as on, so a port is never taken for private by mistake.
  const flag = status.funnel[key];
  const funnel = flag !== undefined && flag !== false;
  const entry = status.web[key];
  if (entry === undefined) return Object.freeze({ kind: "free", proxy: null, funnel });
  const handlers = handlersOf(entry);
  const root = proxyOfHandler(handlers["/"]);
  const ours = Object.keys(handlers).length === 1 && root === proxyOf(local);
  return Object.freeze({ kind: ours ? "ours" : "foreign", proxy: root, funnel });
}

/**
 * What one `path` of a tailnet port carries, against the loopback service that should be behind it: nothing (`free`), a proxy to `local` (`ours`), or another handler (`foreign`). `funnel` is
 * whether Funnel is on for the PORT (Funnel is per host and port, not per path).
 */
export function pathState(status: ServeStatus, name: string, port: number, local: number, path: string): PortState {
  const key = `${name}:${port}`;
  const flag = status.funnel[key];
  const funnel = flag !== undefined && flag !== false;
  const handler = handlersOf(status.web[key])[path];
  if (handler === undefined) return Object.freeze({ kind: "free", proxy: null, funnel });
  const proxy = proxyOfHandler(handler);
  return Object.freeze({ kind: proxy?.replace(/\/$/, "") === proxyOf(local) ? "ours" : "foreign", proxy, funnel });
}

/**
 * The `Host` values the board answers to on the tailnet: `<name>:<port>`, and the bare name when the port is 443, since a browser leaves the
 * default port out of the `Host` it sends.
 */
export function tailnetHosts({ name, port }: Tailnet): string[] {
  return port === 443 ? [`${name}:443`, name] : [`${name}:${port}`];
}

/** The `Origin` values a write from the tailnet may carry: the `Host` values over https. */
export const tailnetOrigins = (tailnet: Tailnet): string[] => tailnetHosts(tailnet).map((host) => `https://${host}`);

/** The web address of a run's terminal on the tailnet, with the placeholders the board fills per run. */
export const tailnetTerminal = ({ name, port }: Tailnet) => `https://${name}:${port}/?ws={workspace}&pane={pane}&view=terminal`;

/** The fix when tailscale will not let this user change the serve config: make them its operator. */
export const operatorFix = (user: string) => `sudo tailscale set --operator=${user}`;

/** The refusal when tailscale is not installed or cannot start. */
export const TAILSCALE_MISSING = "tailscale is not on PATH: install Tailscale, then run `tailscale up`";

/** The refusal when this machine is not Running on the tailnet, or has no DNS name. */
export const notRunning = (self: Self) => `Tailscale is not Running on this machine (BackendState ${self.state}): run \`sudo tailscale up\``;
export const noName = "Tailscale has no DNS name for this machine, so there is no name for the board to answer to: run `sudo tailscale up`, and turn MagicDNS on in the admin console";

/**
 * Why a `tailscale` call failed, as a refusal the person can act on: the operator's fix when tailscale refuses the user (its "Access denied" or
 * operator wording), else its own first line unaltered, with the command that was run.
 */
export function refused(result: TailscaleResult, args: string[], user: string): string {
  if (result.status === null) return TAILSCALE_MISSING;
  const text = (result.stderr || result.stdout).trim();
  const command = `tailscale ${args.join(" ")}`;
  if (/access denied/i.test(text)) return `\`${command}\` was refused for ${user}, who is not the operator of this machine's Tailscale: run \`${operatorFix(user)}\`, then start the service again`;
  return `\`${command}\` failed: ${text.split("\n")[0] || `exit ${result.status}`}`;
}
