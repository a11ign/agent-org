// @ts-check
// module: reads the files the Settings page describes, fresh, and hands what it read to `settings-view.ts`
//
// EACH FILE IS READ AND REFUSED ON ITS OWN. The host file's top level goes through `parseHostConfig`, its `tickets` block through
// `parseTicketSettings`, and a project's declaration through `parseProjectDeclaration` (all three in `settings-verdict.ts`, which a save uses too). A
// refusal is kept as its message, which names the field, and the other sections still render. A machine that declares no project (a board-only host,
// which names no `primary`) is a note, not an error.
//
// THE READERS ARE LOADED LAZILY. `host-config.ts` and `project-config.ts` resolve a project declaration when they are imported, and a ticket-only
// machine has none. So they are imported only where the host file is not shaped as a ticket-only one. A project that cannot be resolved on any other
// machine is a refusal of the project section, never the note of a machine that declares none.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA, type ChoicePart } from "./config-schema.ts";
import { pluginStates } from "./plugins.ts";
import { ticketFolder } from "./ticket-paths.ts";
import { HOST_FILE_ENV, type TicketSettings } from "./settings.ts";
import { hostLevelRefusal, isTicketOnly, type Json, projectRefusal, refusalOf, ticketsRefusal } from "./settings-verdict.ts";
import { isObject } from "./json-value.ts";
import { settingsView, type Section, type View } from "./settings-view.ts";

