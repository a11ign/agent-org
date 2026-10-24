// @ts-check
// module: the atomic reviewer's Codex trust -- which repositories Codex trusts, and trusting the host file's repositories before a review starts (A11-221)
//
// CODEX KEEPS TRUST PER REPOSITORY ROOT in `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`: `[projects."<root>"]` with `trust_level = "trusted"`. A root it has no entry for stops its session on a
// "Trust this folder?" dialog that nobody answers. A review checkout is a linked worktree, and Codex resolves its trust to the MAIN CLONE's root, so the root that counts is the clone's.
//
// THIS IS THE ONLY CODE THAT WRITES CODEX'S CONFIG, and it writes for the host file's repositories only (`clones` of `host.json`), never for a path it is handed. Every question is a pure function over
// the config's text; the one writer appends to the text rather than serialising the parse again, which would lose the person's comments, and parses its result before it replaces the file.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import type { PluginDeps } from "../../src/plugins/manifest.ts";

/** What the trust code reads of the machine: the environment (`CODEX_HOME`, `HOME`) and the host file's checkouts by repository name. */
export type TrustSeams = Readonly<{ env: Readonly<Record<string, string | undefined>>; clones: Readonly<Record<string, string>> }>;

/** Where Codex keeps its config: `$CODEX_HOME/config.toml`, else `$HOME/.codex/config.toml`. The rule core's `codexConfigPath` uses, over the env the plugin is given. */
export function codexConfigFile(env: TrustSeams["env"]): string {
  const codexHome = env.CODEX_HOME;
  const home = env.HOME;
  return join(codexHome !== undefined && codexHome !== "" ? codexHome : join(home !== undefined && home !== "" ? home : homedir(), ".codex"), "config.toml");
}

/**
 * The root of the clone a checkout belongs to, or null when git cannot say: the parent of `git rev-parse --git-common-dir`, which for a linked worktree is the main clone's `.git`. This is the root
 * Codex trusts for a worktree. A common dir that is not a `.git` (a bare repository) has no clone root.
 */
export function cloneRootOf(tree: string, exec: PluginDeps["exec"]): string | null {
  const found = exec("git", ["-C", tree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = found.status === 0 ? found.stdout.trim() : "";
  return basename(commonDir) === ".git" ? dirname(commonDir) : null;
}

/** A path as Codex and git name it: absolute, no trailing slash, symlinks resolved when the path exists. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** The host file's repositories, canonical and without a repeat: the roots Codex may be told to trust. */
export function hostRepositories(clones: TrustSeams["clones"]): string[] {
  return [...new Set(Object.values(clones).map(canonicalPath))];
}

/** Whether `root` is one of the host file's repositories: its canonical path equals a clone's. A path under a clone, or a symlink to somewhere else, is not. */
export const isHostRepository = (root: string, clones: TrustSeams["clones"]): boolean => hostRepositories(clones).includes(canonicalPath(root));

/** Codex's config as it can be read: its text, what it parses to and what it holds under `projects`, or the refusal that names why it cannot be used. A file that does not exist reads as empty. */
export type TrustConfig = Readonly<{ file: string; text: string; parsed: Readonly<Record<string, unknown>>; projects: Readonly<Record<string, unknown>> }> | Readonly<{ file: string; refusal: string }>;

/** A TOML table as `smol-toml` parses it: a plain object with no prototype (a date or an array is not one). */
const isTable = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && [null, Object.prototype].includes(Object.getPrototypeOf(value));

/** The `projects` table of a parsed config, or the refusal when `projects` is something else (an inline value, an array). */
function projectsOf(parsed: Record<string, unknown>, file: string): { projects: Record<string, unknown> } | { refusal: string } {
  if (!Object.hasOwn(parsed, "projects")) return { projects: {} };
  return isTable(parsed.projects) ? { projects: parsed.projects } : { refusal: `${file} defines \`projects\` as something other than a table, so a trust entry cannot be added to it` };
}

/** Reads and parses Codex's config. A missing file is an empty config; one that cannot be read or does not parse is a refusal naming the file. */
export function readTrustConfig(file: string): TrustConfig {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { file, refusal: `${file} could not be read (${(error as Error).message})` };
  }
  try {
    const parsed = parse(text);
    const projects = projectsOf(parsed, file);
    return "refusal" in projects ? { file, refusal: projects.refusal } : { file, text, parsed, projects: projects.projects };
  } catch (error) {
    return { file, refusal: `${file} does not parse as TOML (${(error as Error).message}), so Codex could not start on it either` };
  }
}

/** The word Codex's config holds for a root: its `trust_level`, `"unset"` for an entry with none, and `"absent"` for a root with no entry. */
export function trustLevelOf(projects: Readonly<Record<string, unknown>>, root: string): string {
  if (!Object.hasOwn(projects, root)) return "absent";
  const entry = projects[root];
  return isTable(entry) && typeof entry.trust_level === "string" ? entry.trust_level : "unset";
}

/** The modes of what is created: a folder only its owner enters, and a config only its owner reads (Codex's own). */
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const PERMISSION_BITS = 0o777;

/** A string as a TOML basic string: quoted, with the characters TOML forbids bare escaped (JSON's escapes, and the delete character JSON leaves). */
const tomlString = (value: string): string => JSON.stringify(value).replaceAll("\u007f", "\\u007f");

/** The text that adds a trusted entry for `root` after `text`. */
export const trustEntryAppended = (text: string, root: string): string => `${text}${text === "" ? "" : "\n"}[projects.${tomlString(root)}]\ntrust_level = "trusted"\n`;

/** What `ensureTrusted` did: added an entry, found one and left it, found the root is not the host file's, or refused the file. */
export type Ensured =
  | Readonly<{ kind: "added"; root: string; file: string }>
  | Readonly<{ kind: "present"; root: string; file: string; level: string }>
  | Readonly<{ kind: "not-host"; root: string; reason: string }>
  | Readonly<{ kind: "refused"; file: string; reason: string }>;

/** A parsed value as plain data, so two parses compare by what they hold and not by the prototype `smol-toml` gives its tables: a date is its text. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (isTable(value)) return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, plain(held)]));
  return typeof value === "object" && value !== null ? String(value) : value;
}

/** Why the text with the new entry is not safe to write, or null when it parses with the entry trusted and every other key as it was. */
function unsafeAppend({ before, appended, root, file }: Readonly<{ before: Readonly<Record<string, unknown>>; appended: string; root: string; file: string }>): string | null {
  let after: Record<string, unknown>;
  try {
    after = parse(appended);
  } catch (error) {
    return `${file} would not parse with the trust entry added (${(error as Error).message})`;
  }
  const projects = projectsOf(after, file);
  if ("refusal" in projects) return projects.refusal;
  if (trustLevelOf(projects.projects, root) !== "trusted") return `${file} would not read ${root} as trusted with the entry added`;
  const others = Object.fromEntries(Object.entries(projects.projects).filter(([key]) => key !== root));
  const { projects: _projects, ...rest } = after;
  const { projects: _before, ...restBefore } = before;
  return isDeepStrictEqual(plain(others), plain(before.projects ?? {})) && isDeepStrictEqual(plain(rest), plain(restBefore)) ? null : `${file} would change a key besides the new entry`;
}

/** Replaces `file` with `text`: written beside it, with the old file's mode, and renamed over it. A symlinked config is written through. */
function replaceFile(file: string, text: string): void {
  const exists = existsSync(file);
  const target = exists ? realpathSync(file) : file;
  if (!exists) mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY });
  const mode = exists ? statSync(target).mode & PERMISSION_BITS : PRIVATE_FILE;
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}

