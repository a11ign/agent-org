// @ts-check
// module: the registry -- every agent-org plugin this checkout knows, and what it refuses (A11-158)
//
// THE CATALOG IS BUILT FROM TWO PLACES, in this order, and a name that is already taken refuses the later plugin by name:
//   1. the bundled packages: each `plugins/<directory>/package.json` of the tool's checkout with an `agentOrg` field. The plugin's name is its directory's, unless `agentOrg.name` gives
//      another (`plugins/atomic-reviewer` is `atomic`, the name live host files use);
//   2. the fakes: one per concern, from `src/plugins/fakes/`.
// Bundled packages are found in the CHECKOUT, not through `node_modules`: a host installs agent-org with `--ignore-workspace`, which links no workspace package
// (ADR 0001). For the same reason a bundled package that declares `dependencies` is refused by name, since a host's install would not install them.
//
// A REFUSAL IS DATA, NOT A THROW. A malformed package is one entry of `refusals`, so doctor can say it and a host that does not enable it still starts. A block that
// names a refused plugin is refused by the reader, with this reason.
//
// READ ONCE PER PROCESS (`defaultCatalog`); a test passes its own root, or its own catalog.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaEntry } from "../ticket-mode/config-schema.ts";
import { blockOf, CONCERNS, type Concern } from "./concerns.ts";
import { FAKES } from "./built-in.ts";
import type { Providers } from "../ticket-mode/providers.ts";
import { PRIORITIES, type TrackerWriting } from "./contracts/tracker.ts";
import { type Catalog, type CatalogPlugin, type CatalogRefusal, type ManifestData, NO_TOOLING, type Tooling } from "./manifest.ts";
import { CONTRACT_VERSION } from "./version.ts";

/** The tool's checkout: this file is `<root>/src/plugins/registry.ts`. Computed here, since `install/paths.ts` imports the readers that import this. */
export const TOOL_CHECKOUT = fileURLToPath(new URL("../../", import.meta.url));

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether a relative path stays inside the directory it is joined to: no absolute path, and no `..` out of it. */
const isInsidePackage = (path: string): boolean => path !== "" && resolve("/package", path).startsWith(`/package${sep}`);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * What reading a package costs the registry: the directory listing and a file's text, so a test reads a fixture without a disk. A path that is not there is `[]` or `null`: that is
 * "no plugin here". A path that is there and cannot be read THROWS, and the registry refuses it by name: an unreadable plugin is never taken for an absent one.
 */
export type PackageFiles = Readonly<{ directories(path: string): readonly string[]; text(path: string): string | null; isFile(path: string): boolean }>;

const isAbsent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const DISK: PackageFiles = {
  directories: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(({ name }) => name).sort();
    } catch (error) {
      if (isAbsent(error)) return [];
      throw error;
    }
  },
  text: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  },
  isFile: (path) => existsSync(path) && statSync(path).isFile(),
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const isAnchoredPattern = (value: unknown): value is string => isText(value) && value.startsWith("^") && value.endsWith("$") && compiles(value);
const isRefusedInput = (item: unknown): boolean => isObject(item) && isText(item.input) && isText(item.refusal);
const isCreatedKeyShape = (value: unknown): boolean => isObject(value) && (value.wrapper === null || isText(value.wrapper)) && isStrings(value.fields) && value.fields.length > 0;
const namesEveryPriority = (value: unknown): boolean => isObject(value) && PRIORITIES.every((name) => typeof value[name] === "number");

