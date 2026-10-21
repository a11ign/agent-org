// @ts-check
// module: the one account of each agent-org plugin that doctor and the Settings page both read (A11-163)
//
// PURE. The caller passes the catalog, the resolved providers, what the project says of messaging, the loader's result and the checks each loaded plugin reported; nothing is read or run
// here. The answer is one entry per concern and, inside it, one per plugin of the catalog (the fakes are core's test doubles and are never listed): its name, version, contract,
// where its code lives and its STATE, in words and never by colour alone.
//
//   enabled        a block names the plugin and `enabled` is not false (or it is the concern's default, which runs)
//   disabled       a block names it and `enabled` is false: its settings are kept for `enable`
//   not installed  no block names it
//   failed         it does not load: the registry refused its package, it implements a contract major this release does not read, or the loader refused it (an import that threw, or a
//                  `create` that threw). A plugin that loaded and whose own checks fail stays `enabled`, with those checks on its row.
//
// A FAILED PLUGIN CARRIES DOCTOR'S WORDS. The reason and the fix are the ones doctor's row says, so the page's red row and `agent-org doctor` agree word for word.
//
// THE CONTROLS A PLUGIN OFFERS ARE THE CLI'S PLANS (`manage.ts`), asked and not written: a control a plan refuses is offered with the refusal's sentence, so the page says why a button is
// off in the CLI's own words. A plugin that needs a secret is installed from the CLI or onboard, never by a button that could not give it one: the page shows the install command, then
// the command that sets each secret. A secret is never in an entry: only the command that sets it.
import type { SchemaEntry } from "../ticket-mode/config-schema.ts";
import { isActive, type BlockReport, type Providers } from "../ticket-mode/providers.ts";
import { blockOf, CONCERN_LABEL, CONCERNS, type Concern, REQUIRED_CONCERNS } from "./concerns.ts";
import type { LoadResult } from "./loader.ts";
import { messagingReport, type Plan, planDisable, planEnable, planInstallOrSwitch, type PlanContext, PluginCommandRefusal, planUninstall, replacementOf } from "./manage.ts";
import type { Catalog, CatalogPlugin, PluginCheck } from "./manifest.ts";
import { pluginsOfConcern } from "./registry.ts";
import { enableRefusal } from "./rules.ts";
import { readsConcernContract, unreadMajorRefusal } from "./version.ts";
import { type MessagingState, whereOf } from "./view.ts";

export type HealthState = "enabled" | "disabled" | "not installed" | "failed";

/** What the controls of a row are called, in the order they are drawn. `configure` opens the plugin's own settings. */
export type ControlName = "install" | "enable" | "disable" | "uninstall" | "configure";

/** Why a plugin is failed and the one thing to do, in doctor's words. */
export type Failure = Readonly<{ why: string; fix: string }>;

/** The command that sets one secret setting of a plugin, filled from the setting's value, and the setting it is for. */
export type SecretCommand = Readonly<{ setting: string; command: string }>;

/** What a control does when asked: the sentence that confirms it first, when it needs one. */
export type Controls = Readonly<{
  /** The controls this row draws, each offered or, when `refused` names it, drawn off with the refusal's sentence beside it. */
  offered: readonly ControlName[];
  refused: Readonly<Partial<Record<ControlName, string>>>;
  /** The sentence the page asks to be confirmed before it acts: Uninstall always, and an Install that replaces another plugin. */
  confirm: Readonly<Partial<Record<"install" | "uninstall", string>>>;
}>;

export type PluginEntry = Readonly<{
  name: string;
  concern: Concern;
  /** agent-org's own release: a bundled or built-in plugin is built and versioned with it (Decision 3 of A11-157). */
  version: string;
  contract: string;
  /** `plugins/<name>`, or `core, until A11-xxx`. */
  where: string;
  description: string;
  state: HealthState;
  /** Whether a block of the host (or the project's `messaging` key) names the plugin. */
  installed: boolean;
  /** Whether the concern runs this plugin: it is named and not switched off. */
  enabled: boolean;
  checks: readonly PluginCheck[];
  failure: Failure | null;
  controls: Controls;
  /** `agent-org plugin install <name>`. */
  installCommand: string;
  /** The command for each secret the plugin takes. Empty for a plugin that needs none. */
  secrets: readonly SecretCommand[];
  /** The schema keys of the plugin's own settings (`tickets.providers.<block>.<name>`, with `<role>` for a map's name), which the page draws under Configure. */
  settingKeys: readonly string[];
}>;

/** What a concern shows when no plugin runs: the sentence, and the commands that add or enable one. */
export type Empty = Readonly<{ text: string; commands: readonly string[] }>;

export type ConcernEntry = Readonly<{
  concern: Concern;
  label: string;
  /** The file the concern is configured in: a block of the host file, or the project's `messaging` key. A change to it is checked against that file's `base`. */
  file: "host.json" | "project.json";
  required: boolean;
  /** The plugin that runs the concern, or null. */
  enabled: string | null;
  empty: Empty | null;
  plugins: readonly PluginEntry[];
}>;

