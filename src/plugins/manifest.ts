// @ts-check
// module: what an agent-org plugin declares, and what the registry knows of one (A11-158)
//
// A MANIFEST HAS TWO HALVES. The DATA half is JSON, the `agentOrg` field of the plugin package's `package.json`: its concern, contract version, description, entry
// module, settings (each in `config-schema.ts`'s `SchemaEntry` shape, so the Settings page can draw the section) and agent tooling. It is read synchronously, because
// `resolveProviders` is, and without importing any plugin code: "loads only enabled ones". The CODE half is the entry module's export (`PluginModule`), imported
// only for an enabled plugin. The plugin's name is its package's directory name.
//
// A PLUGIN IMPORTS CORE'S TYPES ONLY (ADR 0001). Every runtime helper reaches it through `create(settings, deps)`.
import type { SchemaEntry } from "../ticket-mode/config-schema.ts";
import type { Concern } from "./concerns.ts";

/** One doctor row a plugin reports: its name, whether it passed, what it found and, when it failed, the one thing to do. The same shape as `Check` in `install/doctor.ts`, which a plugin may not import. */
export type PluginCheck = Readonly<{ name: string; ok: boolean; detail: string; fix: string | null }>;

/** What a plugin's workers need on a host: the MCP servers, the connector allow-list patterns (anchored at `^mcp__`) and the Claude Code skills. */
export type Tooling = Readonly<{ mcpServers: readonly string[]; connectors: readonly string[]; skills: readonly string[] }>;

/** The tooling of a plugin that declares none. */
export const NO_TOOLING: Tooling = Object.freeze({ mcpServers: [], connectors: [], skills: [] });

/** Where a plugin's code lives: in core (a built-in, until its sibling ticket moves it), in `plugins/<name>` (bundled), or in `src/plugins/fakes` (a fake). */
export type Where = "core" | "bundled" | "fake";

/** The data half, as `package.json`'s `agentOrg` field holds it. `settings` is by setting name, each entry keyed `tickets.providers.<block>.<name>`. */
export type ManifestData = Readonly<{
  concern: Concern;
  /** `<major>.<minor>` of the concern's contract this plugin implements. */
  contract: string;
  description: string;
  /** The entry module's path inside the plugin's directory, or null for a plugin whose code is not a bundled module. */
  entry: string | null;
  settings: Readonly<Record<string, SchemaEntry>>;
  tooling: Tooling;
}>;

/** A plugin as the registry lists it. `movedBy` names the ticket that moves a built-in's code into `plugins/<name>`, and is null for the rest. */
export type CatalogPlugin = ManifestData & Readonly<{ name: string; where: Where; dir: string | null; movedBy: string | null }>;

/** A plugin the registry refused, by name, and why. It is not in the catalog's plugins. */
export type CatalogRefusal = Readonly<{ plugin: string; why: string }>;

/**
 * While a concern is PINNED, core still runs that concern's built-in code, so only a plugin in `runs` may be enabled for it. `until` names the ticket that moves the
 * concern onto its contract and removes the pin.
 */
export type Pin = Readonly<{ runs: readonly string[]; until: string }>;

/** Every plugin agent-org knows, what it refused and which concerns are pinned. */
export type Catalog = Readonly<{ plugins: readonly CatalogPlugin[]; refusals: readonly CatalogRefusal[]; pins: Readonly<Partial<Record<Concern, Pin>>> }>;

/** The value of a setting as the plugin is given it. A setting the host file does not hold is absent, and the plugin applies its default. */
export type PluginSettings = Readonly<Record<string, unknown>>;

/** What a plugin is given by core to do its work: every runtime helper reaches it here, because it imports core's types only. Sibling tickets add helpers as they move code. */
export type PluginDeps = Readonly<{ env: Readonly<Record<string, string | undefined>>; stateDir: string; log: (line: string) => void }>;

/** One step onboard runs for a plugin: a name, what it does in a sentence, and the run, which answers whether it passed and says so. */
export type OnboardStep = Readonly<{ name: string; explain: string; run(settings: PluginSettings, deps: PluginDeps): Promise<Readonly<{ ok: boolean; detail: string }>> }>;

/** The code half: what a bundled plugin's entry module exports. `create` returns the concern's contract implementation. */
export type PluginModule = Readonly<{
  create(settings: PluginSettings, deps: PluginDeps): unknown;
  doctorChecks(settings: PluginSettings, deps: PluginDeps): readonly PluginCheck[] | Promise<readonly PluginCheck[]>;
  onboardSteps: readonly OnboardStep[];
}>;

/** A plugin that was loaded: the plugin, the implementation `create` returned, and its doctor rows and onboard steps. */
export type LoadedPlugin = Readonly<{ plugin: CatalogPlugin; implementation: unknown; module: PluginModule }>;