/** The models and efforts the board offers, which a saved choice is held to. */
export const MODELS = ["opus", "sonnet", "haiku"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type SettingsReadOptions = Readonly<{
  /** The host file `AGENT_ORG_HOST` names, read now. */
  hostPath: string;
  /** The project's declaration, when it is not the one this process serves (a test's); else the declaration of `HOME_CHECKOUT`. */
  projectPath?: string;
  settings: TicketSettings;
  /** The queue file, and the number of workers the queue holds: its own `max`, else the one the board was made with. */
  queuePath: string;
  queueMax: number;
  choicePath: string;
  /** Claude Code's install record, when it is not the default one. */
  pluginRecord?: string;
  /** Loads `project-config.ts`: the default is the import. A test passes one that fails, to see the failure is shown and not hidden. */
  loadProject?: () => Promise<ProjectConfig>;
}>;

export type ProjectConfig = typeof import("../project-config.ts");
type Sections = Readonly<{ host: Section; tickets: Section; project: Section; notes: readonly string[]; hostWriter: Readonly<{ writerModel?: string; writerEffort?: string }>; hostRaw: Readonly<Record<string, unknown>> | null }>;

/** The note a machine that names no primary gets: it is a board-only machine, and not an error. */
const NO_PROJECT = "This machine declares no project: its host file names no primary, so no project.json is read.";

/** `project-config.ts`, loaded now. Its import resolves the project of this process, and a machine whose project cannot be resolved refuses here. */
const loadProjectConfigModule = (): Promise<ProjectConfig> => import("../project-config.ts");

/**
 * The path of the project declaration the Settings page reads and a save edits: `projectPath` when one is named (a test's), else the primary checkout's
 * `.agent-org/project.json`. Null when this machine declares no project, so there is no file to read or to edit. Throws when the project cannot be resolved.
 */
export async function projectPathOf(options: Pick<SettingsReadOptions, "projectPath" | "loadProject">, host: Json): Promise<string | null> {
  if (options.projectPath === undefined && isTicketOnly(host)) return null;
  const config = await (options.loadProject ?? loadProjectConfigModule)();
  if (options.projectPath === undefined && config.HOME_CHECKOUT === config.TICKET_ONLY_CHECKOUT) return null;
  return options.projectPath ?? join(config.HOME_CHECKOUT, config.PROJECT_DECLARATION_PATH);
}

/** The text of a file, or null when it cannot be read. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The parsed JSON object of `text`, or null when it is not one. */
function objectOf(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Where the number of workers comes from: the queue file when it names one, else the host file's `tickets.max`, else the built-in default. */
function maxSource(queuePath: string, host: Json): "queue.json" | "host.json" | "built-in default" {
  const queue = objectOf(readOrNull(queuePath));
  if (queue !== null && typeof queue.max === "number") return "queue.json";
  return isObject(host.tickets) && host.tickets.max !== undefined ? "host.json" : "built-in default";
}

/** The saved choice parts this board offers, each one only when the file names one it offers. */
function savedChoice(path: string): Partial<Record<ChoicePart, string>> {
  const saved = objectOf(readOrNull(path)) ?? {};
  const offered = (part: ChoicePart, allowed: readonly string[]) => (typeof saved[part] === "string" && allowed.includes(saved[part]) ? { [part]: saved[part] } : {});
  return { ...offered("model", MODELS), ...offered("effort", EFFORTS), ...offered("planModel", MODELS), ...offered("planEffort", EFFORTS), ...offered("writerModel", MODELS), ...offered("writerEffort", EFFORTS) };
}

/** The host file's top level, read by `parseHostConfig`, unless the file is a ticket-only one, which names no project to read it against. */
async function hostSection(text: string, hostPath: string, host: Json): Promise<Section> {
  return { file: "host.json", raw: host, refusal: await hostLevelRefusal(text, hostPath, host) };
}

/**
 * The project's declaration as `parseProjectDeclaration` reads it. The note that this machine declares no project is for a ticket-only host, and for a
 * process with no project checkout to read. Any other failure to resolve or read the project is a refusal of the project section, which says why.
 */
async function projectSection(options: SettingsReadOptions, host: Json): Promise<Readonly<{ section: Section; notes: readonly string[] }>> {
  let path: string | null;
  try {
    path = await projectPathOf(options, host);
  } catch (error) {
    return { section: { file: "project.json", raw: null, refusal: refusalOf(error) }, notes: [] };
  }
  if (path === null) return { section: { file: "project.json", raw: null, refusal: null }, notes: [NO_PROJECT] };
  return { section: await declarationOf(path), notes: [] };
}

/** A declaration read by `parseProjectDeclaration`, as its section: the file's own object, and its refusal when it names one. */
async function declarationOf(path: string): Promise<Section> {
  const text = readOrNull(path);
  if (text === null) return { file: "project.json", raw: null, refusal: `${path}: the declaration cannot be read` };
  return { file: "project.json", raw: objectOf(text), refusal: await projectRefusal(text, path) };
}

/** The host file's text and parsed object, or the refusal that says why it cannot be read. */
function hostFile(hostPath: string): { text: string; host: Json } | { refusal: string } {
  const text = readOrNull(hostPath);
  if (text === null) return { refusal: `ticket mode: \`${HOST_FILE_ENV}\` names ${hostPath}, which cannot be read` };
  const host = objectOf(text);
  if (host === null) return { refusal: `ticket mode: \`${HOST_FILE_ENV}\` names ${hostPath}, which is not valid JSON` };
  return { text, host };
}

/** The Settings page's view, read now from the files it describes. A refused file is a refusal in the view, and the rest of the view still draws. */
export async function readSettingsView(options: SettingsReadOptions): Promise<View> {
  const file = hostFile(options.hostPath);
  if ("refusal" in file) {
    const host: Section = { file: "host.json", raw: null, refusal: file.refusal };
    // The host file's refusal stands for the block too: with no file there are no ticket keys to draw.
    return viewOver(options, { host, tickets: { file: "host.json (tickets)", raw: null, refusal: null }, project: { file: "project.json", raw: null, refusal: null }, notes: [], hostWriter: {}, hostRaw: null });
  }
  const project = await projectSection(options, file.host);
  return viewOver(options, { host: await hostSection(file.text, options.hostPath, file.host), tickets: ticketsSection(file.host), project: project.section, notes: project.notes,
    hostWriter: writerOfHost(file.host), hostRaw: file.host });
}

/** The view over what was read: the sections, the choice saved, the number of workers and its source, and the plugins the board runs with. */
function viewOver(options: SettingsReadOptions, sections: Sections): View {
  const pluginRecord = options.pluginRecord === undefined ? {} : { record: options.pluginRecord };
  return settingsView({
    entries: SCHEMA,
    host: sections.host,
    tickets: sections.tickets,
    project: sections.project,
    notes: sections.notes,
    choice: { saved: savedChoice(options.choicePath), host: sections.hostWriter },
    queue: { max: options.queueMax, source: maxSource(options.queuePath, sections.hostRaw ?? {}) },
    plugins: pluginStates(options.settings.plugins, ticketFolder(options.settings, "<ticket>"), pluginRecord),
    exists: existsSync,
  });
}

/** The `tickets` block, read by `parseTicketSettings`, with the block (or none) as its raw. */
function ticketsSection(host: Json): Section {
  const raw = isObject(host.tickets) ? host.tickets : {};
  return { file: "host.json (tickets)", raw, refusal: ticketsRefusal(host) };
}

/** The host file's writer model and effort, when its `tickets.writer` names them: what a choice made nowhere else falls back to. */
function writerOfHost(host: Json): Readonly<{ writerModel?: string; writerEffort?: string }> {
  const writer = isObject(host.tickets) && isObject(host.tickets.writer) ? host.tickets.writer : {};
  return {
    ...(typeof writer.model === "string" ? { writerModel: writer.model } : {}),
    ...(typeof writer.effort === "string" ? { writerEffort: writer.effort } : {}),
  };
}

