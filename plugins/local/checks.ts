// @ts-check
// module: the local plugin's doctor checks (A11-162) -- the instance and the page answer on loopback, and the terminal address is this machine's own
//
// It never calls Tailscale. The entries a tailscale exposure served are taken off the tailnet when the switch to this plugin releases them (`agent-org plugin enable local`), and a
// switch that cannot release them is refused, so there is nothing for this plugin to look for on the tailnet.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** How long a loopback port is given to answer. */
export const ANSWER_MS = 2000;

const DEFAULT_PORT = 4747;
const DEFAULT_UI_PORT = 4748;

/** The port of a `terminal` template on this machine's loopback, or null for one served anywhere else. */
export function loopbackPort(template: unknown): number | null {
  if (typeof template !== "string") return null;
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:[/?]|$)/.exec(template.replace(/\{[a-z]+\}/g, "x"));
  return match ? Number(match[1]) : null;
}

const portOf = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

/** The instance's port and the page's both answer on 127.0.0.1: a service that is registered but crashed does not. */
async function portsCheck(settings: PluginSettings, deps: PluginDeps): Promise<PluginCheck> {
  const ports = [{ service: "instance", port: portOf(settings.port, DEFAULT_PORT) }, { service: "ui", port: portOf(settings.uiPort, DEFAULT_UI_PORT) }];
  const silent: string[] = [];
  for (const { service, port } of ports) {
    if (await deps.probe({ host: "127.0.0.1", port, tls: false, timeoutMs: ANSWER_MS }) === null) silent.push(`${service} (port ${port})`);
  }
  return silent.length === 0 ? ok("local ports", ports.map(({ service, port }) => `${service} answers on 127.0.0.1:${port}`).join(", "))
    : failed("local ports", `nothing answers on 127.0.0.1 for the ${silent.join(" and the ")}`, `run \`agent-org start ${silent[0].startsWith("instance") ? "instance" : "ui"}\``);
}

/** The terminal address is this machine's loopback (the board links a run to it), unset (nothing to link, which the terminal rows say), or another machine's (that machine's to serve). */
function terminalCheck(settings: PluginSettings): PluginCheck {
  const address = typeof settings.terminal === "string" ? settings.terminal : null;
  if (address === null) return ok("local terminal", "no terminal address is set, so the board links no run to a terminal");
  return loopbackPort(address) === null ? ok("local terminal", `the terminal address is ${address}, served by another machine`)
    : ok("local terminal", `the terminal address is on this machine's loopback, port ${loopbackPort(address)}`);
}

/** The rows of the local exposure. */
export async function localChecks(settings: PluginSettings, deps: PluginDeps): Promise<PluginCheck[]> {
  return [await portsCheck(settings, deps), terminalCheck(settings)];
}
