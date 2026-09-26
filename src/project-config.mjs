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
// files of this package, so anything heavier here is paid by every one of them (`api-pool.mjs` says why that matters).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DECLARATION_PATH = ".agent-org/project.json";
/** The only `schema` this reader understands. An unknown one REFUSES: it is the one version coupling (ADR 0040, decision 3). */
export const SUPPORTED_SCHEMA = 1;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEY_PATTERN = /^[a-z0-9-]*$/;
const ENDS_IN_DIGITS = /-\d+$/;

/**
 * @typedef {{ key: string, repo: string }} CodeRepository
 * @typedef {{ key: string, repo: string, board: { owner: string, number: number } }} Tracker
 * @typedef {{ name: string, pattern: string }} LeakPattern one thing this project's public prose must never carry: the name a refusal quotes, and a regular expression's SOURCE (no slashes, no flags)
 * @typedef {{ schema: number, tracker: Tracker[], code: CodeRepository[], leakPatterns: LeakPattern[], repo: string, boardOwner: string, boardNumber: number }} ProjectDeclaration
 */

/** A refusal that carries the field it is about, so a caller (and a test) can tell WHICH rule fired and not merely that one did. */
export class ProjectDeclarationRefusal extends Error {
  /** @param {string} field @param {string} reason @param {string} source @param {{ cause?: unknown }} [options] */
  constructor(field, reason, source, options) {
    super(`${source}: field \`${field}\` REFUSED: ${reason}. Nothing is defaulted to another project's value.`, options);
    this.name = "ProjectDeclarationRefusal";
    this.field = field;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {Record<string, unknown>} holder @param {string} name @param {string} path @param {string} source
 * @returns {unknown}
 */
function requiredField(holder, name, path, source) {
  if (!Object.hasOwn(holder, name)) throw new ProjectDeclarationRefusal(`${path}${name}`, "it is missing", source);
  return holder[name];
}

/** @param {Record<string, unknown>} holder @param {string} name @param {string} path @param {string} source */
function requiredString(holder, name, path, source) {
  const value = requiredField(holder, name, path, source);
  if (typeof value !== "string") {
    throw new ProjectDeclarationRefusal(`${path}${name}`, `it must be a string, not ${describe(value)}`, source);
  }
  return value;
}

/** @param {unknown} value */
const describe = (value) => (value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`);

/** @param {string} field @param {string} repo @param {string} source */
function checkRepo(field, repo, source) {
  if (!REPO_PATTERN.test(repo)) throw new ProjectDeclarationRefusal(field, `\`${repo}\` is not \`owner/name\``, source);
}

/** @param {string} field @param {string} key @param {string} source */
function checkKey(field, key, source) {
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
function readList(declaration, listName, source, readEntry) {
  const list = requiredField(declaration, listName, "", source);
  if (!Array.isArray(list)) throw new ProjectDeclarationRefusal(listName, `it must be a list, not ${describe(list)}`, source);
  if (list.length === 0) throw new ProjectDeclarationRefusal(listName, "it is empty; a project has at least one", source);
  /** @type {Set<string>} */
  const seen = new Set();
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
function readCode(entry, at, source) {
  const key = requiredString(entry, "key", `${at}.`, source);
  const repo = requiredString(entry, "repo", `${at}.`, source);
  checkRepo(`${at}.repo`, repo, source);
  return { key, repo };
}

/** @param {Record<string, unknown>} entry @param {string} at @param {string} source */
function readTracker(entry, at, source) {
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
 * tool holds itself (`lib/leak-patterns.mjs`: a private LAN address, a named SSH key file). A declaration that names none is a project
 * with none of its own, so an ABSENT field reads as an empty list -- and that is the one field here that does, because it adds to a floor the
 * tool already enforces rather than answering a question about WHICH project this is. A present field is held to the same rule as every
 * other: each entry needs a non-empty `name` and a `pattern` that compiles, and it is REFUSED naming the entry when it does not.
 * @param {Record<string, unknown>} declaration @param {string} source
 * @returns {LeakPattern[]}
 */
function readLeakPatterns(declaration, source) {
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

/**
 * Parse one declaration's text. PURE: no file is read, so a test drives every refusal with a string.
 * The FIRST tracker and the FIRST code repository are the project's own (decision 2: the empty key belongs to the primary
 * project's first of each), so `repo`, `boardOwner` and `boardNumber` are those entries' values.
 * @param {string} text @param {string} [source] what to call it in a refusal
 * @returns {Readonly<ProjectDeclaration>}
 */
export function parseProjectDeclaration(text, source = PROJECT_DECLARATION_PATH) {
  /** @type {unknown} */
  let parsed;
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
export function readProjectDeclaration(root) {
  const path = join(root, PROJECT_DECLARATION_PATH);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  return parseProjectDeclaration(text, path);
}

/**
 * The checkout this module lives in. Until `host.json` says where each project is (ADR 0040, decision 3, a later row) the
 * tool runs from inside the product's own tree, so the declaration is the one beside it: `packages/agent-org/src` up three.
 */
export const HOME_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** @type {Readonly<ProjectDeclaration> | undefined} */
let homeProject;

/** The declaration of the project this tool is running in, read once. @returns {Readonly<ProjectDeclaration>} */
export function homeProjectDeclaration() {
  homeProject ??= readProjectDeclaration(HOME_CHECKOUT);
  return homeProject;
}
