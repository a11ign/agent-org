// @ts-check
// module: a file the host install replaces is kept beside its replacement, and what changed is said (A11-354)
//
// `install-reviewer-bin.sh` has always kept the door it replaces as `<door>.bak-<stamp>`. The other files `host:install` writes (the units, the tmpfiles rules, the launcher, the workers
// README, the `gh` wrapper) were overwritten without a trace, which was tolerable while a person ran it and read the diff first. The org now runs it itself after every update, so a file
// that somebody edited on the host is not lost: the previous text stays beside the new one, and the lines that differ go to the log the update writes.
//
// ONCE PER DISTINCT CONTENT, as the door's installer does: a text that is already kept beside the target is not kept again, so an install that runs every ten minutes over a host file
// that keeps coming back different cannot fill the directory.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The longest diff said in full: a launcher or a unit is a few lines, and a runaway one must not flood the update's log. */
const MAX_DIFF_LINES = 60;
/** A diff of more cells than this is not computed: the lines are counted instead. */
const MAX_DIFF_CELLS = 4_000_000;
/** The mode of a kept copy when the caller names none: a unit somebody edited by hand may carry a secret in an `Environment=` line, and the file it replaced may have been private. */
const PRIVATE = 0o600;
/** A line that sets a value named like a secret, to the `=`: what follows it is not said in a log. */
const SECRET_ASSIGNMENT = /((?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*=).*/i;

export type KeepDeps = Readonly<{
  read?: typeof readFileSync;
  readDir?: typeof readdirSync;
  write?: typeof writeFileSync;
  now?: () => Date;
  out?: (line: string) => void;
}>;

/** `20261027T211500Z`: the stamp `install-reviewer-bin.sh` puts on its copies. */
export const stampOf = (when: Date): string => when.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");

/** The text of `path`, or null when it is not there or cannot be read. */
export function textIfThere(path: string, read: typeof readFileSync = readFileSync): string | null {
  try {
    return String(read(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The lines that differ, `- ` for a line the previous text had and `+ ` for one the new text has, in order. The longest common subsequence is the unchanged part; a diff of a pair
 * too large to compare says how many lines each has instead.
 */
export function changedLines(previous: string, next: string): string[] {
  const [before, after] = [previous.split("\n"), next.split("\n")];
  if (before.length * after.length > MAX_DIFF_CELLS) return [`(too large to compare: ${before.length} lines became ${after.length})`];
  const width = after.length + 1;
  const common = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i * width + j] = before[i] === after[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const lines: string[] = [];
  let [i, j] = [0, 0];
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { i++; j++; continue; }
    if (j >= after.length || (i < before.length && common[(i + 1) * width + j] >= common[i * width + j + 1])) lines.push(`- ${before[i++]}`);
    else lines.push(`+ ${after[j++]}`);
  }
  return lines;
}

/** The diff as the lines to say: the first {@link MAX_DIFF_LINES}, and a count of the rest. */
function describeChange(previous: string, next: string): string[] {
  const lines = changedLines(previous, next).map((line) => line.replace(SECRET_ASSIGNMENT, "$1<not logged>"));
  return lines.length <= MAX_DIFF_LINES ? lines : [...lines.slice(0, MAX_DIFF_LINES), `(${lines.length - MAX_DIFF_LINES} more changed lines)`];
}

/** The names beside `target` that are copies kept of it, `<target>.bak-<stamp>`; none when the directory cannot be listed. */
function keptBeside(target: string, readDir: typeof readdirSync): string[] {
  try {
    return (readDir(dirname(target)) as unknown[]).map(String).filter((name) => name.startsWith(`${basename(target)}.bak-`));
  } catch {
    return [];
  }
}

/** `<target>.bak-<stamp>`, or with `-2`, `-3` ... when two different texts are kept within the same second: a copy kept is never overwritten. */
function uniqueName(target: string, stamp: string, taken: readonly string[]): string {
  const base = `${basename(target)}.bak-${stamp}`;
  const name = [base, ...Array.from({ length: taken.length + 1 }, (_, i) => `${base}-${i + 2}`)].find((candidate) => !taken.includes(candidate)) ?? base;
  return join(dirname(target), name);
}

/**
 * KEEP `previous`, the text `target` holds now, beside `target` before `next` replaces it, and say what changes. Nothing for a target that held nothing or already holds `next`.
 * @param {string} target the file that is about to be replaced
 * @param {{ previous: string | null, next: string }} change `previous` is what it holds now, read by the caller before it writes, and `next` what will replace it
 * @param {number} [mode] the mode of the copy kept: the target's own, so a kept program is still one
 * @returns the path of the copy kept, or null when none was needed or one is already there
 */
export function keepPrevious(target: string, { previous, next }: { previous: string | null; next: string }, deps: KeepDeps & { mode?: number } = {}): string | null {
  const { read = readFileSync, readDir = readdirSync, write = writeFileSync, now = () => new Date(), out = (line: string) => process.stdout.write(`${line}\n`), mode = PRIVATE } = deps;
  if (previous === null || previous === next) return null;
  for (const line of describeChange(previous, next)) out(`  ${target}: ${line}`);
  const taken = keptBeside(target, readDir);
  if (taken.some((name) => textIfThere(join(dirname(target), name), read) === previous)) {
    out(`kept nothing new beside ${target}: a copy of the previous text is already there`);
    return null;
  }
  const kept = uniqueName(target, stampOf(now()), taken);
  write(kept, previous, { mode });
  out(`kept the previous ${target} at ${kept}`);
  return kept;
}
