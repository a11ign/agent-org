// @ts-check
// module: reads the plugins' health for doctor and for the Settings page's `GET /api/plugins` (A11-163)
//
// THE CALLER NAMES WHAT IS READ. Loading imports only the bundled plugins the host enables, and asking each for its doctor checks runs programs (`security`, `claude mcp list`, `gh`), so
// this is async and is its own call on the page: the rest of the page must not wait on it. ONE PLUGIN'S FAILURE NEVER STOPS THE OTHERS: a plugin whose checks throw is one failing
// row of its own, and the rest are read as usual. What comes back is `pluginHealth`'s account, which doctor and the page both draw.
import { liveToolVersion } from "../lib/tool-version.ts";
import type { Providers } from "../ticket-mode/providers.ts";
import { blockOf, type ProviderBlock } from "./concerns.ts";
import { type Failure, pluginHealth, type PluginHealth } from "./health.ts";
import { type LoadResult, settingsOfBlock } from "./loader.ts";
import type { Catalog, PluginCheck, PluginDeps } from "./manifest.ts";
import type { MessagingState } from "./view.ts";

export type HealthSources = Readonly<{
  catalog: Catalog;
  providers: Providers;
  /** The blocks to load: all of them, or the code host alone for a host file the reader refused. */
  blocks: readonly ProviderBlock[];
  deps: PluginDeps;
  load: (providers: Providers, catalog: Catalog, deps: PluginDeps, blocks: readonly ProviderBlock[]) => Promise<LoadResult>;
  /** The project's `messaging` key, and the checks of the plugin it names. Absent: messaging is not read. */
  messaging?: Readonly<{ state: () => Promise<MessagingState>; checks: () => Promise<readonly PluginCheck[]> }>;
  version: string;
}>;

const NOT_READ: MessagingState = { provider: null, why: "the host file is refused, so project.json is not read" };
const MESSAGING_FIX = "fix the messaging key of project.json: `agent-org messaging:check` says what is wrong with it";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** agent-org's own release, `vX.Y.Z`, read off the checkout. A checkout at no release says so, and one whose version cannot be read says that: it never throws. */
export function toolVersionOf(): string {
  try {
    return liveToolVersion() ?? "no release tag";
  } catch {
    return "version unreadable";
  }
}

/** A plugin's doctor checks, or the one failing row a plugin whose checks threw is. */
async function checksOf(name: string, run: () => PluginCheck[] | readonly PluginCheck[] | Promise<readonly PluginCheck[]>): Promise<readonly PluginCheck[]> {
  try {
    return await run();
  } catch (error) {
    return [{ name: `plugin ${name}`, ok: false, detail: `its checks could not run: ${messageOf(error)}`, fix: "update agent-org, or the plugin" }];
  }
}

async function messagingOf(sources: HealthSources, checks: Record<string, readonly PluginCheck[]>): Promise<{ state: MessagingState; failure: Failure | null }> {
  if (sources.messaging === undefined) return { state: NOT_READ, failure: null };
  const state = await sources.messaging.state();
  if (state.provider === null || !state.enabled) return { state, failure: null };
  try {
    checks[state.provider] = await sources.messaging.checks();
    return { state, failure: null };
  } catch (error) {
    return { state, failure: { why: messageOf(error), fix: MESSAGING_FIX } };
  }
}

/** Loads the plugins the host enables, asks each for its checks, and answers the account of every concern and plugin. */
export async function readPluginHealth(sources: HealthSources): Promise<PluginHealth> {
  const { catalog, providers, deps } = sources;
  const load = await sources.load(providers, catalog, deps, sources.blocks);
  const checks: Record<string, readonly PluginCheck[]> = {};
  for (const { plugin, module } of [...load.loaded, ...load.unbuilt]) {
    const block = blockOf(plugin.concern);
    if (block !== null) checks[plugin.name] = await checksOf(plugin.name, () => module.doctorChecks(settingsOfBlock(providers.blocks[block]), deps));
  }
  const { state, failure } = await messagingOf(sources, checks);
  return pluginHealth({ catalog, providers, messaging: state, load, checks, messagingFailure: failure, version: sources.version });
}
