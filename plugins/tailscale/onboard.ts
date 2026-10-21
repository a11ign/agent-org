// @ts-check
// module: the Tailscale plugin's onboard steps, and what happens to the machine when the plugin stops being the exposure (A11-162)
//
// Three steps, in order. The first says Tailscale is not installed (it was onboard's line when the exposure was tailscale, moved with its words); the second says what the operator must
// run when Tailscale refuses this user's serve calls (it was said only when a service failed to start); the third names the ports the board and the terminal will be served on, says
// when one is taken, and writes the default ports into the block when it names none (the profile did, in core). None stops onboard: the services are started afterwards and serve
// their own entries (`agent-org start`), and `agent-org doctor` says what is still missing.
//
// `release` is the other half: before this plugin is switched off, its entries leave the tailnet (see `PluginModule.release`).
import type { OnboardStep, PluginDeps, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { DEFAULT_TERMINAL_PORT, loopbackPort } from "./checks.ts";
import { createExposure, tailnetPortsOf } from "./exposure.ts";
import { operatorFix, serveStatusArgv, statusArgv, TAILNET_PORT_DEFAULTS, TAILSCALE_MS } from "./tailnet.ts";

/** What onboard says when `tailscale` cannot start. */
export const NOT_ON_PATH = "tailscale is not on PATH: the board and the terminal are served on the tailnet once Tailscale is installed and `tailscale up` has run. `agent-org doctor` says what is missing";

const DEFAULT_UI_PORT = 4748;

const user = (deps: Pick<PluginDeps, "env">): string => deps.env.USER ?? deps.env.LOGNAME ?? "<user>";

/** Whether Tailscale's CLI starts. */
const isInstalled = (deps: Pick<PluginDeps, "exec">): boolean => deps.exec("tailscale", statusArgv(), { timeoutMs: TAILSCALE_MS }).status !== null;

/** The loopback ports the board's page and the terminal listen on, which `tailscale serve` proxies to. */
export function localPortsOf(settings: PluginSettings): Readonly<{ ui: number; terminal: number }> {
  return { ui: typeof settings.uiPort === "number" ? settings.uiPort : DEFAULT_UI_PORT, terminal: loopbackPort(settings.terminal) ?? DEFAULT_TERMINAL_PORT };
}

export const ONBOARD_STEPS: readonly OnboardStep[] = [
  {
    name: "tailscale installed",
    explain: "Says so when Tailscale is not on PATH: the board is served on the tailnet once it is installed and `tailscale up` has run.",
    async run(_settings, deps): Promise<StepResult> {
      return { ok: true, detail: isInstalled(deps) ? "" : NOT_ON_PATH };
    },
  },
  {
    name: "tailscale operator",
    explain: "Says the command to run when Tailscale will not let this user change its serve config: make the user its operator.",
    async run(_settings, deps): Promise<StepResult> {
      if (!isInstalled(deps)) return { ok: true, detail: "" };
      const result = deps.exec("tailscale", serveStatusArgv(), { timeoutMs: TAILSCALE_MS });
      const denied = result.status !== 0 && /access denied/i.test(result.stderr || result.stdout);
      return denied ? { ok: false, detail: `${user(deps)} is not the operator of this machine's Tailscale, which the board's serve entries need: run \`${operatorFix(user(deps))}\`` } : { ok: true, detail: "" };
    },
  },
  {
    name: "tailnet ports",
    explain: "Names the tailnet ports the board and the terminal are served on (9443 and 9444 unless the block says), says when one is taken, and, for a profile, writes the defaults into the block when it names none.",
    async run(settings, deps): Promise<StepResult> {
      const ports = tailnetPortsOf(settings.tailnetPorts);
      // The defaults are written out for a profile, as the profile always did; an interactive onboard leaves a block that names none alone, so a re-onboard changes no host file's meaning.
      const written: PluginSettings = settings.tailnetPorts === undefined && deps.answered ? { tailnetPorts: { ...TAILNET_PORT_DEFAULTS } } : {};
      if (!isInstalled(deps)) return { ok: true, detail: "", settings: written };
      const exposure = createExposure(settings, deps);
      const local = localPortsOf(settings);
      const taken = (["ui", "terminal"] as const).map((service) => exposure.claim(ports[service], local[service], service)).filter((why) => why !== null);
      return { ok: taken.length === 0, detail: taken.join("; "), settings: written };
    },
  },
];

/**
 * Takes this board's entries off the tailnet, before the plugin stops being the enabled exposure: each port the plugin serves whose entry is this board's (`ours`) is removed, and no other.
 * A port that is free, or another's, is left as it is. Tailscale that cannot say what it serves (not installed, not Running, not the operator) refuses, by name, so the host file and the
 * machine never disagree: nothing is released that cannot be proven this board's.
 */
export function release(settings: PluginSettings, deps: PluginDeps): StepResult {
  const exposure = createExposure(settings, deps);
  const ports = exposure.ports();
  if (ports === null) return { ok: true, detail: "" };
  const local = localPortsOf(settings);
  const removed: string[] = [];
  for (const service of ["ui", "terminal"] as const) {
    const port = ports[service];
    let state;
    try {
      state = exposure.portState(port, local[service]);
    } catch (error) {
      return { ok: false, detail: `cannot take the ${service} entry on tailnet port ${port} off: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (state.kind !== "ours") continue;
    const result = exposure.unserve(port);
    if (result.status !== 0) return { ok: false, detail: `cannot take the ${service} entry on tailnet port ${port} off: ${result.refusal ?? result.stderr}` };
    removed.push(`${service} (port ${port})`);
  }
  return { ok: true, detail: removed.length === 0 ? "" : `took this board's tailscale serve entries off the tailnet: ${removed.join(", ")}` };
}
