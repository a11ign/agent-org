// @ts-check
// module: the code host, loaded synchronously for code that cannot await it (A11-160, step 4)
//
// ROW MODE REACHES GITHUB FROM ABOUT 150 PROGRAMS, most of them synchronous from their first line and none of them holding a deps chain to carry a code host through. The loader is async
// (`import()`), so a program that awaited `activatePlugins` first would need every entry point changed. This loads the code host the host file names the other way: by `require`, which Node 24 allows
// on an ES module graph that has no top-level `await` (the GitHub plugin's has none, and `plugins/github/index.test.ts` holds it to that). It is the loader's own check and `create`, for the
// code host block alone, and it takes the host file's text from its caller (null when it does not read, which names the defaults, as `activate-host.ts` does; the program's own read of the file says why):
// it imports neither the host file's reader nor the project's declaration, which refuse a host with no project, and a host with none loads this file through `active.ts`.
//
// A PROGRAM THAT AWAITED `activatePlugins` IS NOT LOADED A SECOND TIME: `activeCodeHost()` answers the activated one first (`active.ts`).
import { createRequire } from "node:module";
import { join } from "node:path";
import { providersOfText } from "../ticket-mode/providers.ts";
import type { CodeHost } from "./contracts/code-host.ts";
import { isPluginModule, refusalOf, settingsOfBlock } from "./loader.ts";
import type { Catalog, CatalogPlugin, PluginDeps } from "./manifest.ts";
import { defaultCatalog, pluginNamed } from "./registry.ts";

/** A code host that cannot be loaded here: the reason, naming the plugin. */
export class CodeHostLoadRefusal extends Error {}

/** Whether a plugin has code to run on a host: it is a bundled package with an entry module, and not a fake or a built-in. */
const runsOnAHost = (plugin: CatalogPlugin): plugin is CatalogPlugin & Readonly<{ dir: string; entry: string }> => plugin.where === "bundled" && plugin.dir !== null && plugin.entry !== null;

/**
 * The enabled code host plugin, loaded and built. `depsFor` makes the plugin's deps (core's, so this file imports none of the activation). REFUSES, naming the plugin, a code host that is a fake or
 * a built-in (no code to run on a host), a contract major this agent-org does not read, an entry that is not a plugin's, and a `create` that throws.
 */
export function loadCodeHostSync(hostFileText: string | null, env: NodeJS.ProcessEnv, depsFor: (env: NodeJS.ProcessEnv) => PluginDeps, catalog: Catalog = defaultCatalog()): CodeHost {
  const providers = providersOfText(hostFileText, catalog);
  const report = providers.blocks.codeHost;
  const plugin = pluginNamed(catalog, report.provider);
  if (plugin === undefined || !runsOnAHost(plugin)) {
    const noneBundled = catalog.plugins.every((candidate) => candidate.where !== "bundled");
    throw new CodeHostLoadRefusal(noneBundled
      ? `the code host is ${report.provider}, but this tool's checkout holds no bundled plugin: its plugins/ folder is missing, so no code host can be loaded (reinstall the tool)`
      : `the code host is ${report.provider}, which has no code to run on a host: name a bundled code host plugin in tickets.providers.codeHost (\`agent-org plugin list\`)`);
  }
  const refusal = refusalOf(plugin);
  if (refusal !== null) throw new CodeHostLoadRefusal(`the code host plugin ${plugin.name} was refused: ${refusal}`);
  try {
    const module: unknown = createRequire(import.meta.url)(join(plugin.dir, plugin.entry));
    if (!isPluginModule(module)) throw new Error(`plugin ${plugin.name}: ${plugin.entry} must export create, doctorChecks and onboardSteps`);
    return module.create(settingsOfBlock(report), depsFor(env)) as CodeHost;
  } catch (error) {
    throw new CodeHostLoadRefusal(`the code host plugin ${plugin.name} was refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}
