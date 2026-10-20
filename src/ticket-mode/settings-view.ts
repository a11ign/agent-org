// @ts-check
// module: what the Settings page draws, decided from the schema and what the readers returned, with no file read and no browser
//
// THE PAGE DRAWS WHAT THIS RETURNS. Every rule the page's words follow is here, so it is tested without a browser: which state a key is in
// (`enabled`, `disabled`, `not set` or `default`, always as words, never colour alone), where its value comes from, which keys a refused file takes
// with it, and how a secret is shown. A secret is never shown: a key file or a secret path shows its path and whether the file exists.
//
// THE INPUT IS READ BY THE CALLER (`settings-read.ts`): each file's parsed object, the message each reader refused it with, the saved choices, the
// queue's number of workers and the plugin install record. This module imports no reader, so a ticket-only machine with no project loads it.
import type { ChoicePart, File, Group, Input, SchemaEntry } from "./config-schema.ts";
import { GROUPS } from "./config-schema.ts";
import type { PluginInstall, PluginState } from "./plugins.ts";
import type { ContractRow } from "./plugin-contract.ts";
import { isObject, valueAt } from "./json-value.ts";

export type Section = Readonly<{ file: string; raw: Readonly<Record<string, unknown>> | null; refusal: string | null }>;
export type ViewInput = Readonly<{
  entries: readonly SchemaEntry[];
  host: Section;
  tickets: Section;
  project: Section;
  /** Notes the page says plainly, not as errors: such as that the machine declares no project. */
  notes: readonly string[];
  choice: Readonly<{ saved: Readonly<Partial<Record<ChoicePart, string>>>; host: Readonly<{ writerModel?: string; writerEffort?: string }> }>;
  queue: Readonly<{ max: number; source: "queue.json" | "host.json" | "built-in default" }>;
  plugins: Readonly<{ readable: boolean; plugins: readonly PluginState[] }>;
  /** The contract rows of the plugins and host keys, one per mismatch. Returned in the view; drawing them is not this module's. */
  contract?: readonly ContractRow[];
  exists: (path: string) => boolean;
}>;

export type State = "enabled" | "disabled" | "not set" | "default";
export type Source = "host.json" | "project.json" | "choice.json" | "queue.json" | "built-in default";
/**
 * A row: what the key says in words, and, for a key the page may change, the kind of input that changes it (`input`) and its value as that input takes it (`raw`).
 * `editable` says the page changes the key in place; `why` says, for a key that is not, why not (null when it is editable). `alias` replaces the value text of
 * an old key that is set: where its new key is, and that `agent-org doctor --fix` moves it there.
 */
export type Row = Readonly<{ key: string; file: File; group: Group; value: string; state: State; source: Source; explanation: string; breaks: string; depth: number; secret: boolean;
  input: Input | null; raw: string | null; editable: boolean; why: string | null; alias: string | null;
  /** Whether the key matters to the host now: an old key matters only while it is set, and an App's field of a role that does not use an App only while the role uses one. The page hides the rest, and a search still finds them. */
  inUse: boolean;
  /** The row this one sits inside, for a key of a role (`identity.<role>`) or of the routing gh: the page nests it under that row. Null at the top of a section. */
  nest: string | null }>;
export type PluginLine = Readonly<{ plugin: string; installed: string; loads: string }>;
export type View = Readonly<{
  groups: readonly Readonly<{ group: Group; rows: readonly Row[] }>[];
  refusals: readonly Readonly<{ file: string; message: string }>[];
  notes: readonly string[];
  plugins: readonly PluginLine[];
  contract: readonly ContractRow[];
  words: readonly string[];
}>;

/** The built-in value of each choice, which applies when `choice.json` names none. */
const CHOICE_BUILT_IN: Readonly<Record<ChoicePart, string>> = { model: "opus", effort: "high", planModel: "opus", planEffort: "high", writerModel: "opus", writerEffort: "high" };

