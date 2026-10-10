// A fixed measurement (`count X at time T`) is a scheduled script, not a held session (#4639, class timed-reading-holds-a-worker).
//
// #3870's `git worktree list | wc -l` sat with an engineer for a day while the gate deferred other ready rows for lack of one. It is
// plumbing, not judgment: the row declares the command, the checkout and the schedule, and this module runs the reading when it is due
// and posts the number back on the row.
//
// THREE MORE LINE-ANCHORED FIELDS in the BODY, beside `Reading: <n> at T` (`reading-schedule.ts`, #4638):
//   `Reading-script: <command>`        which measurement -- ONLY a command on ALLOWED_SCRIPTS, never a shell string
//   `Reading-checkout: <name>`         the repository checkout it is read in, a directory name under the repos root
//   `Reading-expect: [<op>] <integer>` optional bound, `<= >= < > ==`; a bare integer means `==`
// A row with no `Reading-script:` is a hand-taken reading row and this module ignores it.
//
// THE RECORD IS THE RECEIPT. The comment carries `Reading <n> posted` (the line the schedule reads) AND the row's
// `Reading <n>: <value> (<command>, <timestamp>)`, so one comment advances the schedule and states the number. The bound is only SAID on
// the row: closing stays with the row's owner.
//
// NOTHING IS RUN FROM TEXT. The allowlist maps the declared command to a function that spawns `git` with an argument vector and counts
// the lines itself, so there is no shell to inject into and a script outside the list is refused, with the reason, before anything runs.
// The tick, the clock, the rows and the poster are all arguments: this file reaches no network and no `corpus`.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { readingsDeclared, readingsPosted } from "./reading-schedule.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** What a reading needs of a row: its number, body and comments. */
export type ScheduledRow = {
  number: number;
  body: string | null | undefined;
  comments: readonly { body?: string | null }[] | null | undefined;
};

/** Spawns `file` with `args` in `cwd` and resolves the stdout. Injected so a test spawns nothing. */
export type RunCommand = (file: string, args: readonly string[], cwd: string) => Promise<string>;

export type ExpectVerdict =
  | { kind: "met"; bound: string }
  | { kind: "not-met"; bound: string }
  | { kind: "unreadable"; text: string };

/** What one pass did with one row. `none` is a row that is not scheduled, or whose every reading is posted. */
export type ReadingRun =
  | { kind: "none" }
  | { kind: "not-due"; n: number; at: string }
  | { kind: "refused"; n: number | null; reason: string }
  | { kind: "failed"; n: number; reason: string }
  | { kind: "posted"; n: number; value: number; comment: string; verdict: ExpectVerdict | null };

export type TakeDueReadingDeps = {
  now: number;
  post: (rowNumber: number, comment: string) => Promise<void>;
  run?: RunCommand;
  reposRoot?: string;
};

type Measurement = (checkout: string, run: RunCommand) => Promise<number>;

/** Lines in `git worktree list`, counted exactly as `wc -l` counts them: newline characters. */
const countWorktrees: Measurement = async (checkout, run) => {
  const out = await run("git", ["-C", checkout, "worktree", "list"], checkout);
  return (out.match(/\n/g) ?? []).length;
};

/** THE ALLOWLIST: one entry to start. Adding one is a reviewed change to this table, never a row's choice. */
const ALLOWED_SCRIPTS: Readonly<Record<string, Measurement>> = {
  "git worktree list | wc -l": countWorktrees,
};

/** The commands a row may declare, for a test to pin and a refusal to name. */
export const ALLOWED_COMMANDS: readonly string[] = Object.keys(ALLOWED_SCRIPTS);

const FIELD = (name: string) => new RegExp(`^[ \\t]*#{0,6}[ \\t]*${name}:[ \\t]*(.+?)[ \\t]*$`, "im");
const SCRIPT_FIELD = FIELD("Reading-script");
const CHECKOUT_FIELD = FIELD("Reading-checkout");
const EXPECT_FIELD = FIELD("Reading-expect");
/** A directory NAME: no separator and no leading dot, so the field cannot walk out of the repos root. */
const CHECKOUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXPECT_BOUND = /^(<=|>=|==|<|>|=)?[ \t]*(\d+)$/;

