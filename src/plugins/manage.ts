// @ts-check
// module: what `agent-org plugin install|enable|disable|uninstall|config` changes in the host file or the project's declaration, decided and not yet written (A11-158, A11-162)
//
// PURE. Each `plan*` function takes the parsed host file, what the reader made of it and the catalog, and answers the keys to change (for `settings-edit.ts` to write) or throws
// a `PluginCommandRefusal` naming what is refused. It writes nothing and reads nothing. The reader has the last word: a plan that the reader refuses is never written, so a rule
// stated here (the tracker may not be disabled) is only the kinder way to say a rule the reader keeps anyway.
//
// WHERE A CONCERN IS CONFIGURED. Five concerns are a block under `tickets.providers` of the host file. Messaging is the `messaging` key of the primary project's `project.json` (A11-162):
// the same words (`provider`, `enabled` and the plugin's settings), another file, and it is written through the same path the Settings page uses for that file.
//
// WHAT IS REFUSED BEFORE ANY KEY IS CHOSEN. A concern still read from an old key (an alias): the block would be written beside a value the reader would choose silently, so
// `agent-org doctor --fix` moves the old keys first.
//
// A SWITCH IS `enable` OF A PLUGIN THE BLOCK DOES NOT NAME (A11-162): when the concern's block names another plugin of the same concern, `enable <name>` switches the block to it,
// keeping the settings both declare. The plugin it leaves, if it was enabled, is released first (`leaves`): `PluginModule.release` runs while it is still the enabled one, before the file
// is written, and a release that cannot refuses the change.
import type { Change, EditFile } from "../ticket-mode/settings-edit.ts";
import { DEFAULT_PROVIDER, isActive, type BlockReport, type Providers } from "../ticket-mode/providers.ts";
import { blockOf, CONCERN_LABEL, type Concern, type ProviderBlock } from "./concerns.ts";
import type { Catalog, CatalogPlugin, PluginSettings } from "./manifest.ts";
import { blockSettings, pluginNamed } from "./registry.ts";
import { enableRefusal, fakeRefusal, onlyOneSentence } from "./rules.ts";
import type { MessagingState } from "./view.ts";

/** A command the plugin CLI refuses, with the sentence that says why and what to do. */
export class PluginCommandRefusal extends Error {}

/**
 * What the command would do: the keys to write (in `file`, the host file unless it says `project.json`), and the sentence that says what it did. No changes is a command that found
 * nothing to do, and says so. `leaves` is the plugin the change switches off while it is still the enabled one, with the settings it has: the CLI releases it first. `ownTerminal` is
 * the `terminal` setting a switch drops when its address names the machine of the plugin it leaves.
 */
export type Plan = Readonly<{
  changes: readonly Change[];
  said: string;
  file?: EditFile;
  leaves?: Readonly<{ plugin: CatalogPlugin; settings: PluginSettings }>;
  ownTerminal?: Readonly<{ key: string; address: string }>;
}>;

export type PlanContext = Readonly<{ providers: Providers; catalog: Catalog; messaging: MessagingState }>;

/** Where a concern's settings are: the file, the key of the block (`tickets.providers.<block>` or `messaging`), and what the key holds. */
type Place = Readonly<{ file: EditFile; block: string }>;

type Target = Readonly<{ plugin: CatalogPlugin; place: Place; report: BlockReport }>;

const refuse = (message: string): never => {
  throw new PluginCommandRefusal(message);
};

const MESSAGING: Place = { file: "project.json", block: "messaging" };
const placeOf = (block: ProviderBlock): Place => ({ file: "host.json", block: `tickets.providers.${block}` });

const keyOf = (place: Place, setting?: string): string => (setting === undefined ? place.block : `${place.block}.${setting}`);