/**
 * Makes Codex trust `root`, when `root` is one of the host file's repositories. A root that is not is never written. An entry that exists, trusted or not, is left exactly as it is (an explicit
 * `untrusted` is a person's choice) and the file is not rewritten. An absent entry is appended, the result parsed and checked, and only then written. A config that cannot be read or parsed, or
 * whose result fails the check, is a refusal, and nothing is written.
 */
export function ensureTrusted(root: string, seams: TrustSeams): Ensured {
  const canonical = canonicalPath(root);
  if (!isHostRepository(canonical, seams.clones)) return { kind: "not-host", root: canonical, reason: `${canonical} is not one of the repositories the host file names (\`clones\` in host.json), so Codex is not told to trust it` };
  const config = readTrustConfig(codexConfigFile(seams.env));
  if ("refusal" in config) return { kind: "refused", file: config.file, reason: config.refusal };
  const level = trustLevelOf(config.projects, canonical);
  if (level !== "absent") return { kind: "present", root: canonical, file: config.file, level };
  const appended = trustEntryAppended(config.text, canonical);
  const unsafe = unsafeAppend({ before: config.parsed, appended, root: canonical, file: config.file });
  if (unsafe !== null) return { kind: "refused", file: config.file, reason: unsafe };
  try {
    replaceFile(config.file, appended);
  } catch (error) {
    return { kind: "refused", file: config.file, reason: `${config.file} could not be written (${(error as Error).message})` };
  }
  return { kind: "added", root: canonical, file: config.file };
}

/** The host file's repositories Codex does not trust, with the `trust_level` each holds (`"absent"` for no entry), or the refusal naming the config when it cannot be read. */
export function untrustedHostRepositories(seams: TrustSeams): { file: string; untrusted: { root: string; level: string }[] } | { file: string; refusal: string } {
  const config = readTrustConfig(codexConfigFile(seams.env));
  if ("refusal" in config) return { file: config.file, refusal: config.refusal };
  const levels = hostRepositories(seams.clones).map((root) => ({ root, level: trustLevelOf(config.projects, root) }));
  return { file: config.file, untrusted: levels.filter(({ level }) => level !== "trusted") };
}

/** What the port is given to trust a review's repository before its reviewer starts (`Seams.codexTrust`): where the clone root is, what trusts it, and where the news goes. */
export function codexTrustSeam(deps: Pick<PluginDeps, "env" | "clones" | "exec" | "log">) {
  return { rootOf: (tree: string) => cloneRootOf(tree, deps.exec), ensure: (root: string) => ensureTrusted(root, deps), log: deps.log };
}