/** The `writer` a tracker's tooling declares (contract 1.1, `TrackerWriting`), or the reason it is wrong. */
function writerOf(declared: Record<string, unknown>): TrackerWriting | string {
  const at = "agentOrg.tooling.writer";
  const { label, createTool, attachTools, filingTools, refusedInputs, attachTicketInput, createdKey, priorities, readTools, briefNote } = declared;
  if (!isText(label) || !isText(briefNote) || !isText(attachTicketInput)) return `${at} must name a label, a briefNote and the attachTicketInput`;
  if (!isText(createTool) || !createTool.startsWith("mcp__")) return `${at}.createTool must be a tool name starting \"mcp__\"`;
  if (!isStrings(attachTools) || !attachTools.every((tool) => tool.startsWith("mcp__"))) return `${at}.attachTools must be a list of tool names starting \"mcp__\"`;
  if (!isAnchoredPattern(filingTools)) return `${at}.filingTools must be a regular expression anchored with ^ and $`;
  const filing = new RegExp(filingTools);
  const ungranted = [createTool, ...attachTools].find((tool) => !filing.test(tool));
  if (ungranted !== undefined) return `${at}.filingTools must match every tool the writer is granted, and does not match ${ungranted}`;
  if (!Array.isArray(refusedInputs) || !refusedInputs.every(isRefusedInput)) return `${at}.refusedInputs must be a list of { input, refusal }`;
  if (!isCreatedKeyShape(createdKey)) return `${at}.createdKey must be { wrapper, fields }`;
  if (!namesEveryPriority(priorities)) return `${at}.priorities must give a number for each of ${PRIORITIES.join(", ")}`;
  if (!isStrings(readTools) || readTools.length === 0) return `${at}.readTools must be a list of the tool names the writer reads duplicates with`;
  return { label, createTool, attachTools, filingTools, refusedInputs: refusedInputs as TrackerWriting["refusedInputs"], attachTicketInput,
    createdKey: createdKey as TrackerWriting["createdKey"], priorities: priorities as TrackerWriting["priorities"], readTools, briefNote };
}

/** The tooling a manifest declares, or the reason it is wrong. An absent field is none. A `writer` is a tracker's only. */
function toolingOf(declared: unknown, concern: Concern): Tooling | string {
  if (declared === undefined) return NO_TOOLING;
  if (!isObject(declared)) return "agentOrg.tooling must be an object of mcpServers, connectors and skills";
  const { mcpServers = [], connectors = [], skills = [], connectorServers, writer } = declared;
  if (!isStrings(mcpServers)) return "agentOrg.tooling.mcpServers must be a list of server names";
  if (!isStrings(connectors) || !connectors.every((pattern) => pattern.startsWith("^mcp__"))) return "agentOrg.tooling.connectors must be a list of patterns anchored at \"^mcp__\"";
  if (!isStrings(skills)) return "agentOrg.tooling.skills must be a list of Claude Code skill names";
  if (connectorServers !== undefined && !isStrings(connectorServers)) return "agentOrg.tooling.connectorServers must be a list of server names";
  if (writer === undefined) return { mcpServers, connectors, skills, ...(connectorServers === undefined ? {} : { connectorServers }) };
  if (concern !== "tracker") return `agentOrg.tooling.writer is a tracker's: ${concern} plugins file no tickets`;
  if (!isObject(writer)) return "agentOrg.tooling.writer must be an object";
  const written = writerOf(writer);
  if (typeof written === "string") return written;
  return { mcpServers, connectors, skills, ...(connectorServers === undefined ? {} : { connectorServers }), writer: written };
}

const isSchemaEntry = (value: unknown): value is SchemaEntry => isObject(value) && ["key", "type", "explanation", "breaks"].every((field) => typeof value[field] === "string") && isObject(value.edit);

/**
 * The settings a manifest declares, each keyed `tickets.providers.<block>.<name>`, or the reason one is wrong. Messaging has no block: its settings are keys of the project's `messaging`
 * (`messaging.<name>` in `project.json`), and a messaging manifest says so (A11-162). A name with a dot (`key.path`) is a part of the setting before the dot, which the Settings page draws
 * as a row of its own: it must follow a setting the manifest declares, and it is not a setting of the block (`blockSettings`).
 */
function settingsOf(concern: Concern, declared: unknown): Readonly<Record<string, SchemaEntry>> | string {
  if (declared === undefined) return {};
  if (!isObject(declared)) return "agentOrg.settings must be an object of settings by name";
  const block = blockOf(concern);
  const keyPrefix = block === null ? "messaging" : `tickets.providers.${block}`;
  const file = block === null ? "project.json" : "host.json";
  for (const [name, entry] of Object.entries(declared)) {
    if (!isSchemaEntry(entry)) return `agentOrg.settings.${name} must be a schema entry with a key, type, explanation, breaks and edit`;
    if (entry.key !== `${keyPrefix}.${name}`) return `agentOrg.settings.${name}.key must be ${keyPrefix}.${name}, not ${JSON.stringify(entry.key)}`;
    if (entry.file !== file) return `agentOrg.settings.${name}.file must be ${file}: ${concern} is configured there, not in ${JSON.stringify(entry.file)}`;
    // A secret is never typed in the Settings page (A11-163), so the page shows the command that sets it: a manifest that names a secret and no such command is refused.
    if (entry.secret !== undefined && !isText(entry.setCommand)) return `agentOrg.settings.${name} is a secret (${entry.secret}) and must declare setCommand, the exact command that sets it: the Settings page shows it and never takes a secret`;
    if (entry.setCommand !== undefined && !isText(entry.setCommand)) return `agentOrg.settings.${name}.setCommand must be the command as text`;
    // A part of a list's items (`gh.leadsWorkspaces[].id`) is a part of the list (`gh.leadsWorkspaces`).
    const parent = name.includes(".") ? name.slice(0, name.lastIndexOf(".")).replace(/\[\]$/, "") : null;
    if (parent !== null && !(parent in declared)) return `agentOrg.settings.${name} is a part of ${parent}, which the manifest does not declare`;
  }
  return declared as Readonly<Record<string, SchemaEntry>>;
}

