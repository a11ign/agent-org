// @ts-check
// #2620 (child 3f of #69): THE ONE READER OF THE MACHINE'S FACTS, `host.json` (ADR 0040, decision 3), and of the small `units`
// block the project's declaration adds for the tool's own unit files (decision 9).
//
// `agent-org` is becoming a project-agnostic tool. What a HOST knows and no repository can -- where a checkout is, where the
// `gh` account directories are, which workspaces act as the leads account -- was written into the tool's sources and unit files
// as absolute home-directory paths, and this module is where it now comes from. The three tool units and the routing wrapper are TEMPLATES
// (`packages/agent-org/host/*.in`, and `gh` under its own name; `@@name@@` placeholders) that `renderTemplate` fills from `templateValues`, and
// `host-units.ts` compares and installs the RENDERED text, so what runs is still a file on disk and `host:check` still compares
// bytes (0039 item 6: the installed copy is the program).
//
// IT REFUSES, IT NEVER DEFAULTS, like `project-config.ts` and for the same reason: a reader that answered a11ign's home
// directory when the file was absent would make "the tool names no a11ign host path" true of the SOURCE and false of the
// BEHAVIOUR. There is deliberately no `DEFAULT_*` constant here. The one thing that is not a value is WHERE the file is:
// `$AGENT_ORG_HOST`, else the file beside the project's declaration in the checkout this tool runs from. No unit sets that
// variable yet (rows 4 and 5 install it), and the running units are untouched.
//
// A LEAF, like `project-config.ts`: `node:fs`, `node:path` and that module only.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH, SUPPORTED_SCHEMA } from "./project-config.ts";
import { LATEST, isToolVersion } from "./lib/release-tag.mjs";

export const HOST_CONFIG_ENV = "AGENT_ORG_HOST";
/** Where the host's declaration is, relative to a checkout, when `$AGENT_ORG_HOST` does not say. */
export const HOST_DECLARATION_PATH = ".agent-org/host.json";
/**
 * SERVICES NO CLOCK STARTS (#3025): templates whose unit is a LONG-RUNNING `Type=simple` process, so `enable --now` on the SERVICE is the only thing
 * that runs it. Everything else `host-units.ts` asks "enabled? active?" of is a timer; these get the same two questions, and the same remedy.
 * Named here rather than read off an `[Install]` section because `work-tick.service` carries one too and is a oneshot its timer starts.
 */
export const LONG_RUNNING_TEMPLATES = Object.freeze(["chairman-listen.service.in", "otel-receiver.service.in"]);

/** A template is this suffix on the shipped name; the rendered name is `<prefix><name>` without it. */
export const TEMPLATE_SUFFIX = ".in";

export type LeadsWorkspace = { id: string, role: string };
export type GhDirectories = { workers: string, leads: string, leadsHeader: string[], leadsWorkspaces: LeadsWorkspace[] };
export type HostProject = { id: string, checkout: string };
/**
 * `tool`, `stateDir` and `clones` are ABSENT (the key is not there, never `undefined`) on a host that has not moved to decision 3's installed form, and a11ign's `host.json` is exactly that host until #2623 cuts over.
 * `triage` is the one key that `parseHostConfig` ALWAYS sets (a hand-built `HostConfig` in a test may leave it out, hence the `?`), `{ provider: "none" }` when the declaration has none, because "no triage" is a value the
 * wake path reads and not a question it asks of the shape (a later row routes on it; this one routes nothing).
 */
export type HostConfig = { schema: number, home: string, binDir: string, primary: string, projects: HostProject[], gh: GhDirectories, tool?: string, toolVersion?: string, stateDir?: string, clones?: Readonly<Record<string, string>>, triage?: Readonly<TriageDeclaration> };
export type TriageDeclaration = { provider: "none" } | { provider: "jev", keyPath: string, minConfidence: number };
export type UnitsDeclaration = { prefix: string, boardReportWorkflow: string, own: string[] };