/** The first matching line's value, with one wrapping pair of backticks removed (a row is markdown). First wins, as `Reading:` does. */
function fieldValue(body: string | null | undefined, field: RegExp): string | null {
  const raw = field.exec(String(body ?? ""))?.[1];
  if (raw === undefined) return null;
  return raw.replace(/^`([^`]*)`$/, "$1").trim();
}

const normalizeCommand = (text: string) => text.replace(/\s+/g, " ");

/** The comparison said on the row, or `null` when the row declares no bound. A bound nobody can read is SAID, not skipped. */
export function judgeExpectation(body: string | null | undefined, value: number): ExpectVerdict | null {
  const text = fieldValue(body, EXPECT_FIELD);
  if (text === null) return null;
  const m = EXPECT_BOUND.exec(text);
  if (!m) return { kind: "unreadable", text };
  const op = m[1] === "=" || m[1] === undefined ? "==" : m[1];
  const limit = Number(m[2]);
  const holds = { "<=": value <= limit, ">=": value >= limit, "<": value < limit, ">": value > limit, "==": value === limit }[op];
  return { kind: holds ? "met" : "not-met", bound: `${op} ${limit}` };
}

function verdictLine(verdict: ExpectVerdict | null, value: number): string | null {
  if (verdict === null) return null;
  if (verdict.kind === "unreadable") return `Expected bound not understood (\`${verdict.text}\`), so nothing was compared; the reading stands.`;
  const outcome = verdict.kind === "met" ? "met" : `NOT met by ${value}`;
  return `Expected ${verdict.bound}: ${outcome}. Closing stays with the row's owner.`;
}

/** The two lines the row's record needs, plus the bound's verdict when one was declared. */
export function readingComment(args: { n: number; value: number; command: string; at: string; verdict: ExpectVerdict | null }): string {
  const stamp = `${new Date(args.at).toISOString().slice(0, 19)}Z`;
  const lines = [`Reading ${args.n} posted`, `Reading ${args.n}: ${args.value} (${args.command}, ${stamp})`];
  const said = verdictLine(args.verdict, args.value);
  return (said === null ? lines : [...lines, said]).join("\n");
}

type Declaration = { command: string; measure: Measurement; checkout: string };

/** The row's declaration, or the reason it cannot be run. Checked BEFORE the clock so a bad row is refused when filed, not when due. */
function declarationOf(row: ScheduledRow, reposRoot: string): Declaration | { refused: string } {
  const command = normalizeCommand(fieldValue(row.body, SCRIPT_FIELD) ?? "");
  const measure = Object.hasOwn(ALLOWED_SCRIPTS, command) ? ALLOWED_SCRIPTS[command] : undefined;
  if (!measure) {
    return { refused: `Reading-script \`${command}\` is not on the allowlist (${ALLOWED_COMMANDS.map((c) => `\`${c}\``).join(", ")}); nothing was run.` };
  }
  const name = fieldValue(row.body, CHECKOUT_FIELD);
  if (name === null) return { refused: `Reading-script \`${command}\` needs a \`Reading-checkout: <name>\` line to say which repository it is read in; nothing was run.` };
  if (!CHECKOUT_NAME.test(name)) return { refused: `Reading-checkout \`${name}\` is not a directory name under ${reposRoot}; nothing was run.` };
  return { command, measure, checkout: join(reposRoot, name) };
}

/** The first declared reading with no receipt on the row, or `null` when every one is posted. */
function nextOwed(row: ScheduledRow): { n: number; at: string } | null {
  const posted = readingsPosted(row.comments);
  return readingsDeclared(row.body).find((r) => !posted.has(r.n)) ?? null;
}

const defaultRun: RunCommand = async (file, args, cwd) => {
  const { stdout } = await execFileAsync(file, [...args], {
    cwd,
    encoding: "utf8",
    env: sandboxGitEnv(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout;
};

/**
 * One pass over one row: when its next owed reading is due, run the declared script and post the record.
 * ONE reading per row per pass, so a tick that was down does not stamp two readings with one instant.
 * A failed script posts NOTHING (no receipt, so the next pass retries) and the reason comes back in the result.
 */
export async function takeDueReading(row: ScheduledRow, deps: TakeDueReadingDeps): Promise<ReadingRun> {
  if (fieldValue(row.body, SCRIPT_FIELD) === null) return { kind: "none" };
  const declared = readingsDeclared(row.body);
  if (declared.length === 0) {
    return { kind: "refused", n: null, reason: "Reading-script is declared but the row has no `Reading: <n> at <time>` line, so there is nothing to run it for." };
  }
  const reposRoot = deps.reposRoot ?? join(homedir(), "repos");
  const declaration = declarationOf(row, reposRoot);
  const owed = nextOwed(row);
  if ("refused" in declaration) return { kind: "refused", n: owed?.n ?? null, reason: declaration.refused };
  if (owed === null) return { kind: "none" };
  if (Date.parse(owed.at) > deps.now) return { kind: "not-due", n: owed.n, at: owed.at };
  return measureAndPost(row, owed.n, declaration, deps);
}

async function measureAndPost(row: ScheduledRow, n: number, declaration: Declaration, deps: TakeDueReadingDeps): Promise<ReadingRun> {
  let value: number;
  try {
    value = await declaration.measure(declaration.checkout, deps.run ?? defaultRun);
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    return { kind: "failed", n, reason: `\`${declaration.command}\` failed in ${declaration.checkout}: ${why}` };
  }
  const verdict = judgeExpectation(row.body, value);
  const at = new Date(deps.now).toISOString();
  const comment = readingComment({ n, value, command: declaration.command, at, verdict });
  await deps.post(row.number, comment);
  return { kind: "posted", n, value, comment, verdict };
}
