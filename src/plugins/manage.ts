// @ts-check
// module: what `agent-org plugin install|enable|disable|uninstall|config` changes in the host file, decided and not yet written (A11-158)
//
// PURE. Each `plan*` function takes the parsed host file, what the reader made of it and the catalog, and answers the keys to change (for `settings-edit.ts` to write) or throws
// a `PluginCommandRefusal` naming what is refused. It writes nothing and reads nothing. The reader has the last word: a plan that the reader refuses is never written, so a rule
// stated here (the tracker may not be disabled) is only the kinder way to say a rule the reader keeps anyway.
//
// WHAT IS REFUSED BEFORE ANY KEY IS CHOSEN. Messaging: it is configured in `project.json`, and its writes wait for A11-162. A concern still read from an old key (an alias): the
// block would be written beside a value the reader would choose silently, so `agent-org doctor --fix` moves the old keys first.
import type { Change } from "../ticket-mode/settings-edit.ts";
import { DEFAULT_PROVIDER, isActive, type BlockReport, type Providers } from "../ticket-mode/providers.ts";
import { blockOf, CONCERN_LABEL, CONCERN_OF_BLOCK, type ProviderBlock } from "./concerns.ts";
import type { Catalog, CatalogPlugin } from "./manifest.ts";
import { blockSettings, pluginNamed } from "./registry.ts";
import { enableRefusal, fakeRefusal, onlyOneSentence } from "./rules.ts";

/** A command the plugin CLI refuses, with the sentence that says why and what to do. */
export class PluginCommandRefusal extends Error {}

/** What the command would do: the keys to write, and the sentence that says what it did. No changes is a command that found nothing to do, and says so. */
export type Plan = Readonly<{ changes: readonly Change[]; said: string }>;

export type PlanContext = Readonly<{ providers: Providers; catalog: Catalog }>;

type Target = Readonly<{ plugin: CatalogPlugin; block: ProviderBlock; report: BlockReport }>;

const refuse = (message: string): never => {
  throw new PluginCommandRefusal(message);
};

const keyOf = (block: ProviderBlock, setting?: string): string => (setting === undefined ? `tickets.providers.${block}` : `tickets.providers.${block}.${setting}`);

/** The plugin named, the block it is configured in and that block as the reader found it; refused by name for a plugin the registry does not hold, and for messaging. */
function targetOf(name: string, { providers, catalog }: PlanContext): Target {
  const plugin = pluginNamed(catalog, name);
  if (plugin === undefined) {
    const refused = catalog.refusals.find((refusal) => refusal.plugin === name);
    return refuse(refused === undefined ? `no plugin is named ${name}: \`agent-org plugin list\` shows the plugins` : `plugin ${name} was refused by the registry: ${refused.why}`);
  }
  const block = blockOf(plugin.concern);
  if (block === null) {
    return refuse(`${name} is a ${CONCERN_LABEL[plugin.concern]} plugin, which project.json's messaging key configures: agent-org plugin does not write it until A11-162 moves messaging onto the registry`);
  }
  return { plugin, block, report: providers.blocks[block] };
}

/** Refuses a fake, which the reader accepts (core's tests enable one) and which has no code to run on a host: unless the reader refuses it first, with its own, kinder, sentence. */
function refuseFake(plugin: CatalogPlugin, catalog: Catalog): void {
  const fake = enableRefusal(plugin, catalog) === null ? fakeRefusal(plugin) : null;
  if (fake !== null) refuse(fake);
}

/** Refuses while any old key still stands for a setting of the block: the block would be written beside it, and the reader refuses a block and an alias that disagree. */
function refuseWhileAliased(block: ProviderBlock, providers: Providers): void {
  const place = keyOf(block);
  if (providers.aliases.some(({ new: at }) => at === place || at.startsWith(`${place}.`))) {
    refuse(`${CONCERN_LABEL[CONCERN_OF_BLOCK[block]]} settings are still read from old keys: run \`agent-org doctor --fix\` to move them to ${place}, then try again`);
  }
}

/** Whether a block of the host file names this plugin, whether or not it is enabled: the plugin is installed. */
const isInstalled = ({ plugin, report }: Target): boolean => report.from === "block" && report.provider === plugin.name;

function refuseUnlessInstalled(target: Target): void {
  if (!isInstalled(target)) refuse(`${target.plugin.name} is not installed: run \`agent-org plugin install ${target.plugin.name}\``);
}

/** A `key=value` setting, the value read as JSON where it is JSON (a number, a list, an object) and as text otherwise. */
export function settingOf(item: string): readonly [string, unknown] {
  const at = item.indexOf("=");
  if (at <= 0) return refuse(`${JSON.stringify(item)} is not key=value`);
  const raw = item.slice(at + 1);
  try {
    return [item.slice(0, at), JSON.parse(raw)];
  } catch {
    return [item.slice(0, at), raw];
  }
}

function settingChanges(block: ProviderBlock, sets: readonly string[]): Change[] {
  return sets.map(settingOf).map(([name, value]) => {
    if (name === "provider" || name === "enabled") return refuse(`${name} is not a setting to set here: \`agent-org plugin install\` names the plugin and \`enable\` and \`disable\` switch it`);
    return { key: keyOf(block, name), value };
  });
}