/** What the project's `messaging` key holds, shaped as a block the other concerns have: the plugin it names, whether it is enabled, and its settings. */
export function messagingReport(state: MessagingState): BlockReport {
  if (state.provider === null) return { provider: "none", enabled: false, from: "default", settings: {} };
  const settings = Object.fromEntries(Object.entries(state.settings).map(([name, value]) => [name, { value, at: `messaging.${name}` }]));
  return { provider: state.provider, enabled: state.enabled, from: "block", settings };
}

/** The plugin named, the place it is configured in and that place as the reader found it; refused by name for a plugin the registry does not hold. */
function targetOf(name: string, { providers, catalog, messaging }: PlanContext): Target {
  const plugin = pluginNamed(catalog, name);
  if (plugin === undefined) {
    const refused = catalog.refusals.find((refusal) => refusal.plugin === name);
    return refuse(refused === undefined ? `no plugin is named ${name}: \`agent-org plugin list\` shows the plugins` : `plugin ${name} was refused by the registry: ${refused.why}`);
  }
  const block = blockOf(plugin.concern);
  if (block === null) return { plugin, place: MESSAGING, report: messagingReport(messaging) };
  return { plugin, place: placeOf(block), report: providers.blocks[block] };
}

/** Refuses a fake, which the reader accepts (core's tests enable one) and which has no code to run on a host: unless the reader refuses it first, with its own, kinder, sentence. */
function refuseFake(plugin: CatalogPlugin, catalog: Catalog): void {
  const fake = enableRefusal(plugin, catalog) === null ? fakeRefusal(plugin) : null;
  if (fake !== null) refuse(fake);
}

/** Refuses while any old key still stands for a setting of the block: the block would be written beside it, and the reader refuses a block and an alias that disagree. */
function refuseWhileAliased({ plugin, place }: Target, providers: Providers): void {
  if (place.file !== "host.json") return;
  if (providers.aliases.some(({ new: at }) => at === place.block || at.startsWith(`${place.block}.`))) {
    refuse(`${CONCERN_LABEL[plugin.concern]} settings are still read from old keys: run \`agent-org doctor --fix\` to move them to ${place.block}, then try again`);
  }
}

/** Whether the place names this plugin, whether or not it is enabled: the plugin is installed. */
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

function settingChanges(place: Place, sets: readonly string[]): Change[] {
  return sets.map(settingOf).map(([name, value]) => {
    if (name === "provider" || name === "enabled") return refuse(`${name} is not a setting to set here: \`agent-org plugin install\` names the plugin and \`enable\` and \`disable\` switch it`);
    return { key: keyOf(place, name), value };
  });
}

/** The settings the place holds, by name: what the file holds, and not what a setting defaults to. */
const heldSettings = (report: BlockReport): [string, unknown][] => Object.entries(report.settings).filter(([, setting]) => setting.value !== undefined).map(([name, setting]) => [name, setting.value]);

/** The plugin the place leaves when it stops naming it, with the settings it has, or nothing when it was not the enabled one. */
function leavingOf(target: Target, catalog: Catalog): Plan["leaves"] {
  const { report } = target;
  const outgoing = report.provider === "none" ? undefined : pluginNamed(catalog, report.provider);
  if (!report.enabled || outgoing === undefined || outgoing.where !== "bundled") return undefined;
  return { plugin: outgoing, settings: Object.fromEntries(heldSettings(report).filter(([name]) => blockSettings(outgoing).includes(name))) };
}

/**
 * Writes the plugin's block: its name, `enabled: true`, and the settings given. A block that names another plugin is refused unless `replace`, which names the plugin it replaces
 * and drops its settings (they are that plugin's, and the reader would refuse them beside another's).
 */
