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

/**
 * The persistent entries with the brief each names, for the step that STARTS a seat from it.
 * @param {string | URL} [path] the roster file
 * @returns {{ name: string, brief?: string }[]}
 */
export function persistentEntries(path: string | URL = roleBriefPath("sessions.json").absolute): { name: string; brief?: string; }[] {
  const { live } = (JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, persistent?: boolean, brief?: string }[] });
  return live.filter((s) => s.persistent === true).map(({ name, brief }) => ({ name, brief }));
}