export type PluginHealth = Readonly<{
  version: string;
  /** What the project's `messaging` key says, which doctor's messaging section words: the plugin it names and whether it is on, and none of its settings (the answer goes to the page). */
  messaging: MessagingState;
  /** Why the plugin the `messaging` key names could not be asked for its checks, when it names one the registry does not hold. */
  messagingFailure: Failure | null;
  concerns: readonly ConcernEntry[];
  /** Packages the registry refused, which name no concern: a red row each. */
  refused: readonly Readonly<{ plugin: string; failure: Failure }>[];
}>;

export type HealthInput = Readonly<{
  catalog: Catalog;
  providers: Providers;
  messaging: MessagingState;
  load: Pick<LoadResult, "loaded" | "unbuilt" | "refusals">;
  /** The checks each loaded (or unbuilt) plugin reported, by plugin name. */
  checks: Readonly<Record<string, readonly PluginCheck[]>>;
  /** Why the project's `messaging` key is not usable, when the plugin it names could not be asked for its checks (its words, with the fix). */
  messagingFailure?: Failure | null;
  /** agent-org's release, as `vX.Y.Z`. */
  version: string;
}>;

const UNREAD_FIX = "update agent-org, or update the plugin to a contract major agent-org reads";
const REFUSED_PACKAGE_FIX = "fix the plugin's package.json, or remove the plugin";
const LOADER_FIX = "update agent-org, or the plugin";
const ENABLE_FIX = "fix the check it summarises";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as one word of a shell command: bare when it holds only characters a shell leaves alone (a path with `~` stays one a shell expands), else in single quotes, so a space or a metacharacter in it is text. */
const shellWord = (value: string): string => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/**
 * The command a template becomes: `{value}` is the setting's value, quoted for the shell, and `{value|fallback}` takes the template's own fallback when the file holds none (`<value>` when there
 * is none either).
 */
export function fillCommand(template: string, value: unknown): string {
  const held = typeof value === "string" && value !== "" ? shellWord(value) : null;
  return template.replace(/\{value(?:\|([^}]*))?\}/g, (_match, fallback: string | undefined) => held ?? fallback ?? "<value>");
}

/** The value a setting of a plugin holds in the block: a dotted name (`key.path`) is read inside the setting before the dot. A name with a `<placeholder>` is not one setting, so it has none. */
function heldValue(name: string, report: BlockReport): unknown {
  if (name.includes("<")) return undefined;
  const [first, ...inside] = name.split(".");
  return inside.reduce<unknown>((value, part) => (isObject(value) ? value[part] : undefined), report.settings[first]?.value);
}

const isSecret = (entry: SchemaEntry): boolean => entry.secret !== undefined && typeof entry.setCommand === "string";

function secretsOf(plugin: CatalogPlugin, report: BlockReport): readonly SecretCommand[] {
  return Object.entries(plugin.settings).filter(([, entry]) => isSecret(entry))
    .map(([setting, entry]) => ({ setting, command: fillCommand(entry.setCommand!, report.provider === plugin.name ? heldValue(setting, report) : undefined) }));
}

function reportOf(concern: Concern, { providers, messaging }: PlanContext): BlockReport {
  const block = blockOf(concern);
  return block === null ? messagingReport(messaging) : providers.blocks[block];
}

/** The sentence a plan refuses with, or null when it would go ahead. */
function refusalOf(plan: () => Plan): string | null {
  try {
    plan();
    return null;
  } catch (error) {
    if (error instanceof PluginCommandRefusal) return error.message;
    throw error;
  }
}

/** The failure of a plugin the loader refused: its own failing check says why when `create` threw (a key that cannot be read), else the loader's words. */
function loaderFailure(why: string, checks: readonly PluginCheck[]): Failure {
  const failing = checks.find((check) => !check.ok);
  return failing === undefined ? { why, fix: LOADER_FIX } : { why: failing.detail, fix: failing.fix ?? ENABLE_FIX };
}

function failureOf(plugin: CatalogPlugin, input: HealthInput, checks: readonly PluginCheck[]): Failure | null {
  if (!readsConcernContract(plugin.concern, plugin.contract)) return { why: unreadMajorRefusal(plugin.name, plugin.concern, plugin.contract), fix: UNREAD_FIX };
  const refusal = input.load.refusals.find((candidate) => candidate.plugin === plugin.name);
  return refusal === undefined ? null : loaderFailure(refusal.why, checks);
}