/** The manifest data of a package's `agentOrg` field, or the reason it is malformed. `entryExists` says whether a path inside the package is a file. */
function manifestOf(declared: unknown, entryExists: (entry: string) => boolean): ManifestData | string {
  if (!isObject(declared)) return "agentOrg must be an object";
  const { concern, contract, description, entry } = declared;
  if (typeof concern !== "string" || !(CONCERNS as readonly string[]).includes(concern)) return `agentOrg.concern must be one of ${CONCERNS.join(", ")}, not ${JSON.stringify(concern)}`;
  if (typeof contract !== "string" || !CONTRACT_VERSION.test(contract)) return "agentOrg.contract must be \"<major>.<minor>\", such as \"1.0\"";
  if (typeof description !== "string" || description === "") return "agentOrg.description must be a sentence saying what the plugin does";
  if (typeof entry !== "string" || !isInsidePackage(entry)) return "agentOrg.entry must be the entry module's path inside the package, such as \"index.ts\"";
  if (!entryExists(entry)) return `agentOrg.entry ${JSON.stringify(entry)} is not a file in the package`;
  const { setUp } = declared;
  if (setUp !== undefined && (typeof setUp !== "string" || setUp === "")) return "agentOrg.setUp must be a sentence saying what is set up, such as \"Linear connected as the tracker\"";
  const settings = settingsOf(concern as Concern, declared.settings);
  if (typeof settings === "string") return settings;
  const tooling = toolingOf(declared.tooling, concern as Concern);
  if (typeof tooling === "string") return tooling;
  return { concern: concern as Concern, contract, description, ...(setUp === undefined ? {} : { setUp }), entry, settings, tooling };
}

/**
 * The name a package's plugin goes by: the optional `agentOrg.name`, else the package's directory (`plugins/atomic-reviewer` is the plugin `atomic`, since live host files name it so, A11-161).
 * A declared name that is not text is the reason the package is refused, which then names the directory.
 */
function nameOf(declared: unknown, directory: string): string | { why: string } {
  if (!isObject(declared) || declared.name === undefined) return directory;
  return typeof declared.name === "string" ? declared.name : { why: "agentOrg.name must be the plugin's name as text" };
}

/** One bundled package: the plugin, or the refusal naming it. A directory with no `agentOrg` field is not a plugin and is skipped (null). */
function readPackage(root: string, directory: string, files: PackageFiles): CatalogPlugin | CatalogRefusal | null {
  const dir = join(root, "plugins", directory);
  let text: string | null;
  try {
    text = files.text(join(dir, "package.json"));
  } catch (error) {
    return { plugin: directory, why: `plugin ${directory}: package.json cannot be read: ${messageOf(error)}` };
  }
  if (text === null) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { plugin: directory, why: `plugin ${directory}: package.json is not valid JSON` };
  }
  if (!isObject(manifest) || manifest.agentOrg === undefined) return null;
  const named = nameOf(manifest.agentOrg, directory);
  if (typeof named !== "string") return { plugin: directory, why: `plugin ${directory}: ${named.why}` };
  const name = named;
  const refuse = (why: string): CatalogRefusal => ({ plugin: name, why: `plugin ${name}: ${why}` });
  if (!PLUGIN_NAME.test(name)) return refuse(name === directory ? "its directory name must be lower-case letters, digits and hyphens, starting with a letter: it is the plugin's name"
    : "its agentOrg.name must be lower-case letters, digits and hyphens, starting with a letter");
  const dependencies = isObject(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
  if (dependencies.length > 0) {
    return refuse(`package.json declares dependencies (${dependencies.join(", ")}), which a host's install does not install: a bundled plugin imports core's types only and declares none (ADR 0001)`);
  }
  const data = manifestOf(manifest.agentOrg, (entry) => files.isFile(join(dir, entry)));
  if (typeof data === "string") return refuse(data);
  return Object.freeze({ ...data, name, where: "bundled", dir });
}

