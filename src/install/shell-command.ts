// @ts-check
// module: what the person's shell runs when they type `agent-org`, and whether that is the installed tool (A11-285)
//
// On 2026-10-25 `agent-org` was an alias in `~/.zshrc` to a checkout at v0.276.0, the installed tool was v0.304.1, and `agent-org update` run by hand ran the stale code. Doctor, `command:check`,
// `install.sh` and `onboard` all ask the same question, so it is answered here once: READ what the login shell runs (`$SHELL -lic 'type agent-org'`: an alias, a function or a file on PATH),
// find the copy of the tool that names, and JUDGE it. Reading is impure and judging is not, so a test drives every verdict with a value.
//
// THE INSTALLED TOOL COUNTS ONLY WHEN REACHED THROUGH `<tool>/current`. An alias that names `versions/v0.306.0` runs the right code today and the wrong code after the next update, so it fails.
// A checkout used on purpose for development passes only when host.json names it (`devTool`) and it is at least as new as the installed tool.
import { spawnSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Check } from "./doctor.ts";
import { compareWithInstalled, type CopyComparison } from "./tool-copy.ts";
import { currentLink, toolDir } from "./tool-versions.ts";
import { readOrNull, type Env } from "./paths.ts";

export const COMMAND_CHECK_NAME = "agent-org command";
const SHELL_TIMEOUT_MS = 10_000;
const BIN_TS = /\/src\/bin\.ts$/;
const MAX_LINKS = 8;

/** Where a definition is: a start-up file and the 1-based line, or (for a file on PATH) the file alone. */
export type Definition = Readonly<{ file: string; line: number | null }>;

/** What the shell runs for `agent-org`. `launcher` is the file on PATH (or the one an alias names); `copyRoot` the root of the tool it ends in, when that could be told. */
export type ShellReading =
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "alias" | "function" | "file"; said: string; launcher: string | null; copyRoot: string | null; defined: Definition | null; comparison: CopyComparison | null }>;

export type ShellDeps = Readonly<{
  env: Env;
  home: string;
  /** Runs `<shell> -lic 'type agent-org'`: its text, or null when the shell could not be run or timed out. */
  type: (shell: string) => string | null;
  read: (path: string) => string | null;
  /** A symlink's target, or null when `path` is not one. */
  readlink: (path: string) => string | null;
  which: (name: string) => string | null;
  compare: (copyRoot: string) => CopyComparison;
}>;

/** Runs the person's shell the way a terminal does, with no terminal: login and interactive start-up files are read, stdin is closed, and the answer is waited for ten seconds. */
function typeInShell(shell: string, env: Env): string | null {
  const result = spawnSync(shell, ["-lic", "type agent-org"], { encoding: "utf8", timeout: SHELL_TIMEOUT_MS, env: { ...env, TERM: "dumb" }, stdio: ["ignore", "pipe", "ignore"] });
  return result.error !== undefined || result.stdout === "" ? null : result.stdout;
}

const readLink = (path: string): string | null => {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
};

