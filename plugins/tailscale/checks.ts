// @ts-check
// module: the Tailscale plugin's doctor checks (A11-162) -- Tailscale is installed and Running with a name, and each served port has this board's entry, is not on Funnel and answers
//
// Moved out of `install/doctor.ts` (`tailnetChecks`, `servedChecks`, `tailnetAnswers`) with the rows' names and words unchanged, except that a fix names the setting where the plugin
// reads it (`tickets.providers.exposure.tailnetPorts.<service>`). The plugin's rows are asked only for a host that enables it, so a host on `local` is never asked about Tailscale.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { tailnetPortsOf } from "./exposure.ts";
import { parseServeStatus, parseStatus, portState, serveStatusArgv, statusArgv, TAILSCALE_MS, tailnetHosts, type ServeStatus } from "./tailnet.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** How long a served port is given to answer. */
export const ANSWER_MS = 2000;

/** The loopback port the page listens on, when the host names none. */
const DEFAULT_UI_PORT = 4748;

/**
 * The terminal service's default port (`install/terminal.ts` `DEFAULT_TERMINAL_PORT`, which a test of this plugin pins this to): the port `tailscale serve` proxies the terminal to when
 * `terminal` names none on this machine's loopback.
 */
export const DEFAULT_TERMINAL_PORT = 7318;

/** The port of a `terminal` template on this machine's loopback, or null for one served anywhere else. */
export function loopbackPort(template: unknown): number | null {
  if (typeof template !== "string") return null;
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:[/?]|$)/.exec(template.replace(/\{[a-z]+\}/g, "x"));
  return match ? Number(match[1]) : null;
}

/** The checks of one served port: its entry, that it is not on Funnel, and that it answers under the machine's name. */
async function servedChecks(served: { service: string; port: number; local: number }, tailnet: { name: string; ip: string | null }, entries: ServeStatus, deps: PluginDeps): Promise<PluginCheck[]> {
  const { service, port, local } = served;
  const { name, ip } = tailnet;
  const state = portState(entries, name, port, local);
  const url = `https://${name}:${port}/`;
  const setting = `tickets.providers.exposure.tailnetPorts.${service}`;
  const entry = state.kind === "ours" ? ok(`${service} tailnet entry`, `${url} serves 127.0.0.1:${local}`)
    : state.kind === "free" ? failed(`${service} tailnet entry`, `nothing serves port ${port} on the tailnet`, `run \`agent-org start ${service}\``)
      : failed(`${service} tailnet entry`, `port ${port} serves ${state.proxy ?? "another entry"} instead`, `set \`${setting}\` to a port nothing serves, then run \`agent-org start ${service}\``);
  const only = state.funnel
    ? failed(`${service} tailnet only`, `Funnel is on for port ${port}, which makes it public`, `turn Funnel off for port ${port} with \`tailscale funnel --https=${port} off\`, which leaves the other entries alone`)
    : ok(`${service} tailnet only`, `port ${port} is not on Funnel`);
  const status = ip === null ? null : await deps.probe({ host: ip, port, tls: true, servername: name, hostHeader: tailnetHosts({ name, port })[0], timeoutMs: ANSWER_MS });
  const answering = status !== null && status < 500 ? ok(`${service} tailnet answering`, `${url} answers`)
    : failed(`${service} tailnet answering`, `nothing answers ${url}`, state.kind === "ours" ? `read the service's log, then run \`agent-org start ${service}\` to restart it` : `run \`agent-org start ${service}\``);
  return [entry, only, answering];
}

/**
 * The tailnet as the board uses it: this machine is Running with a DNS name, and each served port has its entry, is not on Funnel, and answers under the name. Any `tailscale` call that
 * fails is one row with its fix, and judges no entry from what it could not read.
 */
export async function tailnetChecks(settings: PluginSettings, deps: PluginDeps): Promise<PluginCheck[]> {
  let ports;
  try {
    ports = tailnetPortsOf(settings.tailnetPorts);
  } catch (error) {
    return [failed("tailscale ports", (error as Error).message, "set tickets.providers.exposure.tailnetPorts to two different ports, or remove it")];
  }
  const run = (args: string[]) => deps.exec("tailscale", args, { timeoutMs: TAILSCALE_MS });
  const status = run(statusArgv());
  const self = status.status === 0 ? parseStatus(status.stdout) : null;
  if (self === null || !self.running || self.name === null) {
    if (status.status === null) return [failed("tailscale", "tailscale is not on PATH", "install Tailscale, then run `tailscale up`")];
    const detail = self === null ? "`tailscale status --json` did not answer" : self.running ? "this machine has no DNS name" : `Tailscale is ${self.state}, not Running`;
    return [failed("tailscale", detail, "run `sudo tailscale up`, and turn MagicDNS on in the admin console")];
  }
  const serve = run(serveStatusArgv());
  const entries = serve.status === 0 ? parseServeStatus(serve.stdout) : null;
  if (entries === null) {
    return [ok("tailscale", `Running as ${self.name}`), failed("tailscale serve", "`tailscale serve status --json` did not answer", "run `sudo tailscale up`, then `agent-org doctor` again")];
  }
  const uiPort = typeof settings.uiPort === "number" ? settings.uiPort : DEFAULT_UI_PORT;
  const terminalPort = loopbackPort(settings.terminal) ?? DEFAULT_TERMINAL_PORT;
  const tailnet = { name: self.name, ip: self.ip };
  return [
    ok("tailscale", `Running as ${self.name}`),
    ...await servedChecks({ service: "ui", port: ports.ui, local: uiPort }, tailnet, entries, deps),
    ...await servedChecks({ service: "terminal", port: ports.terminal, local: terminalPort }, tailnet, entries, deps),
  ];
}
