// @ts-check
// module: the web terminal ticket mode links each run to -- herdr web ui, serving the `tickets.herdrSession` herdr session on 127.0.0.1
//
// THE BOARD LINKS A RUN TO ITS LIVE WORKER ONLY WHEN `tickets.terminal` IS SET AND SOMETHING SERVES IT (A11-66). Until this module, a person did
// that by hand: install bun, `herdr plugin install devswha/herdr-web-ui`, write a unit that runs the plugin's supervisor against the tickets session,
// and write `tickets.terminal`. On the agents host, on 2026-10-17, that took one unit and one wrong variable: the plugin reads `HERDR_SOCKET`, and a
// unit that set only `HERDR_SOCKET_PATH` attached to herdr's DEFAULT session, failed its own health check and restarted in a loop. So the variable is
// named here once, and a test pins it.
//
// One service per machine, for the one session ticket mode runs in, on loopback only: another machine's board reaches it through the SSH tunnel
// `ticket:ui` already opens (README, "Connect a second machine over SSH"). The plugin's state and config directories carry the session's name, so
// they never share a file with a web ui a person runs for herdr's default session.
//
// PURE: what is installed is read by the caller and passed in.
import { isAbsolute, join } from "node:path";
import type { Env } from "./paths.ts";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { pluginEntries } from "./herdr-plugins.ts";

/** The plugin, as `herdr plugin install` takes it: its GitHub repository. `plugins.json` is read by that source, never by the manifest id, which a release can rename (A11-287). */
export const TERMINAL_PLUGIN = "devswha/herdr-web-ui";
export const DEFAULT_TERMINAL_PORT = 7318;
export const DEFAULT_HERDR_SESSION = "tickets";

/** herdr's own directory: `$XDG_CONFIG_HOME/herdr` when that is absolute, `~/.config/herdr` otherwise, on macOS as on Linux. */
export function herdrConfigDir(env: Env, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config"), "herdr");
}

/** The socket of the herdr session `session`: `<herdr>/sessions/<session>/herdr.sock`. */
export const herdrSocket = (env: Env, home: string, session: string) => join(herdrConfigDir(env, home), "sessions", session, "herdr.sock");

/**
 * The plugin's installed directory, from the text of herdr's `plugins.json`: the root of the current copy of `TERMINAL_PLUGIN` (the newest release when a renamed id left two), or null when it is
 * not installed or the file is not herdr's.
 */
export const pluginRoot = (pluginsJson: string | null): string | null => pluginEntries(pluginsJson, TERMINAL_PLUGIN)?.current.root ?? null;

/** The `tickets.terminal` onboard writes for a terminal service on `port`. */
export const terminalAddress = (port: number) => `http://127.0.0.1:${port}/?ws={workspace}&pane={pane}&view=terminal`;

/** The port of a `tickets.terminal` on this machine's loopback, or null for one served anywhere else (or not a web address at all). */
export function loopbackPort(template: unknown): number | null {
  if (typeof template !== "string") return null;
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:[/?]|$)/.exec(template.replace(/\{[a-z]+\}/g, "x"));
  return match ? Number(match[1]) : null;
}

/**
 * The port of the worker terminal this machine serves, as its service listens on it, or null when another machine serves the address `terminal`
 * names. That is `tickets.terminal`'s loopback port, or, when the address is this machine's own tailnet name (`tailnetName`, read while the board is
 * on the tailnet), the default port the service is started on, as `terminalTarget` reads it. PURE.
 */
export function localTerminalPort(terminal: string | null, tailnetName: string | null): number | null {
  const port = loopbackPort(terminal);
  if (port !== null) return port;
  if (terminal === null || tailnetName === null) return null;
  try {
    return new URL(terminal.replace(/\{[a-z]+\}/g, "x")).hostname === tailnetName ? DEFAULT_TERMINAL_PORT : null;
  } catch {
    return null;
  }
}

