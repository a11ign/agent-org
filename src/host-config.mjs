// @ts-check
// #2620 (child 3f of #69): THE ONE READER OF THE MACHINE'S FACTS, `host.json` (ADR 0040, decision 3), and of the small `units`
// block the project's declaration adds for the tool's own unit files (decision 9).
//
// `agent-org` is becoming a project-agnostic tool. What a HOST knows and no repository can -- where a checkout is, where the
// `gh` account directories are, which workspaces act as the leads account -- was written into the tool's sources and unit files
// as absolute home-directory paths, and this module is where it now comes from. The three tool units and the routing wrapper are TEMPLATES
// (`packages/agent-org/host/*.in`, and `gh` under its own name; `@@name@@` placeholders) that `renderTemplate` fills from `templateValues`, and
// `host-units.mjs` compares and installs the RENDERED text, so what runs is still a file on disk and `host:check` still compares
// bytes (0039 item 6: the installed copy is the program).
//
// IT REFUSES, IT NEVER DEFAULTS, like `project-config.mjs` and for the same reason: a reader that answered a11ign's home
// directory when the file was absent would make "the tool names no a11ign host path" true of the SOURCE and false of the
// BEHAVIOUR. There is deliberately no `DEFAULT_*` constant here. The one thing that is not a value is WHERE the file is:
// `$AGENT_ORG_HOST`, else the file beside the project's declaration in the checkout this tool runs from. No unit sets that
// variable yet (rows 4 and 5 install it), and the running units are untouched.
//
// A LEAF, like `project-config.mjs`: `node:fs`, `node:path` and that module only.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH, SUPPORTED_SCHEMA } from "./project-config.mjs";

export const HOST_CONFIG_ENV = "AGENT_ORG_HOST";
/** Where the host's declaration is, relative to a checkout, when `$AGENT_ORG_HOST` does not say. */
export const HOST_DECLARATION_PATH = ".agent-org/host.json";
/** A template is this suffix on the shipped name; the rendered name is `<prefix><name>` without it. */
export const TEMPLATE_SUFFIX = ".in";

/**
 * @typedef {{ id: string, role: string }} LeadsWorkspace
 * @typedef {{ workers: string, leads: string, leadsHeader: string[], leadsWorkspaces: LeadsWorkspace[] }} GhDirectories
 * @typedef {{ id: string, checkout: string }} HostProject
 * @typedef {{ schema: number, home: string, binDir: string, primary: string, projects: HostProject[], gh: GhDirectories }} HostConfig
 * @typedef {{ prefix: string, boardReportWorkflow: string, own: string[] }} UnitsDeclaration
 */