export function planInstall(name: string, options: Readonly<{ sets: readonly string[]; replace: boolean }>, context: PlanContext): Plan {
  const target = targetOf(name, context);
  const { plugin, place, report } = target;
  refuseFake(plugin, context.catalog);
  refuseWhileAliased(target, context.providers);
  const replaced = report.provider !== "none" && report.provider !== plugin.name ? report.provider : null;
  if (replaced !== null && !options.replace) {
    refuse(`the ${CONCERN_LABEL[plugin.concern]} is ${replaced} (${report.from === "block" ? keyOf(place) : "its default"}) and exactly one ${CONCERN_LABEL[plugin.concern]} plugin is installed: use --replace to replace ${replaced} with ${name}, which drops ${replaced}'s settings`);
  }
  const dropped: Change[] = replaced !== null && report.from === "block" ? [{ key: keyOf(place), remove: true }] : [];
  const changes: Change[] = [...dropped, { key: keyOf(place, "provider"), value: plugin.name }, { key: keyOf(place, "enabled"), value: true }, ...settingChanges(place, options.sets)];
  const said = replaced === null ? `installed ${name} as the ${CONCERN_LABEL[plugin.concern]}` : `installed ${name} as the ${CONCERN_LABEL[plugin.concern]}, replacing ${replaced}`;
  return { changes, said, file: place.file, ...(replaced === null ? {} : { leaves: leavingOf(target, context.catalog) }) };
}

/**
 * Switches the place from the plugin it names to `plugin` of the same concern (A11-162): the block is written again with the new plugin enabled, keeping each setting both declare and
 * dropping the rest, which are the outgoing plugin's. A `terminal` that names the outgoing plugin's own machine is dropped too, once the CLI has asked the plugin for its name.
 */
function planSwitch(target: Target, context: PlanContext): Plan {
  const { plugin, place, report } = target;
  const declared = blockSettings(plugin);
  const held = heldSettings(report);
  const kept = held.filter(([name]) => declared.includes(name));
  const dropped = held.filter(([name]) => !declared.includes(name)).map(([name]) => name);
  const changes: Change[] = [{ key: keyOf(place), remove: true }, { key: keyOf(place, "provider"), value: plugin.name }, { key: keyOf(place, "enabled"), value: true },
    ...kept.map(([name, value]): Change => ({ key: keyOf(place, name), value }))];
  const said = `switched the ${CONCERN_LABEL[plugin.concern]} from ${report.provider} to ${plugin.name}, keeping ${kept.length === 0 ? "no settings" : kept.map(([name]) => name).join(", ")}`
    + `${dropped.length === 0 ? "" : ` and dropping ${dropped.join(", ")}, which ${plugin.name} does not declare`}`;
  const terminal = report.settings.terminal?.value;
  return { changes, said, file: place.file, leaves: leavingOf(target, context.catalog),
    ...(typeof terminal === "string" && declared.includes("terminal") ? { ownTerminal: { key: keyOf(place, "terminal"), address: terminal } } : {}) };
}

/**
 * What the Settings page's Install does (A11-163): a plugin of a concern whose block names ANOTHER plugin replaces it through the switch (`enable`), which keeps the settings both declare;
 * a concern that names none, or only its default, is installed (`install`, replacing that default). The CLI's `install --replace` drops the old plugin's settings and the page does not.
 */
export function planInstallOrSwitch(name: string, context: PlanContext): Plan {
  const { report } = targetOf(name, context);
  const another = report.provider !== "none" && report.provider !== name;
  if (another && report.from === "block") return planEnable(name, context);
  return planInstall(name, { sets: [], replace: another }, context);
}

/**
 * The plugin that installing `name` replaces on the page, and the settings of it that `name` does not declare and the switch drops, or null when it replaces none: the words of the
 * confirmation the page asks before it installs (A11-163).
 */
export function replacementOf(name: string, context: PlanContext): Readonly<{ replaced: string; dropped: readonly string[] }> | null {
  const { plugin, report } = targetOf(name, context);
  if (report.provider === "none" || report.provider === name || report.from !== "block") return null;
  const declared = blockSettings(plugin);
  return { replaced: report.provider, dropped: heldSettings(report).map(([setting]) => setting).filter((setting) => !declared.includes(setting)) };
}

