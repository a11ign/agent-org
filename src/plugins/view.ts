// @ts-check
// module: what `agent-org plugin list` and doctor say about the plugins: each concern, the plugin enabled for it, every plugin known for it and its state (A11-158)
//
// PURE. The caller passes the resolved blocks, the catalog and what the project says of messaging; nothing is read here. No secret is ever in a view: a setting is shown
// as the key it was read from, and a key's file only by its path.
import { basename } from "node:path";
import { isActive, type BlockReport, type Providers } from "../ticket-mode/providers.ts";
import { blockOf, CONCERN_LABEL, CONCERNS, type Concern } from "./concerns.ts";
import type { Catalog, CatalogPlugin } from "./manifest.ts";
import { pluginsOfConcern } from "./registry.ts";
import { enableRefusal, fakeRefusal } from "./rules.ts";

/** A plugin's state for its concern: in force, named by a block but switched off, or not named by any block. */
export type PluginState = "enabled" | "disabled" | "available";

export type PluginView = Readonly<{ name: string; state: PluginState; contract: string; where: string; description: string; refusal: string | null }>;
export type ConcernView = Readonly<{ concern: Concern; label: string; enabled: string | null; source: string; plugins: readonly PluginView[]; note: string | null }>;

/** What the project's `messaging` key says, which is read from `project.json` and not from a provider block: the plugin it names, whether it is enabled, and its settings. */
export type MessagingState = Readonly<{ provider: string; enabled: boolean; settings: Readonly<Record<string, unknown>> } | { provider: null; why: string }>;

/** The default each block takes with no block and no alias, in the words doctor says it with. */
export const DEFAULT_TEXT: Readonly<Record<string, string>> = {
  tracker: "linear, with the Keychain service agent-org-linear",
  codeHost: "github, with every role on a user account",
  publish: "none, which publishes nothing",
  reviewer: "none, which starts no reviewer",
  exposure: "local, on loopback with ports 4747 and 4748",
};

/** What a block's settings came from, in the words a row gives: its block, the old keys it still reads, or the default it takes with no block. */
export function sourceWords(providers: Providers, block: keyof Providers["blocks"]): string {
  const report = providers.blocks[block];
  if (report.from === "block") return `from tickets.providers.${block}`;
  if (report.from === "default") return `no block: the default, ${DEFAULT_TEXT[block]}, applies`;
  const aliases = providers.aliases.filter(({ new: place }) => place === `tickets.providers.${block}` || place.startsWith(`tickets.providers.${block}.`));
  return `from aliases (${aliases.map(({ old }) => old).join(", ")})`;
}

/** Where a plugin's code lives, in the words `list` gives: its folder under `plugins/`, which is not always its name (`plugins/atomic-reviewer` is `atomic`). */
export const whereOf = (plugin: CatalogPlugin): string => (plugin.dir === null ? "fake" : `plugins/${basename(plugin.dir)}`);

function stateOf(plugin: CatalogPlugin, report: BlockReport): PluginState {
  if (report.provider !== plugin.name) return "available";
  return report.enabled ? "enabled" : "disabled";
}

function viewOfPlugin(plugin: CatalogPlugin, report: BlockReport, catalog: Catalog): PluginView {
  return { name: plugin.name, state: stateOf(plugin, report), contract: plugin.contract, where: whereOf(plugin), description: plugin.description, refusal: enableRefusal(plugin) ?? fakeRefusal(plugin) };
}

function viewOfBlock(concern: Concern, providers: Providers, catalog: Catalog): ConcernView {
  const block = blockOf(concern)!;
  const report = providers.blocks[block];
  return { concern, label: CONCERN_LABEL[concern], enabled: isActive(report) ? report.provider : null, source: sourceWords(providers, block),
    plugins: pluginsOfConcern(catalog, concern).map((plugin) => viewOfPlugin(plugin, report, catalog)), note: null };
}

function viewOfMessaging(catalog: Catalog, messaging: MessagingState): ConcernView {
  const named = messaging.provider;
  const enabled = named !== null && "enabled" in messaging && messaging.enabled;
  const source = named === null ? messaging.why : "configured in project.json's messaging key";
  const plugins = pluginsOfConcern(catalog, "messaging").map((plugin): PluginView => ({
    name: plugin.name, state: plugin.name !== named ? "available" : enabled ? "enabled" : "disabled", contract: plugin.contract, where: whereOf(plugin), description: plugin.description,
    refusal: enableRefusal(plugin) ?? fakeRefusal(plugin),
  }));
  return { concern: "messaging", label: CONCERN_LABEL.messaging, enabled: enabled ? named : null, source, plugins, note: null };
}

/** One view per concern, in the order tracker, code host, publisher, reviewer, exposure, messaging. */
export function viewConcerns(providers: Providers, catalog: Catalog, messaging: MessagingState): readonly ConcernView[] {
  return CONCERNS.map((concern) => (concern === "messaging" ? viewOfMessaging(catalog, messaging) : viewOfBlock(concern, providers, catalog)));
}

const pad = (text: string, width: number): string => text.padEnd(width);

/** The text of `agent-org plugin list`: a section per concern, then every plugin the registry refused. */
export function formatList(views: readonly ConcernView[], catalog: Catalog): string {
  const lines: string[] = [];
  for (const view of views) {
    lines.push(`${view.label}: ${view.enabled ?? "none"} (${view.source})`);
    const width = Math.max(...view.plugins.map(({ name }) => name.length), 0);
    for (const plugin of view.plugins) {
      const refusal = plugin.refusal === null ? "" : `  refused: ${plugin.refusal}`;
      lines.push(`  ${pad(plugin.name, width)}  ${pad(plugin.state, 9)}  contract ${plugin.contract}  ${plugin.where}${refusal}`);
    }
  }
  if (catalog.refusals.length > 0) {
    lines.push("refused by the registry:");
    for (const { why } of catalog.refusals) lines.push(`  ${why}`);
  }
  return lines.join("\n");
}
