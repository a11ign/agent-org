// @ts-check
// module: the sentences of the rules that decide whether a plugin may be enabled, one place for the reader, the CLI and doctor (A11-158)
//
// PURE. The host-file reader (`providers.ts`) refuses with these, `agent-org plugin` prints them, and `list` shows them beside the plugin they apply to, so one rule is
// said in one way. Each answers null when the rule is satisfied.
import { CONCERN_LABEL, type Concern, REQUIRED_CONCERNS } from "./concerns.ts";
import type { Catalog, CatalogPlugin } from "./manifest.ts";
import { readsConcernContract, unreadMajorRefusal } from "./version.ts";

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/** The sentence that says `plugin` is the only one of its concern that may be enabled, so it may not be disabled or uninstalled: null for a concern that may have none. */
export function onlyOneSentence(concern: Concern, plugin: string): string | null {
  if (!REQUIRED_CONCERNS.includes(concern)) return null;
  const label = CONCERN_LABEL[concern];
  return `${plugin} is the only ${label}, and exactly one ${label} must be enabled`;
}

/** Why a plugin of the catalog may not be enabled on this host: its contract major is not one this agent-org reads, or core still runs another plugin for the concern. */
export function enableRefusal(plugin: CatalogPlugin, catalog: Catalog): string | null {
  if (!readsConcernContract(plugin.concern, plugin.contract)) return unreadMajorRefusal(plugin.name, plugin.concern, plugin.contract);
  const pin = catalog.pins[plugin.concern];
  if (pin === undefined || pin.runs.includes(plugin.name)) return null;
  const label = CONCERN_LABEL[plugin.concern];
  return `${plugin.name} is ${/^[aeiou]/.test(label) ? "an" : "a"} ${label} plugin, but this release runs the ${label} in core as ${pin.runs.join(" or ")} until ${pin.until}: name ${quoted(pin.runs)}`;
}