/** Which section reads a host.json key: ticket mode reads its block and the few top-level keys it shares with the board. */
const TICKET_READ = /^(tickets(\.|$)|clones(\.|$)|stateDir$|binDir$)/;

/** The keys an entry stands for: its `<name>` segments are filled from the keys the file holds at that place. */
function concreteKeys(key: string, root: Readonly<Record<string, unknown>> | null): string[] {
  const segments = key.split(".");
  const at = segments.findIndex((segment) => /^<[a-z]+>$/.test(segment));
  if (at === -1) return [key];
  const parent = valueAt(root, segments.slice(0, at));
  if (!isObject(parent)) return [];
  return Object.keys(parent).flatMap((name) => concreteKeys(segments.map((segment, i) => (i === at ? name : segment)).join("."), root));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a value says, in words. A secret path is shown as its path and whether the file is there, never what it holds. */
function showValue(shown: Readonly<{ key: string; value: unknown }>, entry: SchemaEntry, exists: (path: string) => boolean): string {
  const { key, value } = shown;
  if (entry.secret === "path" && typeof value === "string") return `${value} (the file ${exists(value) ? "exists" : "is missing"})`;
  if (entry.secret === "keychain" && typeof value === "string") return `the Keychain service ${value}; this page does not read the key`;
  if (key === "tickets.linearKey" && isObject(value)) return "keychain" in value ? "a Keychain service, named below" : "a file, named below";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "none" : plural(value.length, "item");
  // An object's own values are its entries' rows, so it names only the keys it holds.
  return isObject(value) ? Object.keys(value).join(", ") || "none" : "not set";
}

/** The state of a key the file holds: `disabled` for a switch that is false, else `enabled`. */
function stateWhenSet(entry: SchemaEntry, value: unknown): State {
  return entry.switch === true && value === false ? "disabled" : "enabled";
}

/** The state of a key the file does not hold, from its schema entry. */
function stateWhenAbsent(entry: SchemaEntry): State {
  if (entry.absent === "off") return "disabled";
  return entry.absent === "default" ? "default" : "not set";
}

/** A value as the page's input takes it: a text as it is, anything else as JSON. */
const rawOf = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** How the page may change a key: its input, whether it is changed in place, and, when it is not, why. */
const editOf = (entry: SchemaEntry): Pick<Row, "input" | "editable" | "why"> =>
  (entry.edit.editable ? { input: entry.edit.input, editable: true, why: null } : { input: null, editable: false, why: entry.edit.why });

/** Why a key is not changed in place, from its schema entry, and null for a key that is. */
const whyOf = (entry: SchemaEntry): string | null => (entry.edit.editable ? null : entry.edit.why);

/** The reason a choice or the number of workers is changed by the controls above the list, not in place. */
const CONTROLS_ABOVE = "changed with the controls above the list, not in place";

/** Whether a key matters now. A role's App fields (`appId`, `keyPath`, ...) matter only while the role's `mode` is `github-apps`; the role itself and its `mode` always do. */
function inUseOf(entry: SchemaEntry, key: string, root: Readonly<Record<string, unknown>>): boolean {
  const names = entry.key.split(".");
  const role = names.indexOf("<role>");
  const suffix = names.slice(role + 1).join(".");
  if (role === -1 || suffix === "" || suffix === "mode") return true;
  return valueAt(root, [...key.split(".").slice(0, role + 1), "mode"]) === "github-apps";
}

/** The row a key sits inside: a role's keys inside the role, and the routing gh's keys inside `gh`. Null for a key that sits at the top of its section. */
function nestOf(key: string): string | null {
  const role = /^((?:tickets\.providers\.codeHost|github)\.identity\.[^.]+)\..+/.exec(key);
  if (role) return role[1];
  const routing = /^((?:tickets\.providers\.codeHost\.)?gh)\..+/.exec(key);
  return routing ? routing[1] : null;
}

/** A role's row shows its mode, which is what a person reads of the role; the role's other keys sit inside it. */
function roleValue(root: Readonly<Record<string, unknown>>, path: readonly string[]): string {
  const mode = valueAt(root, [...path, "mode"]);
  return typeof mode === "string" ? mode : "user-accounts";
}

/** The text an old key shows in place of its value: its new key, with the names its `<name>` segments carry in this key, and the command that moves it. */
function aliasText(entry: SchemaEntry, key: string): string | null {
  if (entry.aliasOf === undefined) return null;
  const shown = key.split(".");
  const names = entry.key.split(".");
  const target = entry.aliasOf.split(".").map((segment) => (/^<[a-z]+>$/.test(segment) ? shown[names.indexOf(segment)] : segment)).join(".");
  return `Alias of ${target}: run agent-org doctor --fix`;
}

/** Whether the file holds any key an entry stands for. */
function anyKeySet(entry: SchemaEntry, input: ViewInput): boolean {
  const root = fileRoot(entry, input);
  return concreteKeys(entry.key, root).some((key) => valueAt(root, key.split(".")) !== undefined);
}

/** A provider's key in a block the file does not hold, when one of the block's old keys is set: the old key still sets it until `doctor --fix` moves it. */
function setByAliases(entry: SchemaEntry, input: ViewInput): boolean {
  if (!entry.key.startsWith("tickets.providers.") || !entry.key.endsWith(".provider")) return false;
  const block = entry.key.slice(0, -".provider".length);
  if (valueAt(fileRoot(entry, input), block.split(".")) !== undefined) return false;
  return input.entries.some((candidate) => candidate.aliasOf?.startsWith(`${block}.`) && anyKeySet(candidate, input));
}

/** The file a section's rows come from, for the source word of a key that is set. */
const fileOf = (entry: SchemaEntry): Source => (entry.file === "project.json" ? "project.json" : "host.json");

function sectionOf(entry: SchemaEntry, input: ViewInput): Section {
  if (entry.file === "project.json") return input.project;
  return TICKET_READ.test(entry.key) ? input.tickets : input.host;
}

/** The marker a list's element keys carry in the schema: `tickets.deny[].pattern` is `pattern` of each rule in `tickets.deny`. */
const ELEMENT = "[].";

/** The value a provider shows while only its old key sets it, until `doctor --fix` moves that key. */
const ALIASED_VALUE = "set by aliases";

/** The value an absent key shows: its built-in default when it has one. */
function absentValue(entry: SchemaEntry, state: State): string {
  return state === "default" ? (entry.default ?? "not set") : "not set";
}

/** The rows of one schema entry, for each key it stands for in the file, each followed by its list's element rows. */
function rowsOf(entry: SchemaEntry, input: ViewInput): Row[] {
  const root = fileRoot(entry, input);
  const rows: Row[] = [];
  for (const key of concreteKeys(entry.key, root)) {
    const path = key.split(".");
    const value = valueAt(root, path);
    const parentKey = path.slice(0, -1).join(".");
    const parent = input.entries.find((candidate) => candidate.file === entry.file && candidate.key === parentKey);
    const parentAbsent = parent !== undefined && parent.absent === "unset" && valueAt(root, path.slice(0, -1)) === undefined;
    const set = value !== undefined;
    // A provider whose block is missing but whose old key is set is in force from the file, through that old key.
    const aliased = !set && setByAliases(entry, input);
    // A child of an absent parent that has no value of its own is not set, whatever the entry's own default says.
    const state = set ? stateWhenSet(entry, value) : (aliased ? "enabled" : (parentAbsent ? "not set" : stateWhenAbsent(entry)));
    const source = set || aliased ? fileOf(entry) : "built-in default";
    const roleRow = /^(?:tickets\.providers\.codeHost|github)\.identity\.[^.]+$/.test(key);
    const shown = set ? (roleRow ? roleValue(root, path) : showValue({ key, value }, entry, input.exists)) : (aliased ? ALIASED_VALUE : absentValue(entry, state));
    rows.push({ key, file: entry.file, group: entry.group, value: shown, state, source, explanation: entry.explanation, breaks: entry.breaks, depth: path.length - 1, secret: entry.secret !== undefined,
      ...editOf(entry), raw: set ? rawOf(value) : null, alias: set ? aliasText(entry, key) : null, inUse: set || (entry.aliasOf === undefined && inUseOf(entry, key, root)), nest: nestOf(key) });
    if (Array.isArray(value)) rows.push(...elementRows({ parent: entry, key, items: value, state }, input));
  }
  return rows;
}

/** The element rows of a list: each `key[].field` entry shows its field of every item, in the list's order. */
function elementRows({ parent, key, items, state }: Readonly<{ parent: SchemaEntry; key: string; items: readonly unknown[]; state: State }>, input: ViewInput): Row[] {
  const prefix = `${parent.key}${ELEMENT}`;
  return input.entries
    .filter((entry) => entry.file === parent.file && entry.key.startsWith(prefix) && !entry.key.slice(prefix.length).includes("."))
    .map((entry) => {
      const field = entry.key.slice(prefix.length);
      const fieldKey = `${key}${ELEMENT}${field}`;
      const values = items.filter(isObject).map((item) => (item[field] === undefined ? "not set" : showValue({ key: fieldKey, value: item[field] }, entry, input.exists)));
      return { key: fieldKey, file: entry.file, group: entry.group, value: values.join("; ") || "none", state, source: fileOf(entry), explanation: entry.explanation,
        breaks: entry.breaks, depth: key.split(".").length, secret: entry.secret !== undefined, input: null, raw: null, editable: false, why: whyOf(entry) ?? "a list is changed as a whole",
        alias: items.length > 0 ? aliasText(entry, fieldKey) : null, inUse: entry.aliasOf === undefined || items.length > 0, nest: nestOf(fieldKey) };
    });
}

/** A choice the page's controls change: the saved one, else the host file's writer value, else the built-in one. */
function choiceRow(entry: SchemaEntry, input: ViewInput): Row {
  const part = entry.key as ChoicePart;
  const saved = input.choice.saved[part];
  const hostValue = part === "writerModel" || part === "writerEffort" ? input.choice.host[part] : undefined;
  const base = { key: entry.key, file: entry.file, group: entry.group, explanation: entry.explanation, breaks: entry.breaks, depth: 0, secret: false, input: null, raw: null,
    editable: false, why: CONTROLS_ABOVE, alias: null, inUse: true, nest: null };
  if (saved !== undefined) return { ...base, value: saved, state: "enabled", source: "choice.json" };
  if (hostValue !== undefined) return { ...base, value: hostValue, state: "default", source: "host.json" };
  return { ...base, value: CHOICE_BUILT_IN[part], state: "default", source: "built-in default" };
}

/** The page's queue line: the number of workers, and which file it came from. */
function queueRow(entry: SchemaEntry, input: ViewInput): Row {
  const { max, source } = input.queue;
  return { key: entry.key, file: entry.file, group: entry.group, value: String(max), state: source === "built-in default" ? "default" : "enabled", source,
    explanation: entry.explanation, breaks: entry.breaks, depth: 0, secret: false, input: null, raw: null, editable: false, why: CONTROLS_ABOVE, alias: null, inUse: true, nest: null };
}

/** The connector pattern's name, as the text between its `^mcp__` and the next `__`, or the pattern as written when it has none. */
const connectorName = (pattern: string): string => /^\^mcp__(.+?)__/.exec(pattern)?.[1] ?? "named by the pattern";

/** Each connector and deny rule in plain words: which tools a worker may call, and which commands it is refused, and why. */
function wordsOf(tickets: Readonly<Record<string, unknown>> | null): string[] {
  if (tickets === null) return [];
  const connectors = Array.isArray(tickets.connectors) ? tickets.connectors.filter((p): p is string => typeof p === "string") : [];
  const denies = Array.isArray(tickets.deny) ? tickets.deny.filter(isObject) : [];
  const publish = isObject(tickets.publish) && Array.isArray(tickets.publish.connectors) ? tickets.publish.connectors.filter((p): p is string => typeof p === "string") : [];
  return [
    ...connectors.map((pattern) => `A worker may call any tool of the connector \`${connectorName(pattern)}\` whose name matches \`${pattern}\`.`),
    ...denies.map((rule) => `A command matching \`${String(rule.pattern)}\` is refused, because ${String(rule.reason)}.`),
    ...publish.map((pattern) => `The publish run may call any tool of the connector \`${connectorName(pattern)}\` whose name matches \`${pattern}\`.`),
  ];
}

/**
 * Whether a worker's session loads a plugin, in words; `null` is an entry this page does not know, so it is not checked. A plugin installed only for
 * one folder is not said to be missing from every worker: a worker starts in its own ticket's folder, which this page does not know, so it says where
 * the install is and that only a worker there gets it.
 */
function loadsWords(plugin: string, { loads, why, installs }: Readonly<{ loads: boolean | null; why: string | null; installs: readonly PluginInstall[] }>): string {
  if (loads === null) return "not checked: its entry in the install record is not one this page knows";
  if (loads) return "a worker's session loads it";
  const onlyFolders = installs.length > 0 && installs.every((install) => install.scope === "project");
  const fix = `install it for every folder with \`claude plugin install ${plugin} --scope user\`.`;
  if (onlyFolders) return `only a worker in ${installs.map((install) => install.projectPath ?? "another folder").join(", ")} loads it; to load it for every worker, ${fix}`;
  return `a worker's session does not load it: ${why ?? ""}`;
}

/** Each plugin's installs and whether a worker's session loads it, in words. An unreadable record is not checked, never loaded. */
function pluginLines(input: ViewInput): PluginLine[] {
  return input.plugins.plugins.map(({ plugin, installs, loads, why }) => {
    const installed = installs.length === 0 ? "not installed" : installs.map((install) => (install.scope === "user" ? "installed for every folder" : `installed for the folder ${install.projectPath ?? "another folder"}`)).join("; ");
    const loadsText = input.plugins.readable ? loadsWords(plugin, { loads, why, installs }) : "not checked: Claude Code's install record cannot be read";
    return { plugin, installed, loads: loadsText };
  });
}

/** The settings page's view: each group's rows in the page's order, the refused files and what they say, the notes, the plugins, and the words of the connectors and deny rules. */
export function settingsView(input: ViewInput): View {
  const sections = [input.host, input.tickets, input.project];
  const refusals = sections.flatMap((section) => (section.refusal === null ? [] : [{ file: section.file, message: section.refusal }]));
  const rows = input.entries.flatMap((entry): Row[] => {
    // A list's element keys (`tickets.deny[].pattern`) are shown under their list, by `elementRows`, never on their own.
    if (entry.key.includes("[]")) return [];
    if (entry.file === "choice.json") return [choiceRow(entry, input)];
    const section = sectionOf(entry, input);
    if (section.refusal !== null || section.raw === null) return [];
    if (entry.key === "tickets.max") return [queueRow(entry, input)];
    return rowsOf(entry, input);
  });
  // Every group, in the page's order, even one with no rows: the plugins and connectors are drawn in one of them, and the page skips the rest when empty.
  const groups = GROUPS.map((group) => ({ group, rows: rows.filter((row) => row.group === group) }));
  return { groups, refusals, notes: input.notes, plugins: pluginLines(input), contract: input.contract ?? [], words: wordsOf(input.tickets.refusal === null ? input.tickets.raw : null) };
}

/** The object a key is read from in its file: the whole project file, or the whole host file, which a ticket key is read from too. */
function fileRoot(entry: SchemaEntry, input: ViewInput): Readonly<Record<string, unknown>> {
  if (entry.file === "project.json") return input.project.raw ?? {};
  return input.host.raw ?? {};
}
