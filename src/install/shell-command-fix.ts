// @ts-check
// module: put the installed shim where the person's shell finds `agent-org`, keeping a backup of what it replaces (A11-285)
//
// A start-up file is the person's own. The fix never deletes a line: it writes a copy of the WHOLE file beside it (`<file>.before-agent-org-<stamp>`), then comments the definition out under a
// marker that says what replaced it. A file on PATH is renamed to its backup and the shim written in its place. A file outside the home folder is never touched: it needs privileges the
// install does not take, so the fix names the command instead.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shimTextFor, writeLauncher } from "./launcher.ts";
import { tilde, type ShellReading } from "./shell-command.ts";

const FILE_MODE = 0o644;

export type FixDeps = Readonly<{ home: string; binDir: string; tool: string; now: () => Date }>;

/** What the fix did: a line for each change, and why it left the rest (null when it left nothing). */
export type FixResult = Readonly<{ done: string[]; refused: string | null }>;

const stampOf = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");
const insideHome = (path: string, home: string): boolean => path.startsWith(`${home}/`);

/** The last line of a function that starts at `lines[start]`: that line when it closes there, else the first line that is `}` alone. -1 when the body never closes. */
function functionEnd(lines: readonly string[], start: number): number {
  if (lines[start].includes("{") && /\}\s*$/.test(lines[start])) return start;
  const close = lines.slice(start + 1).findIndex((line) => line.trim() === "}");
  return close < 0 ? -1 : start + 1 + close;
}

/** Writes `text` to a file beside `path` named for the backup, with the bytes `original` had. Returns the backup's path. */
function backupOf(path: string, original: string, now: Date): string {
  const backup = `${path}.before-agent-org-${stampOf(now)}`;
  writeFileSync(backup, original, { mode: existsSync(path) ? statSync(path).mode & 0o777 : FILE_MODE, flag: "wx" });
  return backup;
}

/** Comments out the alias or function at `defined`, under a marker, after backing the file up. */
function commentOut(reading: Extract<ShellReading, { defined: unknown }>, deps: FixDeps): FixResult {
  const { defined } = reading;
  const shim = tilde(join(deps.binDir, "agent-org"), deps.home);
  if (defined === null || defined.line === null) {
    return { done: [], refused: `I could not find where \`agent-org\` is defined in your start-up files, so they are left as they are; remove it yourself (\`type agent-org\` shows what it is)` };
  }
  const where = `${tilde(defined.file, deps.home)}:${defined.line}`;
  if (!insideHome(defined.file, deps.home)) return { done: [], refused: `${where} is outside your home folder, so it is left as it is; remove that definition with the privileges the file needs` };
  const original = readFileSync(defined.file, "utf8");
  const lines = original.split("\n");
  const start = defined.line - 1;
  const end = reading.kind === "function" ? functionEnd(lines, start) : start;
  if (end < 0) return { done: [], refused: `the function at ${where} has no closing \`}\` line of its own, so it is left as it is; remove it yourself` };
  const backup = backupOf(defined.file, original, deps.now());
  const marker = `# agent-org (A11-285): replaced by the installed command ${shim} on ${deps.now().toISOString().slice(0, 10)}; was:`;
  const commented = lines.slice(start, end + 1).map((line) => `# ${line}`);
  writeFileSync(defined.file, [...lines.slice(0, start), marker, ...commented, ...lines.slice(end + 1)].join("\n"), { mode: statSync(defined.file).mode & 0o777 });
  return { done: [`commented out ${where} (the whole file is kept as ${tilde(backup, deps.home)})`], refused: null };
}

/** Replaces the file on PATH that is not the shim with the shim, keeping the file as its backup. */
function replaceFile(path: string, deps: FixDeps): FixResult {
  if (!insideHome(path, deps.home)) {
    return { done: [], refused: `${path} is outside your home folder, so it is left as it is; replace it yourself with \`sudo install -m 755 ${join(deps.binDir, "agent-org")} ${path}\`, or put ${tilde(deps.binDir, deps.home)} ahead of ${dirname(path)} on PATH` };
  }
  const backup = `${path}.before-agent-org-${stampOf(deps.now())}`;
  renameSync(path, backup);
  writeLauncher(path, shimTextFor(deps.tool));
  return { done: [`replaced ${tilde(path, deps.home)} with the installed shim (the file it replaced is kept as ${tilde(backup, deps.home)})`], refused: null };
}

/** The shim in `binDir`, written when there is none. Never replaces one that is there: a stale one is a file on PATH, and the next pass replaces it with its backup. */
function ensureShim(deps: FixDeps): string[] {
  const shim = join(deps.binDir, "agent-org");
  if (existsSync(shim)) return [];
  writeLauncher(shim, shimTextFor(deps.tool));
  return [`wrote the installed shim ${tilde(shim, deps.home)}`];
}

/** Fixes one reading that is not the installed tool: the alias, function or PATH file it names is replaced, with a backup, and the shim is in `binDir`. */
export function fixShellCommand(reading: ShellReading, deps: FixDeps): FixResult {
  if (reading.kind === "unreadable" || reading.kind === "absent") return { done: ensureShim(deps), refused: null };
  const replaced = reading.kind === "file" ? replaceFile(reading.launcher ?? reading.defined?.file ?? "", deps) : commentOut(reading, deps);
  return replaced.refused === null ? { done: [...replaced.done, ...ensureShim(deps)], refused: null } : replaced;
}
