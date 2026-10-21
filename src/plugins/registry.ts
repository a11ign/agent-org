// @ts-check
// module: the registry -- every agent-org plugin this checkout knows, and what it refuses (A11-158)
//
// THE CATALOG IS BUILT FROM THREE PLACES, in this order, and a name that is already taken refuses the later plugin by name:
//   1. the bundled packages: each `plugins/<name>/package.json` of the tool's checkout with an `agentOrg` field (none until A11-159);
//   2. the built-ins: today's providers, whose code is still in core (`built-in.ts`), each with the ticket that moves it;
//   3. the fakes: one per concern, from `src/plugins/fakes/`.
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
import { BUILT_IN, CORE_RUNS, FAKES } from "./built-in.ts";
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

/** The tooling a manifest declares, or the reason it is wrong. An absent field is none. */
function toolingOf(declared: unknown): Tooling | string {
  if (declared === undefined) return NO_TOOLING;
  if (!isObject(declared)) return "agentOrg.tooling must be an object of mcpServers, connectors and skills";
  const { mcpServers = [], connectors = [], skills = [] } = declared;
  if (!isStrings(mcpServers)) return "agentOrg.tooling.mcpServers must be a list of server names";
  if (!isStrings(connectors) || !connectors.every((pattern) => pattern.startsWith("^mcp__"))) return "agentOrg.tooling.connectors must be a list of patterns anchored at \"^mcp__\"";
  if (!isStrings(skills)) return "agentOrg.tooling.skills must be a list of Claude Code skill names";
  return { mcpServers, connectors, skills };
}

const isSchemaEntry = (value: unknown): value is SchemaEntry => isObject(value) && ["key", "type", "explanation", "breaks"].every((field) => typeof value[field] === "string") && isObject(value.edit);

/** The settings a manifest declares, each keyed `tickets.providers.<block>.<name>`, or the reason one is wrong. Messaging has no block, so it declares none. */
function settingsOf(concern: Concern, declared: unknown): Readonly<Record<string, SchemaEntry>> | string {
  if (declared === undefined) return {};
  if (!isObject(declared)) return "agentOrg.settings must be an object of settings by name";
  const block = blockOf(concern);
  if (block === null && Object.keys(declared).length > 0) return `agentOrg.settings must be empty: ${concern} is configured in project.json, not in a provider block`;
  for (const [name, entry] of Object.entries(declared)) {
    if (!isSchemaEntry(entry)) return `agentOrg.settings.${name} must be a schema entry with a key, type, explanation, breaks and edit`;
    if (entry.key !== `tickets.providers.${block}.${name}`) return `agentOrg.settings.${name}.key must be tickets.providers.${block}.${name}, not ${JSON.stringify(entry.key)}`;
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
  const settings = settingsOf(concern as Concern, declared.settings);
  if (typeof settings === "string") return settings;
  const tooling = toolingOf(declared.tooling);
  if (typeof tooling === "string") return tooling;
  return { concern: concern as Concern, contract, description, entry, settings, tooling };
}

/** One bundled package: the plugin, or the refusal naming it. A directory with no `agentOrg` field is not a plugin and is skipped (null). */
function readPackage(root: string, name: string, files: PackageFiles): CatalogPlugin | CatalogRefusal | null {
  const dir = join(root, "plugins", name);
  let text: string | null;
  try {
    text = files.text(join(dir, "package.json"));
  } catch (error) {
    return { plugin: name, why: `plugin ${name}: package.json cannot be read: ${messageOf(error)}` };
  }
  if (text === null) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { plugin: name, why: `plugin ${name}: package.json is not valid JSON` };
  }
  if (!isObject(manifest) || manifest.agentOrg === undefined) return null;
  const refuse = (why: string): CatalogRefusal => ({ plugin: name, why: `plugin ${name}: ${why}` });
  if (!PLUGIN_NAME.test(name)) return refuse("its directory name must be lower-case letters, digits and hyphens, starting with a letter: it is the plugin's name");
  const dependencies = isObject(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
  if (dependencies.length > 0) {
    return refuse(`package.json declares dependencies (${dependencies.join(", ")}), which a host's install does not install: a bundled plugin imports core's types only and declares none (ADR 0001)`);
  }
  const data = manifestOf(manifest.agentOrg, (entry) => files.isFile(join(dir, entry)));
  if (typeof data === "string") return refuse(data);
  return Object.freeze({ ...data, name, where: "bundled", dir, movedBy: null });
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
 * The catalog of a checkout: its bundled packages, then the built-ins, then the fakes. A name taken twice refuses the later plugin, by name. `root` and `files` are a
 * test's; the default is this checkout on disk.
 */
export function buildCatalog({ root = TOOL_CHECKOUT, files = DISK, pins = CORE_RUNS }: Readonly<{ root?: string; files?: PackageFiles; pins?: Catalog["pins"] }> = {}): Catalog {
  const refusals: CatalogRefusal[] = [];
  const plugins: CatalogPlugin[] = [];
  const bundled = packagesOf(root, files);
  for (const candidate of [...bundled, ...BUILT_IN, ...FAKES]) {
    if ("why" in candidate) refusals.push(candidate);
    else if (plugins.some(({ name }) => name === candidate.name)) refusals.push({ plugin: candidate.name, why: `plugin ${candidate.name} is named twice, and plugin names are unique: the ${candidate.where} plugin is refused, and the one found first stays` });
    else plugins.push(candidate);
  }
  return Object.freeze({ plugins: Object.freeze(plugins), refusals: Object.freeze(refusals), pins });
}

let memo: Catalog | null = null;

/** This checkout's catalog, read once per process. */
export function defaultCatalog(): Catalog {
  memo ??= buildCatalog();
  return memo;
}

/** The plugin of this name, or undefined. */
export const pluginNamed = (catalog: Catalog, name: string): CatalogPlugin | undefined => catalog.plugins.find((plugin) => plugin.name === name);

/** The catalog's plugins of one concern, in catalog order. */
export const pluginsOfConcern = (catalog: Catalog, concern: Concern): readonly CatalogPlugin[] => catalog.plugins.filter((plugin) => plugin.concern === concern);
