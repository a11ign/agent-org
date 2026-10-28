// @ts-check
// module: the loader -- imports the code of the plugins a host enables, and no other (A11-158)
//
// ONLY WHAT IS ENABLED IS IMPORTED. A disabled plugin's code is never read to list it or to check its version (the registry reads its manifest data). A built-in is
// skipped, since core still runs it, and so is a fake, which runs no host. A bundled plugin's entry module is imported by file URL from the checkout (ADR 0001), and
// its `create(settings, deps)` is called with the block's settings and every runtime helper it may use.
//
// IT REFUSES AN UNSUPPORTED CONTRACT MAJOR BY NAME, again: the reader refuses the host file that enables one at start, and this refuses to import its code, so a caller
// that built its own settings cannot load what the reader would have refused. A failure of one plugin is one refusal of the result, and the others still load: the
// caller that starts the board throws on any refusal, and doctor says each as a row.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { type Concern, PROVIDER_BLOCKS, type ProviderBlock } from "./concerns.ts";
import { type BlockReport, DEFAULT_PROVIDER, type Providers } from "../ticket-mode/providers.ts";
import type { Catalog, CatalogPlugin, LoadedPlugin, PluginDeps, PluginModule, PluginSettings } from "./manifest.ts";
import { blockSettings, pluginNamed } from "./registry.ts";
import { readsConcernContract, unreadMajorRefusal } from "./version.ts";
import { callOutcomes, countedFetch, type CallLedger } from "../ticket-mode/call-outcomes.ts";

/**
 * What loading found: the plugins that loaded, and one refusal for each that did not, naming it. A plugin whose module imported but whose `create` threw is a refusal and also
 * `unbuilt`, so doctor can still run its checks: the checks are how a person learns why `create` threw (a key that cannot be read), and they need no implementation.
 */
export type LoadResult = Readonly<{
  loaded: readonly LoadedPlugin[];
  unbuilt: readonly Readonly<{ plugin: CatalogPlugin; module: PluginModule }>[];
  refusals: readonly Readonly<{ plugin: string; concern: Concern; why: string }>[];
}>;

/**
 * The deps a plugin of `concern` is given: a tracker's `fetch` and `freshFetch` count every request it makes as the board's `linear` figure (A11-363), since core names no tracker's address; every other
 * plugin gets `deps` as they are.
 */
export function depsFor(concern: Concern, deps: PluginDeps, ledger: CallLedger = callOutcomes): PluginDeps {
  if (concern !== "tracker") return deps;
  return { ...deps, fetch: countedFetch(deps.fetch, ledger, "linear"), ...(deps.freshFetch === undefined ? {} : { freshFetch: countedFetch(deps.freshFetch, ledger, "linear") }) };
}

/** Imports a module by its file URL: the default is `import()`, and a test passes its own. */
export type ImportModule = (url: string) => Promise<unknown>;

/** The values of a block's settings: a setting the file does not hold is left out. */
export function settingsOfBlock(report: BlockReport): PluginSettings {
  return Object.fromEntries(Object.entries(report.settings).filter(([, setting]) => setting.value !== undefined).map(([name, setting]) => [name, setting.value]));
}

export const isPluginModule = (value: unknown): value is PluginModule => typeof value === "object" && value !== null
  && typeof (value as PluginModule).create === "function" && typeof (value as PluginModule).doctorChecks === "function" && Array.isArray((value as PluginModule).onboardSteps);

/** The reason a bundled plugin cannot be loaded, or null when it can. */
export function refusalOf(plugin: CatalogPlugin): string | null {
  if (!readsConcernContract(plugin.concern, plugin.contract)) return unreadMajorRefusal(plugin.name, plugin.concern, plugin.contract);
  return null;
}

/** A bundled plugin's entry module, imported and checked: REFUSES, by name, a contract major this agent-org does not read and a module that is not a plugin's. */
export async function importPlugin(plugin: CatalogPlugin, importModule: ImportModule = (url) => import(url)): Promise<PluginModule> {
  const refusal = refusalOf(plugin);
  if (refusal !== null) throw new Error(refusal);
  if (plugin.dir === null || plugin.entry === null) throw new Error(`plugin ${plugin.name} is bundled but names no entry module`);
  const module = await importModule(pathToFileURL(join(plugin.dir, plugin.entry)).href);
  if (!isPluginModule(module)) throw new Error(`plugin ${plugin.name}: ${plugin.entry} must export create, doctorChecks and onboardSteps`);
  return module;
}

