// @ts-check
// module: put the installed shim where the person's shell finds `agent-org`, keeping a backup of what it replaces (A11-285)
//
// A start-up file is the person's own, so the fix is careful with it. It writes a copy of the WHOLE file beside it (`<file>.before-agent-org-<stamp>`, the file's own bytes) and then comments the
// definition out under a marker that says what replaced it; it never deletes a line. It edits only a definition that is a statement of its own (an alias alone on its line, a function whose body it
// can close), and asks the shell to accept the edited file (`<shell> -n`): a file the shell refuses is put back as it was. A file on PATH is renamed to its backup and the shim written in its place.
// Nothing outside the home folder is touched (a start-up file that is a link is followed to where it lives), and the launcher an org host's `host:install` owns is left to it.
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shimTextFor, writeLauncher } from "./launcher.ts";
import { tilde, type ShellReading } from "./shell-command.ts";
import { currentLink } from "./tool-versions.ts";

const FILE_MODE = 0o644;
/** An alias that is a statement of its own: nothing before it on the line, its value closed, at most a comment after it. */
const STANDALONE_ALIAS = /^\s*alias\s+(?:-\S+\s+)?agent-org=(?:'[^']*'|"[^"]*"|\S+)\s*(?:#.*)?$/;

export type FixDeps = Readonly<{
  home: string;
  binDir: string;
  tool: string;
  now: () => Date;
  /** The host declares a project, so `host:install` owns the launcher in `binDir`. */
  orgHost: boolean;
  /** Whether the shell accepts the edited start-up file as a script. */
  accepts: (file: string) => boolean;
}>;

/** What the fix did: a line for each change, and why it left the rest (null when it left nothing). */
export type FixResult = Readonly<{ done: string[]; refused: string | null }>;

const refuse = (why: string): FixResult => ({ done: [], refused: why });
const stampOf = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");
const insideHome = (path: string, home: string): boolean => resolve(path).startsWith(`${resolve(home)}/`);
/** Text as the bytes of a start-up file carry it: each byte one character, so a file is edited and written back exactly. */
const asBytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
const BRACES = /[{}]/g;

/** The path a start-up file really lives at, when that is inside the home folder (a link into a dotfiles folder is). Null when it is not, or does not resolve. */
function realInsideHome(file: string, home: string): string | null {
  try {
    const real = realpathSync(file);
    return insideHome(real, realpathSync(home)) ? real : null;
  } catch {
    return null;
  }
}

/** Whether the definition on `line` closes on that same line: it has a `{` and as many `}` as `{`. */
const closesOnItsLine = (line: string): boolean => {
  const braces: string[] = line.match(BRACES) ?? [];
  return braces.includes("{") && braces.filter((brace) => brace === "{").length === braces.filter((brace) => brace === "}").length;
};

/** The last line of a function that starts at `lines[start]`: that line when it closes there, else the first line that is `}` alone. -1 when the body never closes. */
function functionEnd(lines: readonly string[], start: number): number {
  if (closesOnItsLine(lines[start])) return start;
  const close = lines.slice(start + 1).findIndex((line) => line.trim() === "}");
  return close < 0 ? -1 : start + 1 + close;
}

/** The lines `start`..`end` commented out under the marker, or null when the definition cannot be edited safely. */
function commentedLines({ lines, start, kind }: Readonly<{ lines: readonly string[]; start: number; kind: "alias" | "function" }>): { end: number } | string {
  if (kind === "alias") {
    return STANDALONE_ALIAS.test(lines[start]) ? { end: start } : "the alias shares its line with other commands, or runs past it, so commenting the line out could change more than the alias";
  }
  const end = functionEnd(lines, start);
  return end < 0 ? "the function has no closing `}` line of its own" : { end };
}

