// @ts-check
// #2616 (child 3a of #69): THE ONE READER OF A PROJECT'S DECLARATION, `.agent-org/project.json` (ADR 0040, decisions 1 and 2).
//
// `agent-org` is becoming a project-agnostic tool and a11ign its first configured project. Everything a11ign-specific the
// machinery knew is moving into that one file, and this module is the only thing that reads it. This row moves the two
// values every other surface hangs on -- which repository, which board -- and nothing else.
//
// IT REFUSES, IT NEVER DEFAULTS. A missing declaration, a missing or mistyped field, an unknown `schema`, two entries with
// one key, and a key ending in `-<digits>` are each REFUSED, and the refusal NAMES THE FIELD (`.field`, and in the
// message). A reader that answered a11ign's repository when the file was absent would make "project-agnostic" decorative:
// the tool would serve the wrong project without an error, which is the failure a defaulting guard has everywhere in
// this tree. There is deliberately no `DEFAULT_*` constant in this file and none may be added.
//
// WHY THE KEY RULES ARE HERE AND NOT LATER. A name is `<role>-<key>-<n>` for a non-empty key and `<role>-<n>` for the empty
// one (decision 2), so the key must never end in `-<digits>` or `reviewer-agent-org-12` would parse two ways. Refusing it
// at the one place a key enters is what lets every later reader trust one.
//
// The module imports only `node:fs` and `node:path`: `scripts/repo-identity.mjs` imports it, and it in turn is imported by 31
// files of this package, so anything heavier here is paid by every one of them (`api-pool.ts` says why that matters).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";

export const PROJECT_DECLARATION_PATH = ".agent-org/project.json";
/** The only `schema` this reader understands. An unknown one REFUSES: it is the one version coupling (ADR 0040, decision 3). */
export const SUPPORTED_SCHEMA = 1;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEY_PATTERN = /^[a-z0-9-]*$/;
const ENDS_IN_DIGITS = /-\d+$/;

export type CodeRepository = { key: string, repo: string };
export type Tracker = { key: string, repo: string, board: { owner: string, number: number } };
/**
 * one thing this project's public prose must never carry: the name a refusal quotes, and a regular expression's SOURCE (no slashes, no flags)
 */
export type LeakPattern = { name: string, pattern: string };
/**
 * where a repository's releases are read: a published npm version (the registry's `time` map), or a `v*` tag with a GitHub Release
 */
export type DoraRelease = { kind: "npm", package: string } | { kind: "tag" };
/**
 * one repository the daily DORA reading covers (`dora.ts`). `adopterFacing` (#4378) is `false` for a repository whose releasable change reaches no outside adopter (the org's own
 * tooling): the PRIMARY milestone's rule reads it, and nothing else does. ABSENT means `true` and is not filled in, so a declaration that never names it reads exactly as before.
 * `adopterDocs` (a11ign/a11ign#4084) lists path prefixes an outside adopter READS but that ship no code (`README.md`, `docs/try-it.md`): they count as adopter-facing for the PRIMARY milestone and for
 * nothing else. It is NOT a second `releasablePaths`: the releasable-change decision (`dora.ts`, `release-behind-main.ts`) and the 60% product share never read it. ABSENT stays absent.
 */
export type DoraRepository = { repo: string, release: DoraRelease, releasablePaths: string[], adopterFacing?: boolean, adopterDocs?: string[] };
/**
 * #4904: THE ENGINEER ROUTES, cheapest first, as `<model>/<effort>`. The ROUTER (`engineer-route.ts`) owns what each one starts; this list is what a declaration may NAME, so a typo is
 * refused at load rather than found as a route nothing can build. It lives here because the reader is a leaf and the router imports it, never the other way.
 */
export const ROUTES = Object.freeze(["haiku/high", "sonnet/medium", "sonnet/high"] as const);
export type RouteName = (typeof ROUTES)[number];
/** The two routes the deterministic fallback (the Region's file count) can take. A declaration that leaves either out has a fallback that cannot be taken, and is refused. */
export const FALLBACK_ROUTES: readonly RouteName[] = Object.freeze(["sonnet/medium", "sonnet/high"]);
/** What the router tells the provider about one route (TypeSafe's Choice option: `what`, `not_for`, signals and examples). Strings only: the router adds the structure. */
export type RouteGuidance = { what: string, signals: string[], notFor: string, examples: string[] };
/** `choice` asks the provider ONE question whose options are the routes; `traits` asks the four questions and composes them (today's rule). */
export type RoutingQuestion = "choice" | "traits";
export type RoutingDeclaration = {
  question: RoutingQuestion,
  routes: RouteName[],
  /** Guidance this project WRITES for a route; a route with none uses the router's own. */
  guidance: Partial<Record<RouteName, RouteGuidance>>,
  /** A pick CHEAPER than the fallback stands at this probability or more... */
  cheaperMinP: number,
  /** ...and one DEARER than the fallback needs this one. A cheap pick is the cheaper one to be wrong about, because a wrong Haiku start moves up one rung (#4630). */
  dearerMinP: number,
  /** The P a Sonnet pick must reach to veto Haiku on a Tests-first row (a11ign#5110). Read between 0.5 and 0.99: under 0.5 the veto is the default, and above 0.99 it is one in name only. */
  sonnetVetoMinP: number,
};
/** What an ABSENT `routing` block reads as (#4904): every route, the four questions composed by hand thresholds, and the chairman's two acceptance thresholds for when `choice` is set. */
export const ABSENT_ROUTING: Readonly<RoutingDeclaration> = Object.freeze({ question: "traits", routes: [...ROUTES], guidance: {}, cheaperMinP: 0.5, dearerMinP: 0.7, sonnetVetoMinP: 0.7 });
export type ProjectDeclaration = { schema: number, tracker: Tracker[], code: CodeRepository[], leakPatterns: LeakPattern[], dora: DoraRepository[], offerMilestones: string[], routing: RoutingDeclaration, repo: string, boardOwner: string, boardNumber: number };

