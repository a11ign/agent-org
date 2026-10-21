// @ts-check
// module: the Tailscale exposure -- the exposure contract (1.1) over `tailscale serve` (A11-162)
//
// The board's page and the worker terminal are served on the tailnet, over HTTPS, on two ports (`tailnetPorts`, 9443 and 9444 by default). Every `tailscale` call is made through `deps.exec`,
// so the contract suite and core's tests run it against a stand-in. What this plugin serves for the board never opens a port to the internet; a caller that asks for a path open to the
// internet (the event receiver's, contract 1.1) names `funnel: true`, and is given a `funnel` command for that one path.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001).
import type { Address, Exposure, PortState, ServedPorts, ServeOptions, ServeResult } from "../../src/plugins/contracts/exposure.ts";
import type { PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import {
  cachedTailnetName, noName, notRunning, parseServeStatus, parseStatus, pathState, portState, refused, removeArgv, serveArgv, serveStatusArgv,
  statusArgv, TAILNET_PORT_DEFAULTS, TAILSCALE_MISSING, TAILSCALE_MS, tailnetHosts, tailnetOrigins, tailnetTerminal, type ServeStatus, type TailscaleResult, type TailscaleRun,
} from "./tailnet.ts";

const SERVE_PORTS_SHAPE = "must be { \"ui\": <port>, \"terminal\": <port> }, each optional, each a port from 1 to 65535";
const BLOCK = "tickets.providers.exposure";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A tailnet HTTPS port: a whole number from 1 to 65535. */
function servePort(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) throw new Error(`${field} must be a port from 1 to 65535, not ${JSON.stringify(value)}`);
  return value as number;
}

/**
 * The ports a `tailnetPorts` setting names: `{ ui, terminal }`, 9443 and 9444 by default. Any other key, a port that is not a port, and two equal ports are each refused by name. The host
 * file's reader (`settings.ts`) refuses the same values at the key the setting was read from, so a bad one is never written; this is the plugin's own check at start.
 */
export function tailnetPortsOf(value: unknown): ServedPorts {
  const at = `${BLOCK}.tailnetPorts`;
  if (value === undefined) return Object.freeze({ ...TAILNET_PORT_DEFAULTS });
  if (!isObject(value) || Object.keys(value).some((key) => key !== "ui" && key !== "terminal")) throw new Error(`${at} ${SERVE_PORTS_SHAPE}`);
  const ports = { ui: servePort(value.ui, `${at}.ui`, TAILNET_PORT_DEFAULTS.ui), terminal: servePort(value.terminal, `${at}.terminal`, TAILNET_PORT_DEFAULTS.terminal) };
  if (ports.ui === ports.terminal) throw new Error(`${at} ui and terminal must be different ports, and both are ${ports.ui}`);
  return Object.freeze(ports);
}

/** The person whose `tailscale` the serve steps need as the operator. */
const userOf = (env: PluginDeps["env"]): string => env.USER ?? env.LOGNAME ?? "<user>";

/** The result of a call, with the sentence a person can act on when it failed. */
function resultOf(run: TailscaleResult, args: string[], user: string): ServeResult {
  return run.status === 0 ? run : { ...run, refusal: refused(run, args, user) };
}

/** Why a port cannot be taken for `service`, naming the setting to change: it is on Funnel, which makes it public, or another entry holds it. Null when it is free or this board's. */
function takenBecause(port: number, service: string, state: PortState): string | null {
  const setting = `${BLOCK}.tailnetPorts.${service}`;
  if (state.funnel) return `port ${port} is on Funnel, which makes it public, and the board is never served on Funnel: set \`${setting}\` to a port nothing serves`;
  if (state.kind === "foreign") return `port ${port} already serves ${state.proxy ?? "another entry"} on the tailnet, and the board will not replace it: set \`${setting}\` to a port nothing serves`;
  return null;
}

/** The Tailscale exposure: `settings` are the block's, and `deps` give it `exec` and the environment. REFUSES a `tailnetPorts` of the wrong shape, by name. */
export function createExposure(settings: PluginSettings, deps: Pick<PluginDeps, "exec" | "env">): Exposure {
  const ports = tailnetPortsOf(settings.tailnetPorts);
  const user = userOf(deps.env);
  const run: TailscaleRun = (args) => deps.exec("tailscale", args, { timeoutMs: TAILSCALE_MS });
  /** The name once it is known: a name read is kept, so one start asks `tailscale status` once however many of the operations below need it. */
  let known: string | null = null;

  /** Asks Tailscale who this machine is, now: its name on the tailnet, or the sentence that says why it has none. */
  function askName(): { name: string } | { why: string } {
    const status = run(statusArgv());
    if (status.status === null) return { why: TAILSCALE_MISSING };
    const self = status.status === 0 ? parseStatus(status.stdout) : null;
    if (self === null) return { why: refused(status, statusArgv(), user) };
    if (!self.running) return { why: notRunning(self) };
    if (self.name === null) return { why: noName };
    known = self.name;
    return { name: self.name };
  }

  /** This machine's name on the tailnet, as it is known, else as Tailscale says. */
  const selfName = (): { name: string } | { why: string } => (known === null ? askName() : { name: known });

  const nameOnce = cachedTailnetName(async () => {
    const self = selfName();
    return "name" in self ? self.name : null;
  });

  /** The serve config as the machine holds it, or the sentence that says why it cannot be read. */
  function serveConfig(): { config: ServeStatus } | { why: string } {
    const result = run(serveStatusArgv());
    const config = result.status === 0 ? parseServeStatus(result.stdout) : null;
    return config === null ? { why: refused(result, serveStatusArgv(), user) } : { config };
  }

  function stateOf(port: number, local: number, path: string | undefined): PortState {
    const self = selfName();
    if ("why" in self) throw new Error(self.why);
    const read = serveConfig();
    if ("why" in read) throw new Error(read.why);
    return path === undefined ? portState(read.config, self.name, port, local) : pathState(read.config, self.name, port, local, path);
  }

  return {
    machineName: nameOnce,
    hosts: (address: Address) => tailnetHosts(address),
    origins: (address: Address) => tailnetOrigins(address),
    terminal: (address: Address) => tailnetTerminal(address),
    serve(port: number, local: number, options: ServeOptions = {}): ServeResult {
      const args = serveArgv(port, local, options);
      return resultOf(run(args), args, user);
    },
    unserve(port: number, options: ServeOptions = {}): ServeResult {
      const args = removeArgv(port, options);
      return resultOf(run(args), args, user);
    },
    portState: (port, local, options) => stateOf(port, local, options?.path),
    ports: () => ports,
    readiness() {
      const self = askName();
      return "why" in self ? self.why : null;
    },
    claim(port, local, service) {
      try {
        return takenBecause(port, service, stateOf(port, local, undefined));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    served() {
      const read = serveConfig();
      if ("why" in read) throw new Error(read.why);
      return Object.keys(read.config.web);
    },
  };
}
