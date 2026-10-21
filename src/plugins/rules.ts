// @ts-check
// module: the sentences of the rules that decide whether a plugin may be enabled, one place for the reader, the CLI and doctor (A11-158)
//
// PURE. The host-file reader (`providers.ts`) refuses with these, `agent-org plugin` prints them, and `list` shows them beside the plugin they apply to, so one rule is
// said in one way. Each answers null when the rule is satisfied.
import { CONCERN_LABEL, type Concern, REQUIRED_CONCERNS } from "./concerns.ts";
import type { CatalogPlugin } from "./manifest.ts";
import { readsConcernContract, unreadMajorRefusal } from "./version.ts";

/** Names as a refusal lists them: each in double quotes, separated by commas. */
export const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/** The sentence that says `plugin` is the only one of its concern that may be enabled, so it may not be disabled or uninstalled: null for a concern that may have none. */
export function onlyOneSentence(concern: Concern, plugin: string): string | null {
  if (!REQUIRED_CONCERNS.includes(concern)) return null;
  const label = CONCERN_LABEL[concern];
  return `${plugin} is the only ${label}, and exactly one ${label} must be enabled`;
}

/** Why a plugin of the catalog may not be enabled on this host: its contract major is not one this agent-org reads. */
export function enableRefusal(plugin: CatalogPlugin): string | null {
  return readsConcernContract(plugin.concern, plugin.contract) ? null : unreadMajorRefusal(plugin.name, plugin.concern, plugin.contract);
}

/** Why a fake may not be installed or enabled on a host: it is an in-memory implementation for core's tests, and has no code to run. Null for any other plugin. */
export function fakeRefusal(plugin: CatalogPlugin): string | null {
  return plugin.where === "fake" ? `${plugin.name} is an in-memory ${CONCERN_LABEL[plugin.concern]} for core's tests: it runs no host, so it cannot be installed or enabled` : null;
}