/** A refusal that names the field, so a test can tell WHICH rule fired. */
export class HostConfigRefusal extends Error {
  /** @param {string} field @param {string} why @param {string} source @param {{ cause?: unknown }} [options] */
  constructor(field, why, source, options) {
    super(`${source}: \`${field}\` ${why}`, options);
    this.name = "HostConfigRefusal";
    this.field = field;
    this.source = source;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const describe = (value) => (value === null ? "null" : Array.isArray(value) ? "a list" : typeof value);

/** @param {Record<string, unknown>} from @param {string} name @param {string} at @param {string} source */
function requiredString(from, name, at, source) {
  const value = from[name];
  if (typeof value !== "string") {
    const why = Object.hasOwn(from, name) ? `it must be a string, not ${describe(value)}` : "it is missing";
    throw new HostConfigRefusal(`${at}${name}`, why, source);
  }
  return value;
}

/**
 * An ABSOLUTE path with no trailing slash, so `${path}/gh` is one spelling.
 * @param {Record<string, unknown>} from @param {string} name @param {string} at @param {string} source
 */
function requiredPath(from, name, at, source) {
  const value = requiredString(from, name, at, source);
  if (!isAbsolute(value) || (value.length > 1 && value.endsWith("/"))) {
    throw new HostConfigRefusal(`${at}${name}`, `it must be an absolute path with no trailing slash, not ${JSON.stringify(value)}`, source);
  }
  return value;
}

/** @param {Record<string, unknown>} from @param {string} name @param {string} at @param {string} source @returns {unknown[]} */
function requiredList(from, name, at, source) {
  const value = from[name];
  if (!Array.isArray(value)) {
    const why = Object.hasOwn(from, name) ? `it must be a list, not ${describe(value)}` : "it is missing";
    throw new HostConfigRefusal(`${at}${name}`, why, source);
  }
  return value;
}

/** @param {unknown} entry @param {string} at @param {string} source @returns {Record<string, unknown>} */
function requiredObject(entry, at, source) {
  if (!isObject(entry)) throw new HostConfigRefusal(at, `it must be an object, not ${describe(entry)}`, source);
  return entry;
}

/** @param {Record<string, unknown>} host @param {string} source @returns {HostProject[]} */
function readProjects(host, source) {
  const list = requiredList(host, "projects", "", source);
  if (list.length === 0) throw new HostConfigRefusal("projects", "it is empty; a host serves at least one project", source);
  const seen = new Set();
  return list.map((entry, index) => {
    const at = `projects[${index}].`;
    const project = requiredObject(entry, `projects[${index}]`, source);
    const id = requiredString(project, "id", at, source);
    if (id === "" || seen.has(id)) throw new HostConfigRefusal(`${at}id`, id === "" ? "it is empty" : `\`${id}\` is declared twice`, source);
    seen.add(id);
    return { id, checkout: requiredPath(project, "checkout", at, source) };
  });
}

/** @param {Record<string, unknown>} host @param {string} source @returns {GhDirectories} */
function readGh(host, source) {
  const gh = requiredObject(host.gh, "gh", source);
  const header = requiredList(gh, "leadsHeader", "gh.", source).map((line, index) => {
    if (typeof line !== "string") throw new HostConfigRefusal(`gh.leadsHeader[${index}]`, `it must be a string, not ${describe(line)}`, source);
    return line;
  });
  const workspaces = requiredList(gh, "leadsWorkspaces", "gh.", source).map((entry, index) => {
    const at = `gh.leadsWorkspaces[${index}].`;
    const workspace = requiredObject(entry, `gh.leadsWorkspaces[${index}]`, source);
    const id = requiredString(workspace, "id", at, source);
    if (!/^\S+$/.test(id)) throw new HostConfigRefusal(`${at}id`, `it must be one word, not ${JSON.stringify(id)}`, source);
    return { id, role: requiredString(workspace, "role", at, source) };
  });
  return {
    workers: requiredPath(gh, "workers", "gh.", source),
    leads: requiredPath(gh, "leads", "gh.", source),
    leadsHeader: header,
    leadsWorkspaces: workspaces,
  };
}

/**
 * Parse the host's declaration. PURE: no file is read, so a test drives every refusal with a string.
 * @param {string} text @param {string} [source] what to call it in a refusal
 * @returns {Readonly<HostConfig>}
 */
export function parseHostConfig(text, source = HOST_DECLARATION_PATH) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "it is not valid JSON", source, { cause });
  }
  const host = requiredObject(parsed, "(file)", source);
  if (host.schema !== SUPPORTED_SCHEMA) {
    throw new HostConfigRefusal("schema", `${JSON.stringify(host.schema)} is not a schema this reader knows (${SUPPORTED_SCHEMA})`, source);
  }
  const projects = readProjects(host, source);
  const primary = requiredString(host, "primary", "", source);
  if (!projects.some((project) => project.id === primary)) {
    throw new HostConfigRefusal("primary", `\`${primary}\` is not one of \`projects\``, source);
  }
  return Object.freeze({
    schema: SUPPORTED_SCHEMA,
    home: requiredPath(host, "home", "", source),
    binDir: requiredPath(host, "binDir", "", source),
    primary,
    projects,
    gh: readGh(host, source),
  });
}

/**
 * Where the host's declaration is: `$AGENT_ORG_HOST`, else the file in the checkout this tool runs from.
 * @param {{ env?: Record<string, string | undefined>, root?: string }} [where]
 */
export function hostConfigPath({ env = process.env, root = HOME_CHECKOUT } = {}) {
  const declared = env[HOST_CONFIG_ENV];
  return declared !== undefined && declared !== "" ? declared : join(root, HOST_DECLARATION_PATH);
}

/**
 * Read the host's declaration. An absent file is REFUSED naming the path.
 * @param {string} [path] @param {(path: string, encoding: "utf8") => string} [read]
 * @returns {Readonly<HostConfig>}
 */