/** A refusal that carries the field it is about, so a caller (and a test) can tell WHICH rule fired and not merely that one did. */
export class ProjectDeclarationRefusal extends Error {
  field: string;
  /** @param {string} field @param {string} reason @param {string} source @param {{ cause?: unknown }} [options] */
  constructor(field: string, reason: string, source: string, options?: { cause?: unknown; }) {
    super(`${source}: field \`${field}\` REFUSED: ${reason}. Nothing is defaulted to another project's value.`, options);
    this.name = "ProjectDeclarationRefusal";
    this.field = field;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {Record<string, unknown>} holder @param {string} name @param {string} path @param {string} source
 * @returns {unknown}
 */
function requiredField(holder: Record<string, unknown>, name: string, path: string, source: string): unknown {
  if (!Object.hasOwn(holder, name)) throw new ProjectDeclarationRefusal(`${path}${name}`, "it is missing", source);
  return holder[name];
}

/** @param {Record<string, unknown>} holder @param {string} name @param {string} path @param {string} source */
function requiredString(holder: Record<string, unknown>, name: string, path: string, source: string) {
  const value = requiredField(holder, name, path, source);
  if (typeof value !== "string") {
    throw new ProjectDeclarationRefusal(`${path}${name}`, `it must be a string, not ${describe(value)}`, source);
  }
  return value;
}

/** @param {unknown} value */
const describe = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`);

/** @param {string} field @param {string} repo @param {string} source */
function checkRepo(field: string, repo: string, source: string) {
  if (!REPO_PATTERN.test(repo)) throw new ProjectDeclarationRefusal(field, `\`${repo}\` is not \`owner/name\``, source);
}

/** @param {string} field @param {string} key @param {string} source */
function checkKey(field: string, key: string, source: string) {
  if (!KEY_PATTERN.test(key)) {
    throw new ProjectDeclarationRefusal(field, `key \`${key}\` must be [a-z0-9-] or empty`, source);
  }
  // A name is `<role>-<key>-<n>`: a key ending in `-<digits>` would let one name parse two ways (decision 2).
  if (ENDS_IN_DIGITS.test(key)) {
    throw new ProjectDeclarationRefusal(field, `key \`${key}\` ends in -<digits>, so a name built from it would parse two ways`, source);
  }
}

/**
 * The entries of one list, each read by `readEntry`, with every key checked and unique WITHIN the list. (A tracker and a
 * code repository may share a key -- a11ign's are both empty -- because they are different lists of different things.)
 * @template T
 * @param {Record<string, unknown>} declaration @param {string} listName @param {string} source
 * @param {(entry: Record<string, unknown>, at: string) => T & { key: string }} readEntry
 * @returns {Array<T & { key: string }>}
 */
function readList<T>(declaration: Record<string, unknown>, listName: string, source: string, readEntry: (entry: Record<string, unknown>, at: string) => T & { key: string; }): Array<T & { key: string; }> {
  const list = requiredField(declaration, listName, "", source);
  if (!Array.isArray(list)) throw new ProjectDeclarationRefusal(listName, `it must be a list, not ${describe(list)}`, source);
  if (list.length === 0) throw new ProjectDeclarationRefusal(listName, "it is empty; a project has at least one", source);
  const seen: Set<string> = new Set();
  return list.map((entry, index) => {
    const at = `${listName}[${index}]`;
    if (!isObject(entry)) throw new ProjectDeclarationRefusal(at, `it must be an object, not ${describe(entry)}`, source);
    const read = readEntry(entry, at);
    checkKey(`${at}.key`, read.key, source);
    if (seen.has(read.key)) {
      const which = read.key === "" ? "the EMPTY key is declared twice" : `key \`${read.key}\` is declared twice`;
      throw new ProjectDeclarationRefusal(`${at}.key`, `${which} in \`${listName}\``, source);
    }
    seen.add(read.key);
    return read;
  });
}