/**
 * The entry modules of the bundled plugins the host enables, imported and NOT built: `create` is not called, so nothing is read or asked of the machine. A caller that needs only
 * what a module exports (`agent-org update` asks each for what it `keep`s) uses this, so it does not read a tracker's key for it. A plugin that cannot be imported is a refusal, by name.
 */
export async function importEnabled(providers: Providers, catalog: Catalog, importModule: ImportModule = (url) => import(url)): Promise<Readonly<{
  modules: readonly Readonly<{ plugin: CatalogPlugin; module: PluginModule }>[]; refusals: LoadResult["refusals"];
}>> {
  const modules: { plugin: CatalogPlugin; module: PluginModule }[] = [];
  const refusals: { plugin: string; concern: Concern; why: string }[] = [];
  for (const block of PROVIDER_BLOCKS) {
    const report = providers.blocks[block];
    const plugin = report.enabled ? pluginNamed(catalog, report.provider) : undefined;
    if (plugin === undefined || plugin.where !== "bundled") continue;
    try {
      modules.push({ plugin, module: await importPlugin(plugin, importModule) });
    } catch (error) {
      refusals.push({ plugin: plugin.name, concern: plugin.concern, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { modules, refusals };
}

/**
 * Load the bundled plugins the host enables: for each block of `providers` that names a plugin and is enabled, import it and call `create`. A disabled block, a
 * block that names `none`, a built-in and a fake are skipped, and their code is not read. `blocks` narrows it to some blocks, for a caller that needs one concern and
 * must not build the others (`ticket:review` needs the code host, and must not read the tracker's key for it).
 */
export async function loadEnabled(providers: Providers, catalog: Catalog, deps: PluginDeps, importModule: ImportModule = (url) => import(url), blocks: readonly ProviderBlock[] = PROVIDER_BLOCKS): Promise<LoadResult> {
  const loaded: LoadedPlugin[] = [];
  const unbuilt: { plugin: CatalogPlugin; module: PluginModule }[] = [];
  const refusals: { plugin: string; concern: Concern; why: string }[] = [];
  for (const block of blocks) {
    const report = providers.blocks[block];
    const plugin = report.enabled ? pluginNamed(catalog, report.provider) : undefined;
    if (plugin === undefined || plugin.where !== "bundled") continue;
    let module: PluginModule | null = null;
    try {
      module = await importPlugin(plugin, importModule);
      loaded.push({ plugin, implementation: module.create(settingsOfBlock(report), depsFor(plugin.concern, deps)), module });
    } catch (error) {
      refusals.push({ plugin: plugin.name, concern: plugin.concern, why: error instanceof Error ? error.message : String(error) });
      if (module !== null) unbuilt.push({ plugin, module });
    }
  }
  return { loaded, unbuilt, refusals };
}

/**
 * The concern's DEFAULT plugin, loaded for a block that is switched off (the exposure of a host whose block says `enabled: false` serves on loopback only, which is `local`): the
 * default is imported and given the settings the block holds that it declares. It does not look at `enabled`, since the caller asks because the block is off. A default that cannot be
 * loaded is the refusal, by name.
 */
export async function loadDefault(block: ProviderBlock, providers: Providers, catalog: Catalog, deps: PluginDeps, importModule: ImportModule = (url) => import(url)): Promise<Readonly<{
  loaded?: LoadedPlugin; refusal?: Readonly<{ plugin: string; concern: Concern; why: string }>;
}>> {
  const name = DEFAULT_PROVIDER[block];
  const plugin = pluginNamed(catalog, name);
  if (plugin === undefined || plugin.where !== "bundled") return { refusal: { plugin: name, concern: plugin?.concern ?? "exposure", why: `the default ${block} plugin ${name} is not a bundled plugin of this checkout` } };
  try {
    const module = await importPlugin(plugin, importModule);
    const declared = new Set(blockSettings(plugin));
    const own = Object.fromEntries(Object.entries(settingsOfBlock(providers.blocks[block])).filter(([setting]) => declared.has(setting)));
    return { loaded: { plugin, implementation: module.create(own, depsFor(plugin.concern, deps)), module } };
  } catch (error) {
    return { refusal: { plugin: name, concern: plugin.concern, why: error instanceof Error ? error.message : String(error) } };
  }
}
