// @ts-check
// module: activation -- the plugins a host enables, loaded once, and the accessor core asks for the implementation of a concern (A11-159)
//
// THE LOADER IS ASYNC AND THE CONTRACTS ARE NOT. A plugin's entry module is imported with `import()`, but the tracker contract's `TicketSource` is used by code that already holds
// one (`createBoard`'s `ctx.source`). So an entry that needs a plugin awaits `activatePlugins` once, at its start, and asks the result for the implementation: `ticket:serve`
// for the board, `pr:open` for the tracker it reads, and nothing else on a call path. A plugin's refusal refuses the start by name, as a refused host file does. A11-160, A11-162 and A11-161 add
// the accessor of each concern they move to this module.
//
// MEMOIZED PER PROCESS: the second call returns the first's result, whatever it is given. A test calls `forgetActivation`.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { Providers } from "../ticket-mode/providers.ts";
import type { PickScope } from "../ticket-mode/settings.ts";
import type { TicketSource } from "./contracts/tracker.ts";
import { type ImportModule, loadEnabled } from "./loader.ts";
import type { Catalog, ExecResult, LoadedPlugin, PluginDeps } from "./manifest.ts";

/** A plugin that cannot run the host, or a concern with nothing to run it: the start is refused with the reason, naming the concern and the plugin. */
export class PluginActivationRefusal extends Error {}

/** The plugins the host enabled, loaded: ask for a concern's implementation. */
export type Active = Readonly<{
  loaded: readonly LoadedPlugin[];
  /** The enabled tracker plugin's source. REFUSES when the tracker block names a plugin with no code to run on a host (a fake, or a built-in). */
  tracker(): TicketSource;
}>;

const refused = (message: string): never => {
  throw new PluginActivationRefusal(message);
};

function trackerOf(providers: Providers, loaded: readonly LoadedPlugin[]): TicketSource {
  const { provider } = providers.blocks.tracker;
  const plugin = loaded.find(({ plugin: candidate }) => candidate.concern === "tracker");
  if (plugin === undefined) return refused(`the tracker is ${provider}, which has no code to run on a host: name a bundled tracker plugin in tickets.providers.tracker (\`agent-org plugin list\`)`);
  return plugin.implementation as TicketSource;
}

/** Loads the bundled plugins `providers` enables and answers their implementations. REFUSES, naming each plugin, any the loader refuses. Not memoized: see {@link activatePlugins}. */
export async function loadActive(providers: Providers, catalog: Catalog, deps: PluginDeps, importModule?: ImportModule): Promise<Active> {
  const { loaded, refusals } = await loadEnabled(providers, catalog, deps, importModule);
  if (refusals.length > 0) return refused(refusals.map(({ plugin, concern, why }) => `the ${concern} plugin ${plugin} was refused: ${why}`).join("; "));
  return { loaded, tracker: () => trackerOf(providers, loaded) };
}

let activation: Promise<Active> | null = null;

/** {@link loadActive}, once per process. */
export function activatePlugins(providers: Providers, catalog: Catalog, deps: PluginDeps, importModule?: ImportModule): Promise<Active> {
  activation ??= loadActive(providers, catalog, deps, importModule);
  return activation;
}

/** Forgets the activation, so a test starts from none. */
export function forgetActivation(): void {
  activation = null;
}

/** Runs `file` for real: the program's exit status (null when it could not start) and what it printed. `inherit` gives it this process's terminal. */
export function realExec(file: string, args: readonly string[], options: Readonly<{ inherit?: boolean }> = {}): ExecResult {
  const result = options.inherit === true ? spawnSync(file, [...args], { stdio: "inherit", encoding: "utf8" }) : spawnSync(file, [...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A file's permission bits, or null when it cannot be read. */
export function realMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** The deps core gives a plugin on this machine: the real `fetch`, programs and files. `pick` is the board's `tickets.pick`. */
export function realPluginDeps({ env, stateDir, pick }: Readonly<{ env: Readonly<Record<string, string | undefined>>; stateDir: string; pick: PickScope }>): PluginDeps {
  return { env, stateDir, pick, log: (line) => process.stderr.write(`${line}\n`), fetch: (input, init) => fetch(input, init), exec: realExec, readFile: (path) => readFileSync(path, "utf8"), mode: realMode };
}