/** @param {Record<string, unknown>} entry @param {string} at @param {string} source */
function readCode(entry: Record<string, unknown>, at: string, source: string) {
  const key = requiredString(entry, "key", `${at}.`, source);
  const repo = requiredString(entry, "repo", `${at}.`, source);
  checkRepo(`${at}.repo`, repo, source);
  return { key, repo };
}

/** @param {Record<string, unknown>} entry @param {string} at @param {string} source */
function readTracker(entry: Record<string, unknown>, at: string, source: string) {
  const { key, repo } = readCode(entry, at, source);
  const board = requiredField(entry, "board", `${at}.`, source);
  if (!isObject(board)) throw new ProjectDeclarationRefusal(`${at}.board`, `it must be an object, not ${describe(board)}`, source);
  const owner = requiredString(board, "owner", `${at}.board.`, source);
  if (owner === "") throw new ProjectDeclarationRefusal(`${at}.board.owner`, "it is empty", source);
  const number = requiredField(board, "number", `${at}.board.`, source);
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new ProjectDeclarationRefusal(`${at}.board.number`, `it must be a positive integer, not ${JSON.stringify(number)}`, source);
  }
  return { key, repo, board: { owner, number } };
}

/**
 * The project's OWN leak patterns (#2658, child 3g): what its tracked prose and its tracker bodies must never carry, ON TOP OF the two the
 * tool holds itself (`lib/leak-patterns.ts`: a private LAN address, a named SSH key file). A declaration that names none is a project
 * with none of its own, so an ABSENT field reads as an empty list -- and that is the one field here that does, because it adds to a floor the
 * tool already enforces rather than answering a question about WHICH project this is. A present field is held to the same rule as every
 * other: each entry needs a non-empty `name` and a `pattern` that compiles, and it is REFUSED naming the entry when it does not.
 * @param {Record<string, unknown>} declaration @param {string} source
 * @returns {LeakPattern[]}
 */
function readLeakPatterns(declaration: Record<string, unknown>, source: string): LeakPattern[] {
  if (!Object.hasOwn(declaration, "leakPatterns")) return [];
  const list = declaration.leakPatterns;
  if (!Array.isArray(list)) throw new ProjectDeclarationRefusal("leakPatterns", `it must be a list, not ${describe(list)}`, source);
  return list.map((entry, index) => {
    const at = `leakPatterns[${index}]`;
    if (!isObject(entry)) throw new ProjectDeclarationRefusal(at, `it must be an object, not ${describe(entry)}`, source);
    const name = requiredString(entry, "name", `${at}.`, source);
    if (name === "") throw new ProjectDeclarationRefusal(`${at}.name`, "it is empty", source);
    const pattern = requiredString(entry, "pattern", `${at}.`, source);
    try {
      new RegExp(pattern);
    } catch (cause) {
      throw new ProjectDeclarationRefusal(`${at}.pattern`, "it is not a regular expression", source, { cause });
    }
    return { name, pattern };
  });
}

/** @param {Record<string, unknown>} entry @param {string} at @param {string} source @returns {DoraRelease} */
function readDoraRelease(entry: Record<string, unknown>, at: string, source: string): DoraRelease {
  const release = requiredField(entry, "release", `${at}.`, source);
  if (!isObject(release)) throw new ProjectDeclarationRefusal(`${at}.release`, `it must be an object, not ${describe(release)}`, source);
  const kind = requiredString(release, "kind", `${at}.release.`, source);
  if (kind === "tag") return { kind };
  if (kind !== "npm") throw new ProjectDeclarationRefusal(`${at}.release.kind`, `\`${kind}\` is not \`npm\` or \`tag\``, source);
  const name = requiredString(release, "package", `${at}.release.`, source);
  if (name === "") throw new ProjectDeclarationRefusal(`${at}.release.package`, "it is empty", source);
  return { kind, package: name };
}

/** @param {Record<string, unknown>} entry @param {string} at @param {string} source @returns {string[]} */
function readReleasablePaths(entry: Record<string, unknown>, at: string, source: string): string[] {
  const paths = requiredField(entry, "releasablePaths", `${at}.`, source);
  const isMalformedPaths = !Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path === "");
  if (isMalformedPaths) {
    throw new ProjectDeclarationRefusal(`${at}.releasablePaths`, "it must be a non-empty list of path prefixes (a pull request touching none of them is not a releasable change)", source);
  }
  return paths;
}

/**
 * #4378: `adopterFacing` when the entry names it, which must be a boolean: a string `"false"` is refused rather than read as truthy, since the key exists to take a repository OUT of a count.
 * @param {Record<string, unknown>} entry @param {string} at @param {string} source @returns {{ adopterFacing?: boolean }}
 */
function readAdopterFacing(entry: Record<string, unknown>, at: string, source: string): { adopterFacing?: boolean; } {
  if (!Object.hasOwn(entry, "adopterFacing")) return {};
  const value = entry.adopterFacing;
  if (typeof value !== "boolean") throw new ProjectDeclarationRefusal(`${at}.adopterFacing`, `it must be true or false, not ${describe(value)}`, source);
  return { adopterFacing: value };
}