function controlsOf(plugin: CatalogPlugin, flags: Readonly<{ installed: boolean; enabled: boolean; secrets: boolean }>, context: PlanContext): Controls {
  const { name } = plugin;
  const offered: ControlName[] = [];
  const refused: Partial<Record<ControlName, string>> = {};
  const confirm: Partial<Record<"install" | "uninstall", string>> = {};
  const offer = (control: ControlName, refusal: string | null): void => {
    offered.push(control);
    if (refusal !== null) refused[control] = refusal;
  };
  if (flags.installed) {
    offer(flags.enabled ? "disable" : "enable", refusalOf(() => (flags.enabled ? planDisable(name, context) : planEnable(name, context))));
    offer("uninstall", refusalOf(() => planUninstall(name, context)));
    confirm.uninstall = `Uninstall ${name}? Its block is removed, with its settings, so the ${CONCERN_LABEL[plugin.concern]} takes its default.`;
  } else if (!flags.secrets) {
    const refusal = enableRefusal(plugin, context.catalog) ?? refusalOf(() => planInstallOrSwitch(name, context));
    offer("install", refusal);
    const replacement = refusal === null ? replacementOf(name, context) : null;
    if (replacement !== null) {
      const dropped = replacement.dropped.length === 0 ? "no setting is lost" : `its settings ${replacement.dropped.join(", ")} are dropped, since ${name} does not declare them`;
      confirm.install = `Install ${name}? It replaces ${replacement.replaced} as the ${CONCERN_LABEL[plugin.concern]}: ${dropped}.`;
    }
  }
  if ((flags.installed || flags.enabled) && Object.keys(plugin.settings).length > 0) offered.push("configure");
  return { offered, refused, confirm };
}

function entryOf(plugin: CatalogPlugin, input: HealthInput, context: PlanContext): PluginEntry {
  const report = reportOf(plugin.concern, context);
  const named = report.provider === plugin.name;
  const installed = named && report.from === "block";
  const enabled = named && report.enabled;
  const checks = input.checks[plugin.name] ?? [];
  // The messaging key the reader or the loader refused fails the plugin it names, in the words doctor's row has.
  const refusedKey = plugin.concern === "messaging" && enabled ? input.messagingFailure : null;
  const failure = refusedKey ?? failureOf(plugin, input, checks);
  const secrets = secretsOf(plugin, report);
  const state: HealthState = failure !== null ? "failed" : enabled ? "enabled" : named ? "disabled" : "not installed";
  return { name: plugin.name, concern: plugin.concern, version: input.version, contract: plugin.contract, where: whereOf(plugin), description: plugin.description, state, installed, enabled,
    checks, failure, controls: controlsOf(plugin, { installed, enabled, secrets: secrets.length > 0 }, context), installCommand: `agent-org plugin install ${plugin.name}`, secrets, settingKeys: Object.values(plugin.settings).map((entry) => entry.key) };
}

/** The empty state of a concern with no plugin running: the required ones cannot run the board, the optional ones say "None". Each gives the command that fixes it, one per plugin. */
function emptyOf(concern: Concern, plugins: readonly PluginEntry[]): Empty {
  const label = CONCERN_LABEL[concern];
  const commands = plugins.map((plugin) => (plugin.installed ? `agent-org plugin enable ${plugin.name}` : plugin.installCommand));
  return { text: REQUIRED_CONCERNS.includes(concern) ? `No ${label} enabled: the board cannot run` : "None", commands };
}

function concernEntry(concern: Concern, input: HealthInput, context: PlanContext): ConcernEntry {
  const plugins = pluginsOfConcern(input.catalog, concern).filter(({ where }) => where !== "fake").map((plugin) => entryOf(plugin, input, context));
  const report = reportOf(concern, context);
  const running = isActive(report) && report.provider !== "none" ? report.provider : null;
  return { concern, label: CONCERN_LABEL[concern], file: blockOf(concern) === null ? "project.json" : "host.json", required: REQUIRED_CONCERNS.includes(concern), enabled: running, empty: running === null ? emptyOf(concern, plugins) : null, plugins };
}

/** One account per concern, in the order tracker, code host, publisher, reviewer, exposure, messaging, then the packages the registry refused. */
export function pluginHealth(input: HealthInput): PluginHealth {
  const context: PlanContext = { providers: input.providers, catalog: input.catalog, messaging: input.messaging };
  return {
    version: input.version,
    messaging: input.messaging.provider === null ? input.messaging : { ...input.messaging, settings: {} },
    messagingFailure: input.messagingFailure ?? null,
    concerns: CONCERNS.map((concern) => concernEntry(concern, input, context)),
    refused: input.catalog.refusals.map(({ plugin, why }) => ({ plugin, failure: { why, fix: REFUSED_PACKAGE_FIX } })),
  };
}

/** The plugin entries doctor prints a section for: the one a block names (enabled or disabled) and any that failed. A plugin no block names, and that is whole, is for `plugin list`. */
export const sectionPlugins = (concern: ConcernEntry): readonly PluginEntry[] => concern.plugins.filter((plugin) => plugin.state === "failed" || plugin.enabled || plugin.installed);

/** A section's header in doctor: the concern, the plugin, its state and contract and where its code lives, such as `tracker: linear (enabled, contract 1.1, plugins/linear)`. */
export const sectionHeader = (label: string, plugin: PluginEntry): string => `${label}: ${plugin.name} (${plugin.state}, contract ${plugin.contract}, ${plugin.where})`;