/** Switches an installed plugin on. One that is on is left as it is. A plugin of the concern that the place does not name replaces the one it does (A11-162). */
export function planEnable(name: string, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseFake(target.plugin, context.catalog);
  refuseWhileAliased(target, context.providers);
  if (!isInstalled(target) && target.report.from === "block" && target.report.provider !== "none") return planSwitch(target, context);
  refuseUnlessInstalled(target);
  const { place, plugin } = target;
  if (target.report.enabled) return { changes: [], said: `${name} is already enabled` };
  return { changes: [{ key: keyOf(place, "enabled"), value: true }], said: `enabled ${name}: it is the ${CONCERN_LABEL[plugin.concern]} again, with the settings it kept`, file: place.file };
}

/** What a concern does with no plugin: the board publishes nothing, starts no reviewer, serves on loopback only, or tells the chairman nothing. */
const WITHOUT: Readonly<Record<Concern, string>> = {
  tracker: "the board reads no tickets", codeHost: "the board reads no pull requests", publisher: "the board publishes nothing", reviewer: "the board starts no reviewer",
  exposure: "the board is served on loopback only", messaging: "nothing is sent to the chairman and nothing is asked",
};

/** Switches an installed plugin off, keeping its settings. The only tracker and the only code host may not be: that is refused by name, installed or not. */
export function planDisable(name: string, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseWhileAliased(target, context.providers);
  const only = onlyOneSentence(target.plugin.concern, name);
  if (only !== null) refuse(`${only}: it cannot be disabled`);
  refuseUnlessInstalled(target);
  if (!target.report.enabled) return { changes: [], said: `${name} is already disabled` };
  const { place, plugin } = target;
  return { changes: [{ key: keyOf(place, "enabled"), value: false }], file: place.file, leaves: leavingOf(target, context.catalog),
    said: `disabled ${name}: ${WITHOUT[plugin.concern]}, and its settings are kept for \`enable\`` };
}

/** Removes the plugin's block, so its concern takes its default. The only tracker and the only code host may not be: their default would put the same plugin back. */
export function planUninstall(name: string, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseWhileAliased(target, context.providers);
  const only = onlyOneSentence(target.plugin.concern, name);
  if (only !== null) refuse(`${only}: it cannot be uninstalled, since its default would put ${name} back`);
  refuseUnlessInstalled(target);
  const { place, plugin } = target;
  const fallback = plugin.concern === "messaging" ? "none" : DEFAULT_PROVIDER[blockOf(plugin.concern)!];
  const whole = plugin.concern === "messaging" ? ", and the whole messaging key goes with it (its summary and milestones too; project.json.bak holds it)" : "";
  return { changes: [{ key: keyOf(place), remove: true }], file: place.file, leaves: leavingOf(target, context.catalog),
    said: `uninstalled ${name}: the ${CONCERN_LABEL[plugin.concern]} falls back to its default, ${fallback}${whole}` };
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
    return `${keyOf(target.place, key)}: ${value === undefined ? "not set" : JSON.stringify(value)}`;
  });
}

/** Sets and removes settings of an installed plugin's block. The reader refuses a setting the plugin does not declare, and a value it does not accept, by name. */
export function planConfig(name: string, options: Readonly<{ sets: readonly string[]; unsets: readonly string[] }>, context: PlanContext): Plan {
  const target = targetOf(name, context);
  refuseWhileAliased(target, context.providers);
  refuseUnlessInstalled(target);
  const removals: Change[] = options.unsets.map((setting) => ({ key: keyOf(target.place, setting), remove: true }));
  const changes = [...settingChanges(target.place, options.sets), ...removals];
  if (changes.length === 0) return refuse("name a setting to set (key=value) or to remove (--unset key)");
  return { changes, file: target.place.file, said: `changed ${name}'s settings${isActive(target.report) ? "" : " (it is disabled, so they apply when it is enabled)"}` };
}