/**
 * a11ign/a11ign#4084: `adopterDocs` when the entry names it: a non-empty list of non-empty path prefixes, refused on an entry declared `adopterFacing: false` (a tooling repository's documents reach no
 * outside adopter, so naming them is a contradiction and not an override). Absent stays absent, so nothing that does not name it changes.
 * @param {Record<string, unknown>} entry @param {string} at @param {string} source @returns {{ adopterDocs?: string[] }}
 */
function readAdopterDocs(entry: Record<string, unknown>, at: string, source: string): { adopterDocs?: string[]; } {
  if (!Object.hasOwn(entry, "adopterDocs")) return {};
  const paths = entry.adopterDocs;
  const isMalformedPaths = !Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path === "");
  if (isMalformedPaths) {
    throw new ProjectDeclarationRefusal(`${at}.adopterDocs`, "it must be a non-empty list of path prefixes an outside adopter reads", source);
  }
  if (entry.adopterFacing === false) {
    throw new ProjectDeclarationRefusal(`${at}.adopterDocs`, "the repository is declared `adopterFacing: false`, so its documents reach no outside adopter and cannot be declared as ones an adopter reads", source);
  }
  return { adopterDocs: paths };
}

/**
 * The repositories the daily DORA reading covers (`dora.ts`), and where each one's releases are read. `agent-org` names no project, so which
 * repositories and where is DECLARED here. An ABSENT field reads as an empty list, for the reason `leakPatterns` does: it adds a report and answers
 * no question about WHICH project this is. A PRESENT entry is held to the same rule as every other, and a repository declared twice is refused.
 * @param {Record<string, unknown>} declaration @param {string} source
 * @returns {DoraRepository[]}
 */
function readDora(declaration: Record<string, unknown>, source: string): DoraRepository[] {
  if (!Object.hasOwn(declaration, "dora")) return [];
  const list = declaration.dora;
  if (!Array.isArray(list)) throw new ProjectDeclarationRefusal("dora", `it must be a list, not ${describe(list)}`, source);
  const seen: Set<string> = new Set();
  return list.map((entry, index) => {
    const at = `dora[${index}]`;
    if (!isObject(entry)) throw new ProjectDeclarationRefusal(at, `it must be an object, not ${describe(entry)}`, source);
    const repo = requiredString(entry, "repo", `${at}.`, source);
    checkRepo(`${at}.repo`, repo, source);
    if (seen.has(repo)) throw new ProjectDeclarationRefusal(`${at}.repo`, `\`${repo}\` is declared twice in \`dora\``, source);
    seen.add(repo);
    return { repo, release: readDoraRelease(entry, at, source), releasablePaths: readReleasablePaths(entry, at, source), ...readAdopterFacing(entry, at, source), ...readAdopterDocs(entry, at, source) };
  });
}

/**
 * #4524: THE CHAIRMAN'S MILESTONE RANKING for the gate's offer hierarchy, primary milestone first: each entry names a milestone by its number or its title
 * (a string either way, so a later tracker's project identifier fits the same list). An ABSENT field reads as an empty list, for the reason `leakPatterns` does: it
 * orders offers and answers no question about WHICH project this is, and with no ranking every row is in the same tier as before. A PRESENT field is held to the
 * rule of every other: a list of non-empty strings, none twice, since a milestone ranked twice has no single rank.
 * @param {Record<string, unknown>} declaration @param {string} source
 * @returns {string[]}
 */
function readOfferMilestones(declaration: Record<string, unknown>, source: string): string[] {
  if (!Object.hasOwn(declaration, "offerMilestones")) return [];
  const list = declaration.offerMilestones;
  if (!Array.isArray(list)) throw new ProjectDeclarationRefusal("offerMilestones", `it must be a list, not ${describe(list)}`, source);
  list.forEach((entry, index) => {
    if (typeof entry !== "string" || entry === "") throw new ProjectDeclarationRefusal(`offerMilestones[${index}]`, "it must be a non-empty string naming a milestone", source);
  });
  const repeated = list.find((entry, index) => list.indexOf(entry) !== index);
  if (repeated !== undefined) throw new ProjectDeclarationRefusal("offerMilestones", `\`${repeated}\` is ranked twice`, source);
  return list;
}

const ROUTING_KEYS = ["question", "routes", "guidance", "cheaperMinP", "dearerMinP", "sonnetVetoMinP"];
const isRoute = (value: unknown): value is RouteName => typeof value === "string" && (ROUTES as readonly string[]).includes(value);
/** A list of non-empty strings with at least one entry, or the refusal naming `field`. */
function nonEmptyStrings(value: unknown, field: string, source: string): string[] {
  const isMalformedList = !Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "");
  if (isMalformedList) {
    throw new ProjectDeclarationRefusal(field, "it must be a non-empty list of non-empty strings", source);
  }
  return value;
}