/** Every bundled package of the checkout, or the refusal naming the plugins folder when it exists and cannot be listed. */
function packagesOf(root: string, files: PackageFiles): (CatalogPlugin | CatalogRefusal)[] {
  const folder = join(root, "plugins");
  try {
    return files.directories(folder).map((name) => readPackage(root, name, files)).filter((read) => read !== null);
  } catch (error) {
    return [{ plugin: "plugins", why: `the plugins folder ${folder} cannot be read: ${messageOf(error)}` }];
  }
}

/**
 * The catalog of a checkout: its bundled packages, then the fakes. A name taken twice refuses the later plugin, by name. `root` and `files` are a
 * test's; the default is this checkout on disk.
 */
export function buildCatalog({ root = TOOL_CHECKOUT, files = DISK }: Readonly<{ root?: string; files?: PackageFiles }> = {}): Catalog {
  const refusals: CatalogRefusal[] = [];
  const plugins: CatalogPlugin[] = [];
  const bundled = packagesOf(root, files);
  for (const candidate of [...bundled, ...FAKES]) {
    if ("why" in candidate) refusals.push(candidate);
    else if (plugins.some(({ name }) => name === candidate.name)) refusals.push({ plugin: candidate.name, why: `plugin ${candidate.name} is named twice, and plugin names are unique: the ${candidate.where} plugin is refused, and the one found first stays` });
    else plugins.push(candidate);
  }
  return Object.freeze({ plugins: Object.freeze(plugins), refusals: Object.freeze(refusals) });
}

let memo: Catalog | null = null;

/** This checkout's catalog, read once per process. */
export function defaultCatalog(): Catalog {
  memo ??= buildCatalog();
  return memo;
}

/** The names of the settings a plugin takes in its block: its declared settings, less the parts of one (`key.path`), which the Settings page draws and the block does not hold. */
export const blockSettings = (plugin: Pick<CatalogPlugin, "settings">): string[] => Object.keys(plugin.settings).filter((name) => !name.includes("."));

/** Whether a connector pattern of the host file names a tool of a server the plugin's tooling declares (`^mcp__<server>__...`): the pattern is the plugin's, and belongs in its block's `connectors`. */
export function ownsConnector(plugin: Pick<CatalogPlugin, "tooling">, pattern: string): boolean {
  const servers = plugin.tooling.connectorServers ?? plugin.tooling.mcpServers;
  return servers.some((server) => pattern.startsWith(`^mcp__${server}__`));
}

/** Whether a connector pattern is one of the catalog's trackers: `tickets.providers.tracker.connectors` takes it, and `tickets.connectors` keeps the rest. */
export const isTrackerConnector = (catalog: Catalog, pattern: unknown): boolean => typeof pattern === "string"
  && catalog.plugins.some((plugin) => plugin.concern === "tracker" && ownsConnector(plugin, pattern));

/**
 * What the tracker plugin the host names files a new-ticket run's tickets with (tracker contract 1.1, `TrackerWriting`), read from its manifest. REFUSES, naming the plugin, a tracker
 * that declares none: it cannot be asked to file a ticket.
 */
export function trackerWritingOf(providers: Providers, catalog: Catalog = defaultCatalog()): TrackerWriting {
  const { provider } = providers.blocks.tracker;
  const writing = pluginNamed(catalog, provider)?.tooling.writer;
  if (writing === undefined) throw new Error(`the tracker ${provider} declares no writer tooling (tracker contract 1.1), so a new-ticket run cannot file a ticket with it`);
  return writing;
}

/** The plugin of this name, or undefined. */
export const pluginNamed = (catalog: Catalog, name: string): CatalogPlugin | undefined => catalog.plugins.find((plugin) => plugin.name === name);

/** The catalog's plugins of one concern, in catalog order. */
export const pluginsOfConcern = (catalog: Catalog, concern: Concern): readonly CatalogPlugin[] => catalog.plugins.filter((plugin) => plugin.concern === concern);
