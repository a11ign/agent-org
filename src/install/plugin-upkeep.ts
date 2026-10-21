// module: what the enabled agent-org plugins keep true on this machine, for `agent-org update` to run once it is done (A11-160)
//
// A plugin's entry module may export `keep` (`plugins/manifest.ts`): the code host keeps its stacking extension present. Update asks each enabled bundled plugin that does.
import { realPluginDeps } from "../plugins/active.ts";
import { blockOf } from "../plugins/concerns.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { type ImportModule, importEnabled, settingsOfBlock } from "../plugins/loader.ts";
import type { PluginDeps, StepResult } from "../plugins/manifest.ts";
import type { TicketSettings } from "../ticket-mode/settings.ts";

/**
 * What the enabled plugins keep true, as a function to run once the update is done. Their entry modules are imported NOW, before the checkout moves, so the code that runs is the code that
 * was loaded with the core that is running it; nothing is built, so nothing is read of the machine for a plugin that keeps nothing (a tracker's key stays unread). A host file that cannot
 * be read keeps nothing, and a plugin that cannot be imported is said, as an error, when the function runs. A plugin's `keep` that throws is said, never raised.
 */
export async function pluginUpkeep(settings: TicketSettings | null, env: NodeJS.ProcessEnv = process.env, seams: Readonly<{ deps?: PluginDeps; importModule?: ImportModule }> = {}): Promise<() => readonly StepResult[]> {
  if (settings === null) return () => [];
  const deps = seams.deps ?? realPluginDeps({ env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones });
  const { modules, refusals } = await importEnabled(settings.providers, defaultCatalog(), seams.importModule);
  return () => [
    ...refusals.map(({ plugin, concern, why }): StepResult => ({ ok: false, detail: `the ${concern} plugin ${plugin} was refused: ${why}` })),
    ...modules.flatMap(({ plugin, module }): readonly StepResult[] => {
      const block = blockOf(plugin.concern);
      if (block === null || module.keep === undefined) return [];
      try {
        return module.keep(settingsOfBlock(settings.providers.blocks[block]), deps);
      } catch (error) {
        return [{ ok: false, detail: `the ${plugin.name} plugin could not be kept up: ${error instanceof Error ? error.message : String(error)}` }];
      }
    }),
  ];
}