/** The routes a declaration configures, in cost order. Each must be one the router can start, none twice, and both routes the fallback can take must be there. */
function readRoutes(block: Record<string, unknown>, source: string): RouteName[] {
  if (!Object.hasOwn(block, "routes")) return [...ROUTES];
  const list = block.routes;
  if (!Array.isArray(list)) throw new ProjectDeclarationRefusal("routing.routes", `it must be a list, not ${describe(list)}`, source);
  list.forEach((entry, index) => {
    if (!isRoute(entry)) throw new ProjectDeclarationRefusal(`routing.routes[${index}]`, `${JSON.stringify(entry)} is not a route this router can start (${ROUTES.join(", ")})`, source);
    if (list.indexOf(entry) !== index) throw new ProjectDeclarationRefusal(`routing.routes[${index}]`, `\`${entry}\` is listed twice`, source);
  });
  const missing = FALLBACK_ROUTES.find((route) => !list.includes(route));
  if (missing !== undefined) throw new ProjectDeclarationRefusal("routing.routes", `\`${missing}\` is not configured, and it is a route the fallback takes, so the fallback would be unreachable`, source);
  return ROUTES.filter((route) => list.includes(route));
}

function readRouteGuidance(entry: unknown, at: string, source: string): RouteGuidance {
  if (!isObject(entry)) throw new ProjectDeclarationRefusal(at, `it must be an object, not ${describe(entry)}`, source);
  const text = (name: "what" | "notFor"): string => {
    const value = requiredString(entry, name, `${at}.`, source);
    if (value === "") throw new ProjectDeclarationRefusal(`${at}.${name}`, "it is empty", source);
    return value;
  };
  const list = (name: "signals" | "examples"): string[] => nonEmptyStrings(requiredField(entry, name, `${at}.`, source), `${at}.${name}`, source);
  return { what: text("what"), signals: list("signals"), notFor: text("notFor"), examples: list("examples") };
}

/** The guidance a project writes, only for a route it configured: guidance for another is a typo or a route it removed, and is refused rather than ignored. */
function readGuidance(block: Record<string, unknown>, routes: readonly RouteName[], source: string): Partial<Record<RouteName, RouteGuidance>> {
  if (!Object.hasOwn(block, "guidance")) return {};
  const guidance = block.guidance;
  if (!isObject(guidance)) throw new ProjectDeclarationRefusal("routing.guidance", `it must be an object, not ${describe(guidance)}`, source);
  return Object.fromEntries(Object.entries(guidance).map(([name, entry]) => {
    const at = `routing.guidance.${name}`;
    if (!isRoute(name) || !routes.includes(name)) throw new ProjectDeclarationRefusal(at, `\`${name}\` is not a configured route`, source);
    return [name, readRouteGuidance(entry, at, source)];
  }));
}

function readThreshold(block: Record<string, unknown>, name: "cheaperMinP" | "dearerMinP", source: string): number {
  if (!Object.hasOwn(block, name)) return ABSENT_ROUTING[name];
  const value = block[name];
  if (typeof value !== "number" || !(value > 0 && value <= 1)) throw new ProjectDeclarationRefusal(`routing.${name}`, `it must be a probability above 0 and at most 1, not ${JSON.stringify(value)}`, source);
  return value;
}

/** The veto's bar is read only between 0.5 and 0.99 (a11ign#5110): outside it the field names itself, so a typo cannot silently flip Haiku's default. */
function readVetoThreshold(block: Record<string, unknown>, source: string): number {
  if (!Object.hasOwn(block, "sonnetVetoMinP")) return ABSENT_ROUTING.sonnetVetoMinP;
  const value = block.sonnetVetoMinP;
  if (typeof value !== "number" || !(value >= 0.5 && value <= 0.99)) throw new ProjectDeclarationRefusal("routing.sonnetVetoMinP", `it must be a probability from 0.5 to 0.99, not ${JSON.stringify(value)}`, source);
  return value;
}

/**
 * #4904: HOW A NEW ENGINEER IS ROUTED, the optional `routing` block. ABSENT reads as {@link ABSENT_ROUTING}: today's three routes and today's four questions, so a project that never
 * names it routes exactly as before. This is NOT the defaulting `PROJECT_DECLARATION` refuses: it adds no value of any project's identity, it names the router's own behaviour, and
 * the route never reaches a repository or a board. A PRESENT block is held to the rule of every other field: an unknown key (a mistyped threshold would otherwise be ignored in silence),
 * a route the router cannot start, a fallback it cannot take and a threshold that is not a probability are each REFUSED naming the field.
 */