export function readHostConfig(path = hostConfigPath(), read = readFileSync) {
  /** @type {string} */
  let text;
  try {
    text = read(path, "utf8");
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseHostConfig(text, path);
}

/** @type {Readonly<HostConfig> | undefined} */
let homeHost;

/** The host this tool is running on, read once. @returns {Readonly<HostConfig>} */
export function homeHostConfig() {
  homeHost ??= readHostConfig();
  return homeHost;
}

/**
 * The `units` block of a project's declaration: the prefix its unit names carry, the workflow the tool's board-report unit
 * dispatches, and `own` -- the unit files the PROJECT keeps in `.agent-org/units/` (decision 9's partition). Read HERE and not in `project-config.mjs` because this is the only reader of these two fields, and that module is
 * imported by 31 files that need neither.
 * @param {string} text @param {string} [source]
 * @returns {Readonly<UnitsDeclaration>}
 */
export function parseUnitsDeclaration(text, source = PROJECT_DECLARATION_PATH) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "it is not valid JSON", source, { cause });
  }
  const units = requiredObject(requiredObject(parsed, "(file)", source).units, "units", source);
  const prefix = requiredString(units, "prefix", "units.", source);
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new HostConfigRefusal("units.prefix", `it must be a non-empty unit-name prefix, not ${JSON.stringify(prefix)}`, source);
  }
  const boardReportWorkflow = requiredString(units, "boardReportWorkflow", "units.", source);
  if (boardReportWorkflow === "") throw new HostConfigRefusal("units.boardReportWorkflow", "it is empty", source);
  const own = requiredList(units, "own", "units.", source).map((name, index) => {
    if (typeof name !== "string" || !/\.(service|timer)$/.test(name)) {
      throw new HostConfigRefusal(`units.own[${index}]`, `it must be the file name of a .service or .timer, not ${JSON.stringify(name)}`, source);
    }
    return name;
  });
  return Object.freeze({ prefix, boardReportWorkflow, own });
}

/**
 * @param {string} [root] the project's checkout @param {(path: string, encoding: "utf8") => string} [read]
 * @returns {Readonly<UnitsDeclaration>}
 */
export function readUnitsDeclaration(root = HOME_CHECKOUT, read = readFileSync) {
  const path = join(root, PROJECT_DECLARATION_PATH);
  /** @type {string} */
  let text;
  try {
    text = read(path, "utf8");
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseUnitsDeclaration(text, path);
}

/**
 * The values a template's `@@name@@` placeholders are filled from. `checkout` is the PRIMARY project's, because every tool unit
 * runs in it (`WorkingDirectory=`), and `prefix` is the project's, because the project names the units it installs.
 * @param {HostConfig} host @param {UnitsDeclaration} units
 * @returns {Record<string, string>}
 */
export function templateValues(host, units) {
  const primary = host.projects.find((project) => project.id === host.primary);
  if (primary === undefined) throw new HostConfigRefusal("primary", `\`${host.primary}\` is not one of \`projects\``, HOST_DECLARATION_PATH);
  return {
    home: host.home,
    binDir: host.binDir,
    checkout: primary.checkout,
    workersDir: host.gh.workers,
    leadsDir: host.gh.leads,
    prefix: units.prefix,
  };
}

const PLACEHOLDER = /@@([A-Za-z0-9]+)@@/g;

/**
 * Fill a template. A placeholder the values do not carry is REFUSED, so a template that grew a new one before the reader did
 * fails here and never installs a unit that still says `@@checkout@@`.
 * @param {string} text @param {Record<string, string>} values @param {string} [source]
 */
export function renderTemplate(text, values, source = "template") {
  return text.replace(PLACEHOLDER, (_whole, name) => {
    if (!Object.hasOwn(values, name)) throw new HostConfigRefusal(`@@${name}@@`, "is a placeholder no value fills", source);
    return values[name];
  });
}

/**
 * The rendered name of a shipped unit template: `work-tick.service.in` under prefix `a11ign-` is `a11ign-work-tick.service`.
 * @param {string} shipped @param {string} prefix
 */
export function renderedName(shipped, prefix) {
  return `${prefix}${shipped.slice(0, -TEMPLATE_SUFFIX.length)}`;
}

/**
 * The text `~/leads/workspaces.txt` holds, from `gh.leadsWorkspaces` -- BYTE-IDENTICAL to the file the tool used to ship, since
 * `host:check` compares bytes and a different rendering would report the live host DIVERGED the day this landed. Each header
 * line is a comment, and each workspace is a comment naming its role above its id on a line BY ITSELF.
 * @param {HostConfig} host
 */
export function leadsWorkspacesText(host) {
  const header = host.gh.leadsHeader.map((line) => `# ${line}\n`).join("");
  const rows = host.gh.leadsWorkspaces.map(({ id, role }) => `# ${id} ${role}\n${id}\n`).join("");
  return header + rows;
}