const firstOnPath = (name: string, env: Env): string | null => (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? null;

/** The machine's own seams: the shell, the files, PATH, and the comparison with the installed tool of `tool`. */
export function realShellDeps(env: Env, home: string, tool: string): ShellDeps {
  return { env, home, type: (shell) => typeInShell(shell, env), read: readOrNull, readlink: readLink, which: (name) => firstOnPath(name, env), compare: (copyRoot) => compareWithInstalled(copyRoot, { tool }) };
}

/** `~` and `$HOME` at the start of a path word, as the shell would expand them; other words are returned as they are. */
export function expandHome(word: string, home: string): string {
  const stripped = word.replace(/^["']|["']$/g, "");
  if (stripped === "~" || stripped.startsWith("~/")) return home + stripped.slice(1);
  const variable = /^\$\{?HOME\}?(\/.*)?$/.exec(stripped);
  return variable === null ? stripped : home + (variable[1] ?? "");
}

/** A path as a person writes it: under the home folder as `~/...`. */
export const tilde = (path: string, home: string): string => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

type Said = Readonly<{ kind: "alias"; command: string } | { kind: "function"; body: string; from: string | null } | { kind: "file"; path: string }>;

const unquote = (text: string): string => text.trim().replace(/^[`'"]/, "").replace(/['"]$/, "");

/** The `agent-org is ...` line of `type`'s text, bash's wording and zsh's. Null when there is none (and `absent` when the shell says it found nothing). */
function parseSaid(text: string): Said | "absent" | null {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const at = lines.findLastIndex((line) => line.startsWith("agent-org is "));
  if (at < 0) return /not found/.test(text) ? "absent" : null;
  const rest = lines[at].slice("agent-org is ".length);
  const alias = /^(?:an alias for|aliased to) (.*)$/.exec(rest);
  if (alias !== null) return { kind: "alias", command: unquote(alias[1]) };
  const fn = /^a (?:shell )?function(?: from (.+))?$/.exec(rest);
  if (fn !== null) return { kind: "function", body: lines.slice(at + 1).join("\n"), from: fn[1] ?? null };
  const file = /^hashed \((.+)\)$/.exec(rest) ?? /^(\/.*)$/.exec(rest);
  return file === null ? null : { kind: "file", path: file[1] };
}

/** The `src/bin.ts` a launcher file runs: a symlink chain that ends in one, else the `exec node '<path>/src/bin.ts'` line of a script. */
function binOfLauncher(path: string, deps: ShellDeps): string | null {
  let at = path;
  for (let step = 0; step < MAX_LINKS; step += 1) {
    if (BIN_TS.test(at)) return at;
    const target = deps.readlink(at);
    if (target === null) break;
    at = isAbsolute(target) ? target : resolve(dirname(at), target);
  }
  const exec = /^\s*exec\s+\S*node\S*\s+(["']?)([^"'\s]+\/src\/bin\.ts)\1/m.exec(deps.read(at) ?? "");
  return exec === null ? null : expandHome(exec[2], deps.home);
}

/** The `src/bin.ts` a command line (an alias's words, a function's body) runs: a word that is one, else a word that is a launcher file. */
function binOfCommand(command: string, deps: ShellDeps): { bin: string | null; launcher: string | null } {
  const words = command.split(/\s+/).filter((word) => word !== "").map((word) => expandHome(word, deps.home));
  const direct = words.find((word) => BIN_TS.test(word));
  if (direct !== undefined) return { bin: direct, launcher: null };
  const launcher = words.find((word) => isAbsolute(word) && (deps.read(word) !== null || deps.readlink(word) !== null));
  return { bin: launcher === undefined ? null : binOfLauncher(launcher, deps), launcher: launcher ?? null };
}

const ALIAS_LINE = /^\s*alias\s+(?:-\S+\s+)?agent-org=/;
const FUNCTION_LINE = /^\s*(?:function\s+agent-org\b|agent-org\s*\(\s*\))/;
const SOURCE_LINE = /^\s*(?:source|\.)\s+(["']?)([^"'\s;]+)\1/;

/** The start-up files a login, interactive shell reads, in the order it reads them. */
function startupFiles(shell: string, deps: ShellDeps): string[] {
  const zsh = basename(shell) === "zsh";
  const directory = zsh ? deps.env.ZDOTDIR ?? deps.home : deps.home;
  const names = zsh ? [".zshenv", ".zprofile", ".zshrc", ".zlogin"] : [".bash_profile", ".bash_login", ".profile", ".bashrc"];
  return names.map((name) => `${directory}/${name}`);
}

/** Every definition of `agent-org` of this kind in `file` and the files it sources (one level deep), in reading order. */
function definitionsIn(file: string, kind: "alias" | "function", deps: ShellDeps, depth = 0): Definition[] {
  const lines = (deps.read(file) ?? "").split("\n");
  const found: Definition[] = [];
  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    if ((kind === "alias" ? ALIAS_LINE : FUNCTION_LINE).test(line)) found.push({ file, line: index + 1 });
    const sourced = SOURCE_LINE.exec(line);
    if (sourced !== null && depth < 1) found.push(...definitionsIn(expandHome(sourced[2], deps.home), kind, deps, depth + 1));
  });
  return found;
}

/** The definition of an alias or function that wins: the last one the shell reads. Null when no start-up file defines it. */
export function findDefinition(shell: string, kind: "alias" | "function", deps: ShellDeps): Definition | null {
  return startupFiles(shell, deps).flatMap((file) => definitionsIn(file, kind, deps)).at(-1) ?? null;
}

/** The body of a function whose definition is at `defined`: its line, up to the closing line, for the words it runs. */
function bodyAt(defined: Definition | null, deps: ShellDeps): string {
  if (defined === null || defined.line === null) return "";
  const lines = (deps.read(defined.file) ?? "").split("\n").slice(defined.line - 1);
  const end = lines.findIndex((line, index) => (index === 0 ? /\}\s*$/.test(line) && line.includes("{") : line.trim() === "}"));
  return lines.slice(0, end < 0 ? 1 : end + 1).join("\n");
}

function readingOf(said: Said, shell: string, deps: ShellDeps): ShellReading {
  const defined = said.kind === "file" ? { file: said.path, line: null } : findDefinition(shell, said.kind, deps);
  const command = said.kind === "alias" ? said.command : said.kind === "function" ? `${said.body}\n${bodyAt(defined, deps)}` : said.path;
  const { bin, launcher } = said.kind === "file" ? { bin: binOfLauncher(said.path, deps), launcher: said.path } : binOfCommand(command, deps);
  const copyRoot = bin === null ? null : dirname(dirname(bin));
  const text = said.kind === "alias" ? said.command : said.kind === "function" ? "a shell function" : said.path;
  return { kind: said.kind, said: text, launcher, copyRoot, defined, comparison: copyRoot === null ? null : deps.compare(copyRoot) };
}

/**
 * What `agent-org` runs in the person's login shell, or why that could not be read. With `SHELL` unset, the first `agent-org` on PATH.
 */
export function readShellCommand(deps: ShellDeps): ShellReading {
  const shell = deps.env.SHELL ?? "";
  if (shell === "") {
    const found = deps.which("agent-org");
    return found === null ? { kind: "absent" } : readingOf({ kind: "file", path: found }, shell, deps);
  }
  const text = deps.type(shell);
  if (text === null) return { kind: "unreadable", reason: `${shell} could not be asked what \`agent-org\` is (it did not answer within ${SHELL_TIMEOUT_MS / 1000} seconds, or could not start)` };
  const said = parseSaid(text);
  if (said === "absent") return { kind: "absent" };
  return said === null ? { kind: "unreadable", reason: `${shell} answered \`type agent-org\` with nothing this check understands: ${text.trim().split("\n").at(-1)}` } : readingOf(said, shell, deps);
}

/** What the judgement needs besides the reading. `devTool` is host.json's setting; `binDir` is where the shim lives. */
export type ShellContext = Readonly<{ tool: string; binDir: string; devTool: string | null; home: string }>;

const TYPE_FIX = "run `type agent-org` in your shell to see what it runs";

const ARTICLE: Record<"alias" | "function" | "file", string> = { alias: "an alias", function: "a shell function", file: "the file on PATH" };

/** The versions a failing copy is set against, in words. */
function versionsOf(comparison: CopyComparison | null): string {
  if (comparison === null || comparison.kind === "no-install") return "";
  if (comparison.kind === "installed") return ", which `current` names today but will leave behind at the next update";
  return ` (${comparison.copy}, against the installed ${comparison.installed})`;
}

function failureOf(reading: Extract<ShellReading, { copyRoot: string | null }>, context: ShellContext): Check {
  const { tool, binDir, home, devTool } = context;
  const current = currentLink(tool);
  const where = reading.defined === null ? "defined somewhere I could not find in your start-up files" : reading.kind === "file" ? `the file is ${tilde(reading.defined.file, home)}`
    : `defined at ${tilde(reading.defined.file, home)}:${reading.defined.line}`;
  const runs = reading.copyRoot === null ? `something that is not a copy of the tool I could match (${reading.said})` : `${tilde(reading.copyRoot, home)}${versionsOf(reading.comparison)}`;
  const newer = reading.comparison?.kind === "newer-or-same" && devTool === null ? " A checkout used on purpose for development is allowed when host.json names it as `devTool`." : "";
  const command = `node ${tilde(current, home)}/src/bin.ts command:check --fix`;
  const edit = reading.kind === "file" ? `replaces ${tilde(reading.defined?.file ?? binDir, home)} with the shim` : `comments out that definition`;
  return {
    name: COMMAND_CHECK_NAME, ok: false,
    detail: `\`agent-org\` in your shell is ${ARTICLE[reading.kind]}, ${where}; it runs ${runs}, not the installed tool (${tilde(current, home)}).${newer}`,
    fix: `run \`${command}\`, which ${edit} (a backup of the file is kept) and installs ${tilde(binDir, home)}/agent-org, the shim that always runs ${tilde(current, home)}`,
  };
}

const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b);

/** The row for the reading: ok when it runs the installed tool through `current` (or a newer development checkout host.json names), a warning when the shell cannot say, else failed. */
export function judgeShellCommand(reading: ShellReading, context: ShellContext): Check {
  const { tool, binDir, home, devTool } = context;
  const current = currentLink(tool);
  if (reading.kind === "unreadable") return { name: COMMAND_CHECK_NAME, ok: true, warning: true, detail: reading.reason, fix: TYPE_FIX };
  if (reading.kind === "absent") {
    return { name: COMMAND_CHECK_NAME, ok: true, warning: true, detail: "your login shell finds no `agent-org`", fix: `add ${tilde(binDir, home)} to PATH: export PATH="${tilde(binDir, home)}:$PATH" in your shell's rc file` };
  }
  const where = reading.defined === null || reading.defined.line === null ? "" : ` (${tilde(reading.defined.file, home)}:${reading.defined.line})`;
  if (reading.copyRoot !== null && samePath(reading.copyRoot, current)) {
    return { name: COMMAND_CHECK_NAME, ok: true, detail: `${ARTICLE[reading.kind]}${where} runs the installed tool through ${tilde(current, home)}`, fix: null };
  }
  const development = reading.copyRoot !== null && devTool !== null && samePath(reading.copyRoot, devTool) && reading.comparison?.kind === "newer-or-same";
  if (development) return { name: COMMAND_CHECK_NAME, ok: true, detail: `${ARTICLE[reading.kind]}${where} runs ${tilde(devTool, home)}, the development checkout host.json names, and it is at least as new as the installed tool`, fix: null };
  return failureOf(reading, context);
}

/**
 * The context for the judgement from the host file's text (null when there is none) and the environment: `devTool` is the host file's setting (an absolute path to a checkout used for
 * development), and `binDir` is `$AGENT_ORG_BIN_DIR`, else the host file's `binDir`, else `~/.local/bin`. A host file that does not parse sets neither.
 */
export function shellContext(env: Env, home: string, hostText: string | null): ShellContext {
  let host: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(hostText ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) host = parsed as Record<string, unknown>;
  } catch {
    host = {};
  }
  const absolute = (value: unknown): string | null => (typeof value === "string" && isAbsolute(value) ? value : null);
  return { tool: toolDir(env, home), binDir: absolute(env.AGENT_ORG_BIN_DIR) ?? absolute(host.binDir) ?? join(home, ".local", "bin"), devTool: absolute(host.devTool), home };
}
