// @ts-check
// module: the schema the Settings page and the readers use -- `config-schema.ts`'s entries plus what each catalog plugin declares (A11-159)
//
// A BUNDLED PLUGIN BRINGS ITS OWN SETTINGS. `config-schema.ts` is data that imports nothing, and holds the keys core reads. The settings a bundled plugin declares in its manifest
// (`agentOrg.settings`, each a `SchemaEntry`) are not in it: this function returns its entries with each plugin's settings added, so the Settings page draws a plugin's rows where
// it drew them when they were core's. A plugin's entries follow its block's `enabled` entry (`tickets.providers.<block>.enabled`), in the order the manifest declares them, and a
// key the schema already holds is not added again: the built-ins' entries are still core's. EVERY READER OF THE SCHEMA USES THIS FUNCTION.
import { SCHEMA, type SchemaEntry } from "../ticket-mode/config-schema.ts";
import { blockOf } from "./concerns.ts";
import type { Catalog } from "./manifest.ts";
import { defaultCatalog } from "./registry.ts";

/** An entry's identity: a key is described once per file (`schema` is a key of both the host file and a project's). */
const entryId = ({ file, key }: SchemaEntry): string => `${file} ${key}`;

/** The schema entries of a catalog: the core entries, then each plugin's settings after the `enabled` entry of the block the plugin's concern is configured in. */
export function schemaOf(catalog: Catalog): readonly SchemaEntry[] {
  const held = new Set(SCHEMA.map(entryId));
  const added = new Map<string, SchemaEntry[]>();
  for (const plugin of catalog.plugins) {
    const block = blockOf(plugin.concern);
    if (block === null) continue;
    const entries = Object.values(plugin.settings).filter((entry) => !held.has(entryId(entry)));
    for (const entry of entries) held.add(entryId(entry));
    const after = `tickets.providers.${block}.enabled`;
    added.set(after, [...(added.get(after) ?? []), ...entries]);
  }
  return SCHEMA.flatMap((entry) => [entry, ...(added.get(entry.key) ?? [])]);
}

let memo: readonly SchemaEntry[] | null = null;

/** The schema of this checkout's catalog, built once per process. */
export function defaultSchema(): readonly SchemaEntry[] {
  memo ??= schemaOf(defaultCatalog());
  return memo;
}