/**
 * Writes the plugin's block: its name, `enabled: true`, and the settings given. A block that names another plugin is refused unless `replace`, which names the plugin it replaces
 * and drops its settings (they are that plugin's, and the reader would refuse them beside another's).
 */
export function planInstall(name: string, options: Readonly<{ sets: readonly string[]; replace: boolean }>, context: PlanContext): Plan {
  const target = targetOf(name, context);
  const { plugin, block, report } = target;
  refuseFake(plugin, context.catalog);
  refuseWhileAliased(block, context.providers);
  const replaced = report.provider !== "none" && report.provider !== plugin.name ? report.provider : null;
  if (replaced !== null && !options.replace) {
    refuse(`the ${CONCERN_LABEL[plugin.concern]} is ${replaced} (${report.from === "block" ? keyOf(block) : "its default"}) and exactly one ${CONCERN_LABEL[plugin.concern]} plugin is installed: use --replace to replace ${replaced} with ${name}, which drops ${replaced}'s settings`);
  }
  const dropped: Change[] = replaced !== null && report.from === "block" ? [{ key: keyOf(block), remove: true }] : [];
  const changes: Change[] = [...dropped, { key: keyOf(block, "provider"), value: plugin.name }, { key: keyOf(block, "enabled"), value: true }, ...settingChanges(block, options.sets)];
  return { changes, said: replaced === null ? `installed ${name} as the ${CONCERN_LABEL[plugin.concern]}` : `installed ${name} as the ${CONCERN_LABEL[plugin.concern]}, replacing ${replaced}` };
}

/** Switches an installed plugin on. One that is on is left as it is. */
export function planEnable(name: string, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseFake(target.plugin, context.catalog);
  refuseWhileAliased(target.block, context.providers);
  refuseUnlessInstalled(target);
  if (target.report.enabled) return { changes: [], said: `${name} is already enabled` };
  return { changes: [{ key: keyOf(target.block, "enabled"), value: true }], said: `enabled ${name}: it is the ${CONCERN_LABEL[target.plugin.concern]} again, with the settings it kept` };
}

/** What a concern does with no plugin: the board publishes nothing, starts no reviewer, or serves on loopback only. */
const WITHOUT: Readonly<Record<string, string>> = {
  publish: "the board publishes nothing", reviewer: "the board starts no reviewer", exposure: "the board is served on loopback only",
};

/** Switches an installed plugin off, keeping its settings. The only tracker and the only code host may not be: that is refused by name, installed or not. */
export function planDisable(name: string, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseWhileAliased(target.block, context.providers);
  const only = onlyOneSentence(target.plugin.concern, name);
  if (only !== null) refuse(`${only}: it cannot be disabled`);
  refuseUnlessInstalled(target);
  if (!target.report.enabled) return { changes: [], said: `${name} is already disabled` };
  return { changes: [{ key: keyOf(target.block, "enabled"), value: false }], said: `disabled ${name}: ${WITHOUT[target.block]}, and its settings are kept for \`enable\`` };
}

/** Removes the plugin's block, so its concern takes its default. The only tracker and the only code host may not be: their default would put the same plugin back. */
export function planUninstall(name: string, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseWhileAliased(target.block, context.providers);
  const only = onlyOneSentence(target.plugin.concern, name);
  if (only !== null) refuse(`${only}: it cannot be uninstalled, since its default would put ${name} back`);
  refuseUnlessInstalled(target);
  const fallback = DEFAULT_PROVIDER[target.block];
  return { changes: [{ key: keyOf(target.block), remove: true }], said: `uninstalled ${name}: the ${CONCERN_LABEL[target.plugin.concern]} falls back to its default, ${fallback}` };
}

/** The settings a plugin's block holds, one `key: value` line each, for the keys named (all it declares when none): a value as JSON, and never the contents of a key file. */
export function configLines(name: string, keys: readonly string[], context: PlanContext): readonly string[] {
  const target = targetOf(name, context);
  refuseUnlessInstalled(target);
  const declared = blockSettings(target.plugin);
  const unknown = keys.find((key) => !declared.includes(key));
  if (unknown !== undefined) refuse(`${unknown} is not a setting of ${name}: its settings are ${declared.join(", ") || "none"}`);
  return (keys.length === 0 ? declared : keys).map((key) => {
    const { value } = target.report.settings[key] ?? { value: undefined };
    return `${keyOf(target.block, key)}: ${value === undefined ? "not set" : JSON.stringify(value)}`;
  });
}

/** Sets and removes settings of an installed plugin's block. The reader refuses a setting the plugin does not declare, and a value it does not accept, by name. */
export function planConfig(name: string, options: Readonly<{ sets: readonly string[]; unsets: readonly string[] }>, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseWhileAliased(target.block, context.providers);
  refuseUnlessInstalled(target);
  const removals: Change[] = options.unsets.map((setting) => ({ key: keyOf(target.block, setting), remove: true }));
  const changes = [...settingChanges(target.block, options.sets), ...removals];
  if (changes.length === 0) return refuse("name a setting to set (key=value) or to remove (--unset key)");
  return { changes, said: `changed ${name}'s settings${isActive(target.report) ? "" : " (it is disabled, so they apply when it is enabled)"}` };
}