/**
 * `tickets.terminal` as the board hands it to the page. Served on the tailnet, a stored address on this machine's loopback, or none, is replaced by
 * the tailnet's address, and another machine's address is kept. The stored value itself stays as it is: `terminalTarget` reads the port from it.
 */
export function effectiveTerminal(stored: string | null, tailnetAddress: string | null): string | null {
  if (tailnetAddress === null || (stored !== null && loopbackPort(stored) === null)) return stored;
  return tailnetAddress;
}

/** The session and port the terminal service serves, from the host file's JSON: `tickets.herdrSession`, and the port `tickets.terminal` names. */
export function terminalTarget(host: unknown): { session: string; port: number } {
  const tickets = typeof host === "object" && host !== null && !Array.isArray(host) ? (host as Record<string, unknown>).tickets : undefined;
  const block = typeof tickets === "object" && tickets !== null && !Array.isArray(tickets) ? (tickets as Record<string, unknown>) : {};
  const session = typeof block.herdrSession === "string" && /^[A-Za-z0-9_-]+$/.test(block.herdrSession) ? block.herdrSession : DEFAULT_HERDR_SESSION;
  return { session, port: loopbackPort(exposureTerminal(host)) ?? DEFAULT_TERMINAL_PORT };
}

/** The terminal address the host file names, where the exposure block holds it (A11-144) or the old `tickets.terminal` still does; undefined when neither can be read. */
function exposureTerminal(host: unknown): unknown {
  try {
    return resolveProviders(host).blocks.exposure.settings.terminal?.value;
  } catch {
    return undefined;
  }
}

/** The directory herdr web ui keeps its settings in for `session`: `HERDR_PLUGIN_CONFIG_DIR`, where its token and `pair` read them. */
export const pluginConfigDir = (home: string, session: string) => join(home, ".config", `herdr-web-ui-${session}`);

/** How a person pairs a new device, for the board and for the worker terminal: `onboard`'s last message, `doctor`'s `pairing` check and the README say it. */
export const PAIRING_STEPS = "to pair a new device, run `agent-org ticket:pair` for the board, and `agent-org ticket:pair --terminal` for the worker terminal; with `tickets.serve` set, `agent-org ticket:pair` prints both codes";

export type TerminalProgram = Readonly<{ argv: string[]; environment: Record<string, string>; workingDirectory: string }>;

/** What the terminal service runs: the plugin's supervisor under bun, on loopback, attached to `session`'s socket. PURE. */
export function terminalProgram({ env, home, session, port, root, bun, path }: {
  env: Env; home: string; session: string; port: number; root: string; bun: string; path: string;
}): TerminalProgram {
  const bunDir = bun.slice(0, bun.lastIndexOf("/"));
  return {
    argv: [bun, join(root, "server", "supervisor.ts")],
    workingDirectory: root,
    environment: {
      PORT: String(port),
      HOST: "127.0.0.1",
      // HERDR_SOCKET, not HERDR_SOCKET_PATH: the plugin reads this one, and without it attaches to herdr's default session.
      HERDR_SOCKET: herdrSocket(env, home, session),
      HERDR_PLUGIN_ROOT: root,
      HERDR_PLUGIN_STATE_DIR: join(home, ".local", "state", `herdr-web-ui-${session}`),
      HERDR_PLUGIN_CONFIG_DIR: pluginConfigDir(home, session),
      HERDR_WEB_TELEMETRY: "0",
      // The supervisor starts its own children with `bun`, so bun's directory is first.
      PATH: path.split(":").includes(bunDir) ? path : `${bunDir}:${path}`,
    },
  };
}

/**
 * The plugin's own `pair` command, run under the terminal service's environment, so the plugin reads the same directories, token and port the
 * service runs with and no path is typed (A11-93). PURE: its environment is `terminalProgram`'s, so the two cannot drift.
 */
export function terminalPairProgram(options: Parameters<typeof terminalProgram>[0]): TerminalProgram {
  return { argv: [options.bun, join(options.root, "scripts", "plugin.ts"), "pair"], workingDirectory: options.root, environment: terminalProgram(options).environment };
}