function readRouting(declaration: Record<string, unknown>, source: string): RoutingDeclaration {
  if (!Object.hasOwn(declaration, "routing")) return { ...ABSENT_ROUTING, routes: [...ABSENT_ROUTING.routes], guidance: {} };
  const block = declaration.routing;
  if (!isObject(block)) throw new ProjectDeclarationRefusal("routing", `it must be an object, not ${describe(block)}`, source);
  const unknown = Object.keys(block).find((key) => !key.startsWith("_") && !ROUTING_KEYS.includes(key));
  if (unknown !== undefined) throw new ProjectDeclarationRefusal(`routing.${unknown}`, `it is not a key of the routing block (${ROUTING_KEYS.join(", ")})`, source);
  const question = block.question ?? ABSENT_ROUTING.question;
  if (question !== "choice" && question !== "traits") throw new ProjectDeclarationRefusal("routing.question", `${JSON.stringify(question)} is not \`choice\` or \`traits\``, source);
  const routes = readRoutes(block, source);
  return { question, routes, guidance: readGuidance(block, routes, source), cheaperMinP: readThreshold(block, "cheaperMinP", source), dearerMinP: readThreshold(block, "dearerMinP", source), sonnetVetoMinP: readVetoThreshold(block, source) };
}

/**
 * Parse one declaration's text. PURE: no file is read, so a test drives every refusal with a string.
 * The FIRST tracker and the FIRST code repository are the project's own (decision 2: the empty key belongs to the primary
 * project's first of each), so `repo`, `boardOwner` and `boardNumber` are those entries' values.
 * @param {string} text @param {string} [source] what to call it in a refusal
 * @returns {Readonly<ProjectDeclaration>}
 */
export function parseProjectDeclaration(text: string, source: string = PROJECT_DECLARATION_PATH): Readonly<ProjectDeclaration> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "it is not valid JSON", source, { cause });
  }
  if (!isObject(parsed)) throw new ProjectDeclarationRefusal("(file)", `it must be a JSON object, not ${describe(parsed)}`, source);
  const schema = requiredField(parsed, "schema", "", source);
  if (schema !== SUPPORTED_SCHEMA) {
    throw new ProjectDeclarationRefusal("schema", `${JSON.stringify(schema)} is not a schema this reader knows (${SUPPORTED_SCHEMA})`, source);
  }
  const tracker = readList(parsed, "tracker", source, (entry, at) => readTracker(entry, at, source));
  const code = readList(parsed, "code", source, (entry, at) => readCode(entry, at, source));
  return Object.freeze({
    schema: SUPPORTED_SCHEMA,
    tracker,
    code,
    leakPatterns: readLeakPatterns(parsed, source),
    dora: readDora(parsed, source),
    offerMilestones: readOfferMilestones(parsed, source),
    routing: readRouting(parsed, source),
    repo: code[0].repo,
    boardOwner: tracker[0].board.owner,
    boardNumber: tracker[0].board.number,
  });
}

/**
 * Read the declaration of the project checked out at `root`. An absent file is REFUSED naming the path; it is never
 * answered with a project the caller did not declare.
 * @param {string} root @returns {Readonly<ProjectDeclaration>}
 */
export function readProjectDeclaration(root: string): Readonly<ProjectDeclaration> {
  const path = join(root, PROJECT_DECLARATION_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseProjectDeclaration(text, path);
}

/**
 * The variable that names the host file. `host-config.ts` owns it (`HOST_CONFIG_ENV`) and imports THIS module, so this one
 * cannot import it back: the name is written here too, and `standalone-candidate.test.ts` pins that the two agree.
 */
export const HOST_ENV = "AGENT_ORG_HOST";

/**
 * The `checkout` of the host file's `primary` project. Read here, minimally, and not through `host-config.ts` (a cycle, and
 * that reader checks far more than a checkout needs). EVERY failure REFUSES naming the host file and what is wrong: a host
 * file that is set and unusable is never answered with the directory three levels up (chairman, 2026-09-24: no fallback).
 * @param {string} hostPath @returns {string}
 */
function primaryCheckout(hostPath: string): string {
  let host: unknown;
  try {
    host = JSON.parse(readFileSync(hostPath, "utf8"));
  } catch (cause) {
    const unreadable = cause instanceof Error && "code" in cause;
    throw new ProjectDeclarationRefusal(HOST_ENV, unreadable ? "the host file cannot be read" : "the host file is not valid JSON", hostPath, { cause });
  }
  if (!isObject(host)) throw new ProjectDeclarationRefusal("primary", `the host file must be a JSON object, not ${describe(host)}`, hostPath);
  const primary = requiredString(host, "primary", "", hostPath);
  const projects = Array.isArray(host.projects) ? host.projects : [];
  const entry = projects.find((project) => isObject(project) && project.id === primary);
  if (!isObject(entry)) throw new ProjectDeclarationRefusal("primary", `\`${primary}\` is not one of \`projects\``, hostPath);
  const checkout = requiredString(entry, "checkout", `projects[${primary}].`, hostPath);
  if (!isAbsolute(checkout)) throw new ProjectDeclarationRefusal("checkout", `it must be an absolute path, not ${JSON.stringify(checkout)}`, hostPath);
  return checkout;
}

/** What `HOME_CHECKOUT` is for a ticket-only run (`isTicketOnlyRun`): there is no project checkout, so nothing may be read from one. */
export const TICKET_ONLY_CHECKOUT = "";

/**
 * Is this a ticket-mode worker (`AGENT_ORG_TICKET`) on a host file that declares no `primary` project? A machine that runs only the ticket board
 * keeps `clones` and `tickets` in its host file, with no project, board or tracker rows. Every other host file, and every run outside ticket mode,
 * still resolves its primary checkout and refuses as before.
 * @param {string} hostPath @param {Record<string, string | undefined>} env @returns {boolean}
 */
export function isTicketOnlyRun(hostPath: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!env.AGENT_ORG_TICKET) return false;
  try {
    const host: unknown = JSON.parse(readFileSync(hostPath, "utf8"));
    return isObject(host) && !Object.hasOwn(host, "primary") && isObject(host.tickets);
  } catch (error) {
    void error; // an unreadable host file is `primaryCheckout`'s refusal to name
    return false;
  }
}

