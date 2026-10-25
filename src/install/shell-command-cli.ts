// @ts-check
// command: command:check -- check that the `agent-org` your shell runs is the installed tool, and with `--fix` replace what is not (an alias, a function or a file on PATH) with the installed shim, keeping a backup of the file
//
// `install.sh` and `onboard` run this at the end of every install (A11-285): the install does not report success while the person's `agent-org` would run another copy. It is the same reading and
// judgement as doctor's `agent-org command` row (`shell-command.ts`) and the same fix (`shell-command-fix.ts`). Exit 0 when the row is ok (or only a warning), 1 when it is not, 2 for a refused argument.
//
//   agent-org command:check              read and judge, change nothing
//   agent-org command:check --fix        replace what is wrong, then read again
//   agent-org command:check --fix --ask   ask first on /dev/tty; with no terminal to ask on, replace without asking and say so
//
// The fix is meant to be run as `node <tool>/current/src/bin.ts command:check --fix`: the `agent-org` a person types may be the very thing that is wrong.
import { closeSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fixShellCommand, type FixDeps } from "./shell-command-fix.ts";
import { judgeShellCommand, readShellCommand, realShellDeps, shellContext, syntaxOk, type CommandCheck, type ShellContext, type ShellDeps } from "./shell-command.ts";
import { hostFilePath, readOrNull, type Env } from "./paths.ts";

const OK = 0;
const NOT_OK = 1;
const REFUSED = 2;
const MAX_PASSES = 3;
const ANSWERED_NO = /^\s*n/i;
const PROMPT = "Replace it with the installed command? A backup is kept. [Y/n] ";

/** What the fix needs of this machine: the context's folders, the clock, and the person's shell to accept an edited start-up file. */
export const fixDepsFor = (context: ShellContext, env: Env, now: () => Date): FixDeps => ({
  home: context.home, binDir: context.binDir, tool: context.tool, now, orgHost: context.orgHost, accepts: (file) => syntaxOk(env.SHELL ?? "", file),
});

export type CheckIo = Readonly<{
  shell: ShellDeps;
  context: ShellContext;
  fix: FixDeps;
  /** Asks the person; true to go on, false to stop, null when there is nobody to ask. */
  confirm: () => boolean | null | Promise<boolean | null>;
}>;

/** What a run found and did. `before` is the row as the shell showed it, `after` the row once the fix was tried (the same row when nothing was fixed). */
export type CheckOutcome = Readonly<{
  before: CommandCheck;
  after: CommandCheck;
  /** One line for each change made. */
  fixed: string[];
  /** Why the fix stopped, or null. */
  refused: string | null;
  /** The person was asked and said no. */
  declined: boolean;
  /** `--ask` was given and there was nobody to ask, so the fix went ahead without asking. */
  unasked: boolean;
}>;

/** The row as lines a person (or `install.sh`) reads: a mark, the detail, and the fix under a failing one. */
function rowLines(row: CommandCheck): string[] {
  const mark = row.ok ? (row.warning === true ? "!" : "✓") : "✗";
  return [`${mark} ${row.name}: ${row.detail}`, ...(row.ok && row.warning !== true ? [] : [`    fix: ${row.fix ?? ""}`])];
}

/** Asks on the terminal itself (not stdin, which `curl | bash` has taken). Null when there is no terminal. */
export function confirmOnTerminal(): boolean | null {
  let tty: number;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    writeSync(tty, PROMPT);
    const buffer = Buffer.alloc(64);
    const answer = buffer.toString("utf8", 0, readSync(tty, buffer, 0, buffer.length, null));
    return !ANSWERED_NO.test(answer);
  } finally {
    closeSync(tty);
  }
}

const judged = (io: CheckIo): CommandCheck => judgeShellCommand(readShellCommand(io.shell), io.context);

/** Fixes until the row is ok, a pass refuses, or the passes run out: an alias first, then the file on PATH it was hiding. */
function fixUntilOk(io: CheckIo, first: CommandCheck): Pick<CheckOutcome, "after" | "fixed" | "refused"> {
  const fixed: string[] = [];
  let row = first;
  for (let pass = 0; pass < MAX_PASSES && !row.ok; pass += 1) {
    const result = fixShellCommand(readShellCommand(io.shell), io.fix);
    fixed.push(...result.done);
    if (result.refused !== null) return { after: row, fixed, refused: result.refused };
    row = judged(io);
  }
  return { after: row, fixed, refused: null };
}

/**
 * Reads what the shell runs; with `fix`, replaces what is not the installed tool (asking first with `ask`) and reads again. A row that is a warning passes.
 */
export async function checkCommand({ fix, ask }: Readonly<{ fix: boolean; ask: boolean }>, io: CheckIo): Promise<CheckOutcome> {
  const before = judged(io);
  const none = { after: before, fixed: [], refused: null, declined: false, unasked: false };
  if (before.ok || !fix) return { before, ...none };
  const answer = ask ? await io.confirm() : true;
  if (answer === false) return { before, ...none, declined: true };
  return { before, ...fixUntilOk(io, before), declined: false, unasked: ask && answer === null };
}

/** The lines the command prints for an outcome. */
export function outcomeLines({ before, after, fixed, refused, declined, unasked }: CheckOutcome): string[] {
  return [
    ...rowLines(before),
    ...(unasked ? ["  no terminal to ask on, so it is replaced without asking"] : []),
    ...fixed.map((line) => `  fixed: ${line}`),
    ...(declined ? ["  left as it is"] : []),
    ...(refused === null ? [] : [`  refused: ${refused}`]),
    ...(after === before ? [] : rowLines(after)),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { fix: { type: "boolean" }, ask: { type: "boolean" } } });
    const home = homedir();
    const context = shellContext(process.env, home, readOrNull(hostFilePath(process.env, home, readOrNull)));
    const io: CheckIo = { shell: realShellDeps(process.env, home, context.tool), context, fix: fixDepsFor(context, process.env, () => new Date()), confirm: confirmOnTerminal };
    const outcome = await checkCommand({ fix: values.fix === true, ask: values.ask === true }, io);
    console.log(outcomeLines(outcome).join("\n"));
    process.exitCode = outcome.after.ok ? OK : NOT_OK;
  } catch (cause) {
    console.error(`command:check: ${(cause as Error).message}`);
    process.exitCode = REFUSED;
  }
}