/** Comments out the alias or function at `defined`, under a marker, after keeping the file; puts the file back when the shell refuses the result. */
function commentOut(reading: Extract<ShellReading, { defined: unknown }>, deps: FixDeps): FixResult {
  const { defined } = reading;
  if (defined === null || defined.line === null || reading.kind === "file") {
    return refuse("I could not find where `agent-org` is defined in your start-up files, so they are left as they are; remove it yourself (`type agent-org` shows what it is)");
  }
  const where = `${tilde(defined.file, deps.home)}:${defined.line}`;
  const real = realInsideHome(defined.file, deps.home);
  if (real === null) return refuse(`${where} is outside your home folder (or cannot be read), so it is left as it is; remove that definition with the privileges the file needs`);
  const original = readFileSync(real);
  const lines = original.toString("latin1").split("\n");
  const start = defined.line - 1;
  const span = commentedLines({ lines, start, kind: reading.kind });
  if (typeof span === "string") return refuse(`${where}: ${span}, so it is left as it is; remove it yourself`);
  const now = deps.now();
  const backup = `${defined.file}.before-agent-org-${stampOf(now)}`;
  const marker = asBytes(`# agent-org (A11-285): replaced by the installed command ${tilde(join(deps.binDir, "agent-org"), deps.home)} on ${now.toISOString().slice(0, 10)}; was:`);
  const edited = [...lines.slice(0, start), marker, ...lines.slice(start, span.end + 1).map((line) => `# ${line}`), ...lines.slice(span.end + 1)].join("\n");
  try {
    writeFileSync(backup, original, { mode: statSync(real).mode & 0o777 || FILE_MODE, flag: "wx" });
    writeFileSync(real, Buffer.from(edited, "latin1"));
  } catch (cause) {
    rmSync(backup, { force: true });
    return refuse(`${where} could not be edited (${(cause as Error).message}), so it is left as it is`);
  }
  if (!deps.accepts(real)) {
    writeFileSync(real, original);
    rmSync(backup, { force: true });
    return refuse(`commenting out ${where} would leave a file your shell refuses (it is part of a larger construct), so it is left as it is; remove it yourself`);
  }
  return { done: [`commented out ${where} (the whole file is kept as ${tilde(backup, deps.home)})`], refused: null };
}

/** Replaces the file on PATH that is not the shim with the shim, keeping the file as its backup. */
function replaceFile(path: string, deps: FixDeps): FixResult {
  const shim = join(deps.binDir, "agent-org");
  if (deps.orgHost && resolve(path) === resolve(shim)) {
    return refuse(`${tilde(path, deps.home)} is the launcher \`agent-org host:install\` owns on this host; run \`node ${currentLink(deps.tool)}/src/bin.ts host:install\` to rewrite it`);
  }
  if (realInsideHome(dirname(path), deps.home) === null || !insideHome(path, deps.home)) {
    return refuse(`${path} is outside your home folder, so it is left as it is; replace it yourself with \`sudo install -m 755 ${shim} ${path}\`, or put ${tilde(deps.binDir, deps.home)} ahead of ${dirname(path)} on PATH`);
  }
  const backup = `${path}.before-agent-org-${stampOf(deps.now())}`;
  renameSync(path, backup);
  writeLauncher(path, shimTextFor(deps.tool));
  return { done: [`replaced ${tilde(path, deps.home)} with the installed shim (the file it replaced is kept as ${tilde(backup, deps.home)})`], refused: null };
}

/** The shim in `binDir`, written when there is none (and the host's `host:install` does not own it). Never replaces one that is there: a stale one is a file on PATH, and the next pass replaces it. */
function ensureShim(deps: FixDeps): string[] {
  const shim = join(deps.binDir, "agent-org");
  if (deps.orgHost || existsSync(shim)) return [];
  writeLauncher(shim, shimTextFor(deps.tool));
  return [`wrote the installed shim ${tilde(shim, deps.home)}`];
}

/** Fixes one reading that is not the installed tool: the alias, function or PATH file it names is replaced, with a backup, and the shim is in `binDir`. */
export function fixShellCommand(reading: ShellReading, deps: FixDeps): FixResult {
  if (reading.kind === "unreadable" || reading.kind === "absent") return { done: ensureShim(deps), refused: null };
  if (reading.kind === "file" && reading.launcher === null) return refuse("the file on PATH could not be named, so it is left as it is");
  const replaced = reading.kind === "file" ? replaceFile(reading.launcher as string, deps) : commentOut(reading, deps);
  return replaced.refused === null ? { done: [...replaced.done, ...ensureShim(deps)], refused: null } : replaced;
}
