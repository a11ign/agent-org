// @ts-check
// #2621 (child 3e of #69): WHERE A PROJECT'S ROLE BRIEFS LIVE (ADR 0040, decision 1, surface 3). Read from
// `.agent-org/project.json`'s `roles` key, `project-vocabulary.ts`'s own pattern: IT REFUSES, IT NEVER
// DEFAULTS, and re-reads the declaration rather than teaching `project-config.ts`'s strict reader a field
// it does not otherwise need.
//
// THE TOOL SHIPS NO ROLE BRIEF. `wake.ts`'s `ENGINEER_BRIEF` and the roster (`sessions.json`, read by
// `engineerRoles`/`spareRoles`/`spareInstances`/`isSpareRole`) used to be a path baked into this package,
// `packages/agent-org/docs/roles/...`; they are now a11ign's own files, at the directory this module names
// -- so a second project supplies its own directory and its own briefs, or has none.
//
// A MISSING DIRECTORY IS REFUSED HERE, naming the declared `dir` rather than letting a bare `ENOENT` from
// whichever file a caller happens to read first stand in for it -- the same "refuse where the field is
// read, not where it is eventually used" the rest of `.agent-org/project.json`'s readers hold to.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT, ProjectDeclarationRefusal } from "./project-config.ts";
import { CLAUDE_EFFORTS } from "./worker-profile.ts";

const SOURCE = ".agent-org/project.json";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const describe = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`);

/**
 * Parse `.agent-org/project.json`'s `roles` key, PURE: a test drives every refusal with a plain object,
 * `project-vocabulary.ts`'s `parseVocabulary` discipline.
 * @param {unknown} parsed the whole parsed JSON document
 * @returns {string} the role-briefs directory, relative to the project root
 */
export function parseRolesDir(parsed: unknown): string {
  if (!isObject(parsed)) throw new ProjectDeclarationRefusal("(file)", `it must be a JSON object, not ${describe(parsed)}`, SOURCE);
  if (!Object.hasOwn(parsed, "roles")) throw new ProjectDeclarationRefusal("roles", "it is missing", SOURCE);
  const roles = parsed.roles;
  if (!isObject(roles)) throw new ProjectDeclarationRefusal("roles", `it must be an object, not ${describe(roles)}`, SOURCE);
  const dir = roles.dir;
  if (typeof dir !== "string" || dir === "") {
    throw new ProjectDeclarationRefusal("roles.dir", `it must be a non-empty string, not ${describe(dir)}`, SOURCE);
  }
  return dir;
}

/**
 * The project's role-briefs directory, repo-relative (what a prompt names, what `existsSync` checks against).
 * @param {string} root @returns {string}
 */
export function homeRolesDir(root: string = HOME_CHECKOUT): string {
  const path = `${root}/${SOURCE}`;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "it is not valid JSON", path, { cause });
  }
  return parseRolesDir(parsed);
}

/**
 * A named role brief's path, repo-relative and absolute: `join`ed against the declared directory, never a
 * literal `packages/agent-org/...` one.
 * @param {string} name e.g. `"engineer.md"` or `"sessions.json"`
 * @param {string} root
 * @returns {{ relative: string, absolute: string }}
 */
export function roleBriefPath(name: string, root: string = HOME_CHECKOUT): { relative: string; absolute: string; } {
  const dir = homeRolesDir(root);
  const absoluteDir = join(root, dir);
  if (!existsSync(absoluteDir)) {
    throw new ProjectDeclarationRefusal("roles.dir", `\`${dir}\` does not exist at ${root}`, `${root}/${SOURCE}`);
  }
  return { relative: `${dir}/${name}`, absolute: join(absoluteDir, name) };
}

/**
 * The roles `sessions.json` MARKS `persistent` (#3415), in file order: a seat that is never cleared, whatever its `role`.
 * READ, NOT TYPED, and a ROLE fact like `drain` and `spare` (`_rolesNotProcesses`): it names no pane, pid or workspace.
 * An unreadable roster throws -- a caller that can fail open says so itself.
 *
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {string[]}
 */
export function persistentRoles(path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  return persistentEntries(path).map((s) => s.name);
}

/** A persistent seat's roster entry: its name and brief, the launch fields it MAY declare (#4740), and why one of them was refused. */
export type PersistentEntry = {
  name: string;
  brief?: string;
  /** a model id or alias, passed to `--model` */
  model?: string;
  /** one of {@link CLAUDE_EFFORTS}, passed to `--effort` */
  effort?: string;
  /** the WINDOW `--autocompact` takes, which compacts about `AUTO_COMPACT_TRIGGER_MARGIN_TOKENS` below it, NOT the trigger itself */
  autocompact?: number;
  /** set when a declared field is malformed: it names the entry and the field, and the seat is not started with a default in its place */
  refusal?: string;
};

/** A model id or alias as `--model` takes one (`sonnet`, `claude-haiku-5-5`, `opus[1m]`): no whitespace, and never a leading `-`, which would be read as a flag. */
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._[\]:-]*$/;

/** Why a declared launch field is malformed, or `null` when it is absent or well-formed. An absent field is the seat's default and never a refusal. */
function launchFieldRefusal(entry: { name: string; model?: unknown; effort?: unknown; autocompact?: unknown }): string | null {
  const where = `roster entry \`${entry.name}\``;
  const { model, effort, autocompact } = entry;
  if (model !== undefined && !(typeof model === "string" && MODEL_VALUE.test(model))) {
    return `${where}: \`model\` must be a model id such as \`claude-haiku-5-5\`, not ${JSON.stringify(model)}.`;
  }
  if (effort !== undefined && !(typeof effort === "string" && CLAUDE_EFFORTS.includes(effort))) {
    return `${where}: \`effort\` must be one of ${CLAUDE_EFFORTS.join(", ")}, not ${JSON.stringify(effort)}.`;
  }
  if (autocompact !== undefined && !(typeof autocompact === "number" && Number.isInteger(autocompact) && autocompact > 0)) {
    return `${where}: \`autocompact\` must be a positive whole number of tokens (the window \`--autocompact\` takes), not ${JSON.stringify(autocompact)}.`;
  }
  return null;
}

/**
 * The persistent entries with the brief each names and the launch fields each declares, for the step that STARTS a seat from it.
 *
 * `model`, `effort` and `autocompact` are OPTIONAL (#4740), and a seat that declares none starts as it always did. A MALFORMED one is NOT a default
 * and NOT a throw: the entry comes back with `refusal` naming it, so the start step prints `SEAT NOT STARTED` for that seat alone and the other
 * seats are still looked for. (A throw would read as an unreadable roster and stop every seat.) The seat still counts as persistent
 * ({@link persistentRoles}), so `host:check` goes on naming it absent.
 * @param {string | URL} [path] the roster file
 */
export function persistentEntries(path: string | URL = roleBriefPath("sessions.json").absolute): PersistentEntry[] {
  const { live } = (JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, persistent?: boolean, brief?: string, model?: unknown, effort?: unknown, autocompact?: unknown }[] });
  return live.filter((s) => s.persistent === true).map((entry) => {
    const { name, brief } = entry;
    const refusal = launchFieldRefusal(entry);
    if (refusal !== null) return { name, brief, refusal };
    const { model, effort, autocompact } = entry as { model?: string; effort?: string; autocompact?: number };
    return { name, brief, ...(model !== undefined && { model }), ...(effort !== undefined && { effort }), ...(autocompact !== undefined && { autocompact }) };
  });
}