/**
 * The declaration a ticket-only run reads: one blank tracker and one blank repository, and no leak patterns of its own. Modules the row path owns read
 * `tracker[0]` and `code[0]` when they load, so an empty list would stop `pr:open` before it ran. Nothing a ticket worker does reads those blanks:
 * the ticket checks name the ticket's own repository, and a row's reads are skipped (A11-74).
 */
const TICKET_ONLY_DECLARATION: Readonly<ProjectDeclaration> = Object.freeze({
  schema: SUPPORTED_SCHEMA, tracker: [{ key: "", repo: "", board: { owner: "", number: 0 } }], code: [{ key: "", repo: "" }], leakPatterns: [], dora: [],
  offerMilestones: [], routing: ABSENT_ROUTING, repo: "", boardOwner: "", boardNumber: 0,
});

/**
 * Is the tool running from a package manager's `node_modules`? That is the INSTALLED layout (`pnpm add -D github:a11ign/agent-org#...`), and the
 * only one whose directory says nothing about the project: pnpm links the package from a store path
 * (`<project>/node_modules/.pnpm/agent-org@<hash>/node_modules/agent-org/src`), so `src` up three is a directory inside the store. Read off the
 * path and not off a flag, because a flag is one more thing a unit could forget to set.
 * @param {string} toolDir the directory the tool's modules are in @returns {boolean}
 */
const isInstalled = (toolDir: string): boolean => toolDir.split(sep).includes("node_modules");

/**
 * The root of the git repository `cwd` is inside, or `null` when it is inside none. `git` exits 128 for "not a repository", and that is an
 * ANSWER; anything else (git absent, a signal) is a failure and is rethrown with its cause. `GIT_*` is stripped so a hook's exported `GIT_DIR`
 * cannot make the answer be somebody else's checkout.
 * @param {string} cwd @returns {string | null}
 */
function gitToplevel(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    const notARepository = cause instanceof Error && (cause as { status?: number }).status === NOT_A_REPOSITORY_STATUS;
    if (notARepository) return null;
    throw new ProjectDeclarationRefusal("(cwd)", `\`git rev-parse --show-toplevel\` could not run in \`${cwd}\``, "the tool's checkout resolution", { cause });
  }
}
const NOT_A_REPOSITORY_STATUS = 128;

/**
 * The project of an INSTALLED tool: the repository the command is run in. Nothing is guessed from where the tool sits, and a directory
 * with no declaration is REFUSED naming the file and where it was looked for.
 * @param {string} cwd @returns {string}
 */
function installedProject(cwd: string): string {
  const top = gitToplevel(cwd);
  const looked = top ?? cwd;
  if (existsSync(join(looked, PROJECT_DECLARATION_PATH))) return looked;
  const where = top === null ? `\`${cwd}\`, which is not inside a git repository` : `\`${top}\`, the git repository \`${cwd}\` is in`;
  throw new ProjectDeclarationRefusal(PROJECT_DECLARATION_PATH, `the tool is installed, so the project is the repository it is run in, and ${where}, holds no \`${PROJECT_DECLARATION_PATH}\``
    + " (declare the project there, or set `AGENT_ORG_HOST` to a host file whose primary is the project)", "the tool's checkout resolution");
}

/** The host declaration's path inside a checkout. `host-config.ts` imports this module, so it cannot be imported back; the project-config test pins this to `host-config.ts`'s `HOST_DECLARATION_PATH`. */
export const HOST_DECLARATION = ".agent-org/host.json";

/**
 * The host declaration whose `clones` map names THIS repository's checkout, or `null` (#1433). It is read only to NAME the file: nothing is resolved from
 * it, so the refusal stays a refusal and no project is defaulted. The checkout is the repository's main clone, which a linked worktree's git common
 * directory names; the declarations are the `.agent-org/host.json` files beside that clone (the layout the tool serves). A file that cannot be read, or
 * that names no clone of this one, is skipped, so an absent answer is a refusal without the hint and never a guess.
 * @param {string} cwd @returns {string | null}
 */