/** A refusal that names the field, so a test can tell WHICH rule fired. */
export class HostConfigRefusal extends Error {
  field: string;
  source: string;
  /** @param {string} field @param {string} why @param {string} source @param {{ cause?: unknown }} [options] */
  constructor(field: string, why: string, source: string, options?: { cause?: unknown; }) {
    super(`${source}: \`${field}\` ${why}`, options);
    this.name = "HostConfigRefusal";
    this.field = field;
    this.source = source;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const describe = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "a list" : typeof value);

/** @param {Record<string, unknown>} from @param {string} name @param {string} at @param {string} source */
function requiredString(from: Record<string, unknown>, name: string, at: string, source: string) {
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
function requiredPath(from: Record<string, unknown>, name: string, at: string, source: string) {
  const value = requiredString(from, name, at, source);
  if (!isAbsolute(value) || (value.length > 1 && value.endsWith("/"))) {
    throw new HostConfigRefusal(`${at}${name}`, `it must be an absolute path with no trailing slash, not ${JSON.stringify(value)}`, source);
  }
  return value;
}

/**
 * A path that MAY be absent, and is refused like a required one when it is there: `null` or `""` is a mistake, not "absent".
 * @param {Record<string, unknown>} from @param {string} name @param {string} at @param {string} source @returns {string | undefined}
 */
function optionalPath(from: Record<string, unknown>, name: string, at: string, source: string): string | undefined {
  return Object.hasOwn(from, name) ? requiredPath(from, name, at, source) : undefined;
}

/** @param {Record<string, unknown>} from @param {string} name @param {string} at @param {string} source @returns {unknown[]} */
function requiredList(from: Record<string, unknown>, name: string, at: string, source: string): unknown[] {
  const value = from[name];
  if (!Array.isArray(value)) {
    const why = Object.hasOwn(from, name) ? `it must be a list, not ${describe(value)}` : "it is missing";
    throw new HostConfigRefusal(`${at}${name}`, why, source);
  }
  return value;
}

/** @param {unknown} entry @param {string} at @param {string} source @returns {Record<string, unknown>} */
function requiredObject(entry: unknown, at: string, source: string): Record<string, unknown> {
  if (!isObject(entry)) throw new HostConfigRefusal(at, `it must be an object, not ${describe(entry)}`, source);
  return entry;
}

/** @param {Record<string, unknown>} host @param {string} source @returns {HostProject[]} */
function readProjects(host: Record<string, unknown>, source: string): HostProject[] {
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
function readGh(host: Record<string, unknown>, source: string): GhDirectories {
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
 * `clones` (#2969, read here by #2991 so `host.json` has one reader): where the clone of each KEYED code repository lives, by key. A
 * clone is a machine fact no repository can know, and it is not a `projects` entry. ABSENT is a host with no keyed repository; a
 * declared one is refused like any path, so a relative clone never reaches a `git -C`.
 * @param {Record<string, unknown>} host @param {string} source @returns {Readonly<Record<string, string>> | undefined}
 */
function readClones(host: Record<string, unknown>, source: string): Readonly<Record<string, string>> | undefined {
  if (!Object.hasOwn(host, "clones")) return undefined;
  const clones = requiredObject(host.clones, "clones", source);
  return Object.freeze(Object.fromEntries(Object.keys(clones).map((key) => [key, requiredPath(clones, key, "clones.", source)])));
}

/**
 * Parse the host's declaration. PURE: no file is read, so a test drives every refusal with a string.
 * @param {string} text @param {string} [source] what to call it in a refusal
 * @returns {Readonly<HostConfig>}
 */
export function parseHostConfig(text: string, source: string = HOST_DECLARATION_PATH): Readonly<HostConfig> {
  let parsed: unknown;
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
  const tool = optionalPath(host, "tool", "", source);
  const stateDir = optionalPath(host, "stateDir", "", source);
  const toolVersion = readToolVersion(host, tool, source);
  const clones = readClones(host, source);
  if (tool !== undefined) checkToolForm(tool, projects, source);
  return Object.freeze({
    schema: SUPPORTED_SCHEMA,
    home: requiredPath(host, "home", "", source),
    binDir: requiredPath(host, "binDir", "", source),
    primary,
    projects,
    gh: readGh(host, source),
    ...(tool === undefined ? {} : { tool, toolVersion }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(clones === undefined ? {} : { clones }),
    triage: readTriage(host, source),
  });
}

const NONE: Readonly<TriageDeclaration> = Object.freeze({ provider: "none" });

/** The providers `triage.provider` may name. `haiku` is refused by name below, not folded into "unknown", so the refusal says where it went. */
const TRIAGE_PROVIDERS: readonly string[] = Object.freeze(["jev", "none"]);
/** The confidence a `jev` provider needs before its label routes an order: the bar #4187 declared, used when `minConfidence` is left out. */
export const DEFAULT_TRIAGE_MIN_CONFIDENCE = 0.9;

/**
 * OPTIONAL JEV TRIAGE (#4384): who, if anybody, reads a wake order's cause and says wake, digest or drop. Absent is `{ provider: "none" }` and so is `"none"`, and
 * both are today's behaviour exactly. A `jev` provider names the file its key is in (`keyPath`, a path and never the key) and the floor under which its answer
 * is ignored. Refused by key name, like `toolVersion`: `haiku` (not built; row B's), any other provider, a `minConfidence` outside 0..1, a `keyPath` that is not a path.
 * @param {Record<string, unknown>} host @param {string} source @returns {Readonly<TriageDeclaration>}
 */
function readTriage(host: Record<string, unknown>, source: string): Readonly<TriageDeclaration> {
  if (!Object.hasOwn(host, "triage")) return NONE;
  const triage = requiredObject(host.triage, "triage", source);
  const provider = requiredString(triage, "provider", "triage.", source);
  if (provider === "haiku") {
    throw new HostConfigRefusal("triage.provider", "`haiku` is not built; the Haiku triage is row B's, if #4187 says it earns one", source);
  }
  if (!TRIAGE_PROVIDERS.includes(provider)) {
    throw new HostConfigRefusal("triage.provider", `it must be one of ${TRIAGE_PROVIDERS.join(", ")}, not ${JSON.stringify(provider)}`, source);
  }
  const keyPath = optionalPath(triage, "keyPath", "triage.", source);
  const minConfidence = readMinConfidence(triage, source);
  if (provider === "none") return NONE;
  if (keyPath === undefined) throw new HostConfigRefusal("triage.keyPath", "it is missing; a `jev` provider needs the file its key is in", source);
  return Object.freeze({ provider: "jev", keyPath, minConfidence });
}

/** @param {Record<string, unknown>} triage @param {string} source @returns {number} */
function readMinConfidence(triage: Record<string, unknown>, source: string): number {
  if (!Object.hasOwn(triage, "minConfidence")) return DEFAULT_TRIAGE_MIN_CONFIDENCE;
  const value = triage.minConfidence;
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    throw new HostConfigRefusal("triage.minConfidence", `it must be a number from 0 to 1, not ${JSON.stringify(value)}`, source);
  }
  return value;
}

/**
 * WHICH RELEASE THE TOOL'S CHECKOUT FOLLOWS (#3443): `"latest"` (the newest release tag, and the default) or one `vX.Y.Z`, which pins the host there -- the whole
 * of a rollback. Anything else is REFUSED by name, a branch (`main`) and a bare `0.7.8` and `""` included, because `update-tool` would otherwise have to decide what
 * they meant. Named without a `tool` it is refused too: there is no checkout for it to pin, so it would be a pin that quietly pinned nothing.
 * @param {Record<string, unknown>} host @param {string | undefined} tool @param {string} source @returns {string}
 */
function readToolVersion(host: Record<string, unknown>, tool: string | undefined, source: string): string {
  if (!Object.hasOwn(host, "toolVersion")) return LATEST;
  if (tool === undefined) throw new HostConfigRefusal("toolVersion", "it pins the tool's checkout, and this host names no `tool`", source);
  if (!isToolVersion(host.toolVersion)) {
    throw new HostConfigRefusal("toolVersion", `it must be "${LATEST}" or a release tag like "v0.7.8", not ${JSON.stringify(host.toolVersion)}`, source);
  }
  return (host.toolVersion as string);
}

/** A path a unit line can carry as one argument: nothing systemd splits on, expands (`%`, `$`) or unquotes. */
const UNIT_SAFE_PATH = /^[A-Za-z0-9_./@+:=,-]+$/;

/**
 * WHAT DECISION 3'S INSTALLED FORM NEEDS OF THE PATHS, checked at the declaration and before any unit is rendered. The tool is "never
 * run from inside a product checkout": a `tool` that is a project's checkout, or under one, would have `update-tool` detach that
 * checkout at the tool's `main`, the one thing "never touches a project's checkout" forbids. And the tool's path and every checkout
 * are written into `WorkingDirectory=` and `ExecStartPre=` lines, where a space or a `%` would change what runs.
 * @param {string} tool @param {HostProject[]} projects @param {string} source
 */
function checkToolForm(tool: string, projects: HostProject[], source: string) {
  if (!UNIT_SAFE_PATH.test(tool)) throw new HostConfigRefusal("tool", `it is written into unit lines, so it may not hold a space or a systemd specifier, not ${JSON.stringify(tool)}`, source);
  projects.forEach(({ id, checkout }, index) => {
    if (!UNIT_SAFE_PATH.test(checkout)) throw new HostConfigRefusal(`projects[${index}].checkout`, `it is written into a unit line once \`tool\` is set, so it may not hold a space or a systemd specifier, not ${JSON.stringify(checkout)}`, source);
    if (tool === checkout || tool.startsWith(`${checkout}/`)) {
      throw new HostConfigRefusal("tool", `it is inside the checkout of project \`${id}\` (${checkout}); the tool is installed beside the projects it serves, never in one`, source);
    }
  });
}

/**
 * Where the host's declaration is: `$AGENT_ORG_HOST`, else the file in the checkout this tool runs from.
 * @param {{ env?: Record<string, string | undefined>, root?: string }} [where]
 */
export function hostConfigPath({ env = process.env, root = HOME_CHECKOUT }: { env?: Record<string, string | undefined>; root?: string; } = {}) {
  const declared = env[HOST_CONFIG_ENV];
  return declared !== undefined && declared !== "" ? declared : join(root, HOST_DECLARATION_PATH);
}

/**
 * Read the host's declaration. An absent file is REFUSED naming the path.
 * @param {string} [path] @param {(path: string, encoding: "utf8") => string} [read]
 * @returns {Readonly<HostConfig>}
 */
export function readHostConfig(path: string = hostConfigPath(), read: (path: string, encoding: "utf8") => string = readFileSync): Readonly<HostConfig> {
  let text: string;
  try {
    text = read(path, "utf8");
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseHostConfig(text, path);
}

let homeHost: Readonly<HostConfig> | undefined;

/** The host this tool is running on, read once. @returns {Readonly<HostConfig>} */
export function homeHostConfig(): Readonly<HostConfig> {
  homeHost ??= readHostConfig();
  return homeHost;
}

/**
 * The `units` block of a project's declaration: the prefix its unit names carry, the workflow the tool's board-report unit
 * dispatches, and `own` -- the unit files the PROJECT keeps in `.agent-org/units/` (decision 9's partition). Read HERE and not in `project-config.ts` because this is the only reader of these two fields, and that module is
 * imported by 31 files that need neither.
 * @param {string} text @param {string} [source]
 * @returns {Readonly<UnitsDeclaration>}
 */
export function parseUnitsDeclaration(text: string, source: string = PROJECT_DECLARATION_PATH): Readonly<UnitsDeclaration> {
  let parsed: unknown;
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
export function readUnitsDeclaration(root: string = HOME_CHECKOUT, read: (path: string, encoding: "utf8") => string = readFileSync): Readonly<UnitsDeclaration> {
  const path = join(root, PROJECT_DECLARATION_PATH);
  let text: string;
  try {
    text = read(path, "utf8");
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseUnitsDeclaration(text, path);
}

/**
 * A `beforeTick` is what systemd will run as one `ExecStartPre=` argument vector, so it is a COMMAND and not a shell line: the characters
 * systemd itself reinterprets (`%` specifiers, `$` expansion, `;` command separators, `\` and quotes) and the ones that only a shell
 * would honour (`|&<>` and a backtick) are REFUSED, because a line that looks like a pipeline and runs as arguments to its first word is
 * a defect that fails silently at 2 a.m.
 */
const NOT_A_COMMAND = /[\n\r%$;\\"'`|&<>]/;

/**
 * The command a project asks the host to run before each tick, from its declaration -- `pnpm run primary:update` for a11ign, so its
 * primary keeps moving now the tool no longer lives in it (ADR 0040, decision 3). ABSENT reads as `null` (a project may need none),
 * and a present value that is not a command is refused naming the field. PURE: the text is handed in.
 * @param {string} text @param {string} [source] @returns {string | null}
 */
export function parseBeforeTick(text: string, source: string = PROJECT_DECLARATION_PATH): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "it is not valid JSON", source, { cause });
  }
  const declaration = requiredObject(parsed, "(file)", source);
  if (!Object.hasOwn(declaration, "beforeTick")) return null;
  const command = requiredString(declaration, "beforeTick", "", source);
  if (command.trim() !== command || command === "" || NOT_A_COMMAND.test(command)) {
    throw new HostConfigRefusal("beforeTick", `it must be one command with no shell syntax and no systemd specifier, not ${JSON.stringify(command)}`, source);
  }
  return command;
}

/**
 * @param {string} checkout the project's checkout @param {(path: string, encoding: "utf8") => string} [read]
 * @returns {string | null}
 */
export function readBeforeTick(checkout: string, read: (path: string, encoding: "utf8") => string = readFileSync): string | null {
  const path = join(checkout, PROJECT_DECLARATION_PATH);
  let text: string;
  try {
    text = read(path, "utf8");
  } catch (cause) {
    throw new HostConfigRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseBeforeTick(text, path);
}

/**
 * Where one of the org's state entries lives on THIS host: under `host.json`'s `stateDir`. REFUSED when the host declares none, and
 * never answered with `~/.cache/a11ign` -- the directory a11ign's host uses is a value of its `host.json`, not a fact of the tool.
 * @param {HostConfig} host @param {string} name a file name in the state directory, as `wake.ts` and `work-gate.ts` spell it
 */
export function stateFilePath(host: HostConfig, name: string) {
  if (host.stateDir === undefined) throw new HostConfigRefusal("stateDir", "it is missing; the host declares no state directory", HOST_DECLARATION_PATH);
  return join(host.stateDir, name);
}

/**
 * The state directory of a host whose `host.json` declares no `stateDir`: the one the running unit has always used (#2799, child 5c of
 * #2623). It is the DOCUMENTED DEFAULT and the only spelling of it -- `stateFilePath` refuses without a `stateDir`, so the four readers
 * that predate it (the drain marker, the reviewer state, the shadow gate's live directory, the wake ledger) reach it through
 * `stateEntryPath`, which is the difference between "a host that says nothing keeps working" and "a host that says something is read".
 */
const UNDECLARED_STATE_DIR = ".cache/a11ign";

/**
 * Handed by the shadow-window runner (#2846) to the CANDIDATE gate it runs, naming the COPY of the state directory that candidate may read
 * (`decide(args)` has no state-directory parameter, so an environment variable is the only way to give it one). The runner makes that
 * directory and writes `SHADOW_COPY_MARKER` into it last.
 */
export const SHADOW_STATE_DIR_ENV = "A11IGN_SHADOW_STATE_DIR";
export const SHADOW_COPY_MARKER = ".shadow-copy";

/**
 * The directory `$A11IGN_SHADOW_STATE_DIR` names, or `undefined` when it is unset (today's behaviour, byte for byte). SET AND UNUSABLE REFUSES,
 * naming the path, and never falls back: a variable that leaked into the LIVE tick's environment would otherwise point the drain marker and the
 * reviewer state at somewhere else, and the tick would go on running as though nothing had moved. A directory counts as usable only when the
 * runner made it (`SHADOW_COPY_MARKER`), which is also what the runner demands before it empties one.
 * @param {Record<string, string | undefined>} env
 */
function shadowStateDir(env: Record<string, string | undefined>) {
  const dir = env[SHADOW_STATE_DIR_ENV];
  if (dir === undefined) return undefined;
  if (!isAbsolute(dir)) throw new HostConfigRefusal(SHADOW_STATE_DIR_ENV, `it must be an absolute path, not ${JSON.stringify(dir)}`, "the environment");
  if (!existsSync(join(dir, SHADOW_COPY_MARKER))) {
    throw new HostConfigRefusal(SHADOW_STATE_DIR_ENV, `${dir} has no ${SHADOW_COPY_MARKER}, so the shadow-window runner did not make it; only a copy it made may stand in for the state directory`, "the environment");
  }
  return dir;
}

/**
 * Where one state entry lives on THIS host for a reader that ran before `stateDir` existed. A host that declares a `stateDir` gets
 * `stateFilePath`'s answer; a host that declares none gets `${HOME}/.cache/a11ign`, BYTE-IDENTICAL to the string those readers spelled,
 * so the running unit is unchanged until its `host.json` says otherwise (#2623's cut-over). `name` is `""` for the directory itself.
 * UNDER `$A11IGN_SHADOW_STATE_DIR` (the candidate gate, #2623 done-when 6) the answer is the runner's COPY, ahead of both, and `host.json` is not read.
 * @param {string} name @param {{ host?: HostConfig, home?: string | undefined, env?: Record<string, string | undefined> }} [where]
 */
export function stateEntryPath(name: string, { host, home = process.env.HOME, env = process.env }: { host?: HostConfig; home?: string | undefined; env?: Record<string, string | undefined>; } = {}) {
  const copy = shadowStateDir(env);
  if (copy !== undefined) return name === "" ? copy : join(copy, name);
  const declared = host ?? homeHostConfig();
  if (declared.stateDir !== undefined) return name === "" ? declared.stateDir : stateFilePath(declared, name);
  return name === "" ? `${home}/${UNDECLARED_STATE_DIR}` : `${home}/${UNDECLARED_STATE_DIR}/${name}`;
}

/**
 * The values a template's `@@name@@` placeholders are filled from. `checkout` is the PRIMARY project's, because every tool unit
 * runs in it (`WorkingDirectory=`), and `prefix` is the project's, because the project names the units it installs.
 * @param {HostConfig} host @param {UnitsDeclaration} units
 * @returns {Record<string, string>}
 */
export function templateValues(host: HostConfig, units: UnitsDeclaration): Record<string, string> {
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
export function renderTemplate(text: string, values: Record<string, string>, source: string = "template") {
  return text.replace(PLACEHOLDER, (_whole, name) => {
    if (!Object.hasOwn(values, name)) throw new HostConfigRefusal(`@@${name}@@`, "is a placeholder no value fills", source);
    return values[name];
  });
}

/**
 * The rendered name of a shipped unit template: `work-tick.service.in` under prefix `a11ign-` is `a11ign-work-tick.service`.
 * @param {string} shipped @param {string} prefix
 */
export function renderedName(shipped: string, prefix: string) {
  return `${prefix}${shipped.slice(0, -TEMPLATE_SUFFIX.length)}`;
}

/**
 * The text `~/leads/workspaces.txt` holds, from `gh.leadsWorkspaces` -- BYTE-IDENTICAL to the file the tool used to ship, since
 * `host:check` compares bytes and a different rendering would report the live host DIVERGED the day this landed. Each header
 * line is a comment, and each workspace is a comment naming its role above its id on a line BY ITSELF.
 * @param {HostConfig} host
 */
export function leadsWorkspacesText(host: HostConfig) {
  const header = host.gh.leadsHeader.map((line) => `# ${line}\n`).join("");
  const rows = host.gh.leadsWorkspaces.map(({ id, role }) => `# ${id} ${role}\n${id}\n`).join("");
  return header + rows;
}