function hostDeclaringClone(cwd: string): string | null {
  let clone: string;
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
    clone = dirname(resolve(cwd, common));
  } catch {
    return null;
  }
  let siblings: string[];
  try {
    siblings = readdirSync(dirname(clone)).sort();
  } catch {
    return null;
  }
  for (const name of siblings) {
    let clones: unknown;
    try {
      clones = JSON.parse(readFileSync(join(dirname(clone), name, HOST_DECLARATION), "utf8")).clones;
    } catch {
      continue;
    }
    if (isObject(clones) && Object.values(clones).some((path) => typeof path === "string" && resolve(path) === clone)) return join(dirname(clone), name, HOST_DECLARATION);
  }
  return null;
}

/**
 * The checkout the tool serves, by LAYOUT. `$AGENT_ORG_HOST` set (and non-empty, as `hostConfigPath` reads it) wins in every layout and names the
 * host file; the answer is its primary project's checkout (ADR 0040, decision 3). Unset, the layout decides:
 *   - INSTALLED (`node_modules` in the tool's path; the project's own `pnpm add -D`): the git repository the command is run in (#3068). It must
 *     hold the declaration, or the refusal names the file and the directory looked in.
 *   - MONOREPO (`packages/agent-org/src`): `src` up three, `beside`, which is the product's tree.
 *   - STANDALONE (the tool's own checkout): the same `beside`, which is the home directory and holds no declaration. Then the repository the
 *     command is run in, IF it holds the declaration (#3532: the installed layout's rule, #3068, given to this layout, so `agent-org <cmd>` from
 *     a linked worktree serves that worktree as `pnpm run <alias>` did). Otherwise it REFUSES naming the variable (#3039, measured 2026-10-02
 *     15:23Z to about 17:40Z: 63 ticks died on `ENOENT: open '<home>/.agent-org/project.json'`, a file nobody wrote, with the variable that was
 *     missing nowhere in the message). The same rule the set-but-unusable case already keeps (chairman, 2026-09-24: no fallback): only a
 *     repository that HOLDS the declaration answers, and nothing is guessed from where the tool sits.
 * `packaging/installed-layout.test.ts` carries one table: which layout answers what.
 * @param {{ env?: Record<string, string | undefined>, toolDir?: string, beside?: string, cwd?: string }} [where]
 * @returns {string}
 */
export function resolveHomeCheckout({
  env = process.env,
  toolDir = dirname(fileURLToPath(import.meta.url)),
  beside = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  cwd = process.cwd(),
}: { env?: Record<string, string | undefined>; toolDir?: string; beside?: string; cwd?: string; } = {}): string {
  const host = env[HOST_ENV];
  if (host !== undefined && host !== "" && isTicketOnlyRun(host, env)) return TICKET_ONLY_CHECKOUT;
  if (host !== undefined && host !== "") return primaryCheckout(host);
  if (isInstalled(toolDir)) return installedProject(cwd);
  if (existsSync(join(beside, PROJECT_DECLARATION_PATH))) return beside;
  const top = gitToplevel(cwd);
  if (top !== null && existsSync(join(top, PROJECT_DECLARATION_PATH))) return top;
  const named = hostDeclaringClone(cwd);
  throw new ProjectDeclarationRefusal(HOST_ENV, `it is ${host === undefined ? "unset" : "empty"}, and the checkout it would have guessed, \`${beside}\`, holds no \`${PROJECT_DECLARATION_PATH}\``
    + ` (the tool is not inside a project, and \`${cwd}\` is not inside a repository that holds one).`
    + " Set it in the unit (`Environment=AGENT_ORG_HOST=<checkout>/.agent-org/host.json`, which `host:install` writes), or in the shell that runs the tool"
    + (named === null ? "" : ` (this repository is a clone that the host declaration \`${named}\` names in its \`clones\`, so set \`${HOST_ENV}=${named}\`)`),
  "the tool's checkout resolution");
}

/** The checkout this process serves, resolved once at import (see `resolveHomeCheckout`). */
export const HOME_CHECKOUT = resolveHomeCheckout();

let homeProject: Readonly<ProjectDeclaration> | undefined;

/** The declaration of the project this tool is running in, read once. @returns {Readonly<ProjectDeclaration>} */
export function homeProjectDeclaration(): Readonly<ProjectDeclaration> {
  if (HOME_CHECKOUT === TICKET_ONLY_CHECKOUT) return TICKET_ONLY_DECLARATION;
  homeProject ??= readProjectDeclaration(HOME_CHECKOUT);
  return homeProject;
}

/**
 * The code repositories the project declares, or none when its declaration cannot be read: a reader that only adds a second way to find a clone (A11-292) is then left with the first, the key, as it
 * was before. @returns {readonly CodeRepository[]}
 */
export function declaredCodeOrNone(): readonly CodeRepository[] {
  try {
    return homeProjectDeclaration().code;
  } catch {
    return [];
  }
}
