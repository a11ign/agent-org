// @ts-check
// command: batch several small grep/read/gh-jq checks into ONE call -- engineer.md's "batch related small
// checks into one command rather than several" habit, given a tool to reach for (#2690).
//
// #928 MEASURED 844 grep/sed/cat calls averaging ~0.6k of output each, late in a session where each one
// re-reads ~150k of accumulated context to answer one small question. This tool does not make any single
// check cheaper -- `git grep -n`, a `Read` range and `gh --jq` are already the cheap FORMS engineer.md
// names elsewhere in the same section. It answers the COUNT half instead: N of them run in one process pay
// the accumulated-context re-read ONCE rather than N times.
//
// A TASK LIST, NOT A DSL. Each task is one of the three checks an engineer already reaches for by hand
// (`grep`, `read`, `gh`), given as plain data -- so this file never has to parse a second command
// language: the caller already knows `git grep`/`Read`/`gh --jq`'s own syntax, and hands it here as a list
// instead of running each one as its own call.
//
// ONE TASK FAILING NEVER DISCARDS THE REST. A batch answering five questions where one `gh` call 404s is
// four real answers and one named failure, not a thrown exception that loses the four beside it.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// RELATIVE, not `@a11ign/screenreader-fleet/cli-flags` or `@a11ign/guards/git-env`: `agent-org` imports nothing
// outside its own package (#2658, ADR 0040 decision 4) -- these are its own copies, in `lib/`.
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.mjs";
import { sandboxGitEnv } from "./lib/git-env.mjs";

/** @typedef {{ kind: "grep", pattern: string, paths: string[], flags?: string[] }} GrepTask */
/** @typedef {{ kind: "read", path: string, offset?: number, limit?: number }} ReadTask */
/** @typedef {{ kind: "gh", args: string[] }} GhTask */
/** @typedef {GrepTask | ReadTask | GhTask} Task */
/** @typedef {{ task: Task, ok: true, output: string } | { task: Task, ok: false, error: string }} Result */

/** `Read`'s own default in engineer.md: a whole read only under about 200 lines. */
export const DEFAULT_READ_LIMIT = 200;

/** `gh`'s own output is capped, the same ceiling `prune-tmp.mjs`'s neighbours use for a `gh` read. */
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024;

/** @type {(cmd: string, args: string[], opts: import("node:child_process").ExecFileSyncOptions) => string} */
const defaultRun: (cmd: string, args: string[], opts: import("node:child_process").ExecFileSyncOptions) => string = (cmd, args, opts): string => /** @type {string} */ (execFileSync(cmd, args, opts));

/** The first line of whatever a caught spawn or read failure says. @param {unknown} cause @returns {string} */
function firstLine(cause: unknown): string {
  return String(/** @type {{ message?: unknown }} */ (cause)?.message ?? cause).split("\n")[0];
}

/**
 * One `git grep -n` task. Exit 1 is git's OWN "no match" answer, not a failure -- reported `ok: true` with
 * empty output, the same shape a caller reading a grep's silence by hand would see.
 * @param {GrepTask} task @param {{ cwd: string, run: typeof defaultRun }} ctx @returns {Result}
 */
export function runGrep(task: GrepTask, { cwd, run }: { cwd: string; run: typeof defaultRun; }): Result {
  try {
    const output = run("git", ["grep", "-n", ...(task.flags ?? []), "-e", task.pattern, "--", ...task.paths],
      { cwd, env: sandboxGitEnv(), encoding: "utf8" });
    return { task, ok: true, output };
  } catch (cause) {
    if (/** @type {{ status?: number }} */ (cause).status === 1) return { task, ok: true, output: "" };
    return { task, ok: false, error: firstLine(cause) };
  }
}

/**
 * One file range, matching engineer.md's "Read ranges, not files": 1-indexed `offset`, and never a whole
 * file by default.
 * @param {ReadTask} task @param {{ cwd: string, readFile: typeof readFileSync }} ctx @returns {Result}
 */
export function runRead(task: ReadTask, { cwd, readFile }: { cwd: string; readFile: typeof readFileSync; }): Result {
  try {
    const lines = /** @type {string} */ (readFile(join(cwd, task.path), "utf8")).split("\n");
    const offset = task.offset ?? 1;
    const limit = task.limit ?? DEFAULT_READ_LIMIT;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return { task, ok: true, output: slice.map((line, i) => `${offset + i}\t${line}`).join("\n") };
  } catch (cause) {
    return { task, ok: false, error: firstLine(cause) };
  }
}

/**
 * One `gh` call, run exactly as given -- the caller supplies its own `--jq`, matching engineer.md's "No
 * raw `gh` JSON where a projection answers"; this neither adds one nor refuses its absence, because not
 * every `gh` call is a JSON projection.
 * @param {GhTask} task @param {{ cwd: string, run: typeof defaultRun }} ctx @returns {Result}
 */
export function runGh(task: GhTask, { cwd, run }: { cwd: string; run: typeof defaultRun; }): Result {
  try {
    const output = run("gh", task.args, { cwd, encoding: "utf8", maxBuffer: MAX_GH_OUTPUT_BYTES });
    return { task, ok: true, output };
  } catch (cause) {
    return { task, ok: false, error: firstLine(cause) };
  }
}

/**
 * Every task, run and returned TOGETHER -- one call answering what would otherwise be N. An unrecognised
 * kind is refused as its OWN task, never thrown: one bad entry in a batch must not discard the rest.
 * @param {Task[]} tasks @param {{ cwd: string, run?: typeof defaultRun, readFile?: typeof readFileSync }} ctx
 * @returns {Result[]}
 */
export function survey(tasks: Task[], { cwd, run = defaultRun, readFile = readFileSync }: { cwd: string; run?: typeof defaultRun; readFile?: typeof readFileSync; }): Result[] {
  return tasks.map((task) => {
    if (task.kind === "grep") return runGrep(task, { cwd, run });
    if (task.kind === "read") return runRead(task, { cwd, readFile });
    if (task.kind === "gh") return runGh(task, { cwd, run });
    return { task, ok: false, error: `unknown task kind ${JSON.stringify(/** @type {any} */ (task).kind)}` };
  });
}

/** One task's own label, so a heading names what ran without reprinting the task JSON beside it.
 * @param {Task} task @returns {string} */
function labelOf(task: Task): string {
  if (task.kind === "grep") return `grep -e ${task.pattern} -- ${task.paths.join(" ")}`;
  if (task.kind === "read") return `read ${task.path}:${task.offset ?? 1}+${task.limit ?? DEFAULT_READ_LIMIT}`;
  return `gh ${task.args.join(" ")}`;
}

/**
 * The rendered batch: one heading and body per task, in the order given -- so a batch of five reads as
 * five answers, not one blob a reader has to re-split themselves.
 * @param {Result[]} results @returns {string}
 */
export function render(results: Result[]): string {
  return results.map((r) => `### ${labelOf(r.task)}\n${r.ok ? (r.output || "(no output)") : `ERROR: ${r.error}`}`).join("\n\n");
}

/** The task list from `--tasks=<file>`, or piped on stdin when that flag is absent. @returns {Task[]} */
function tasksFromArgv(): Task[] {
  const file = flagValue(process.argv, "tasks");
  const text = file !== undefined ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("survey: the task list must be a JSON array of { kind: \"grep\" | \"read\" | \"gh\", ... } "
      + "(--tasks=<file>, or piped on stdin when --tasks is absent)");
  }
  return /** @type {Task[]} */ (parsed);
}

function main() {
  refuseUnknownFlags(["--tasks", "--repo"], { entry: import.meta.url, command: "pnpm run survey" });
  const cwd = flagValue(process.argv, "repo") ?? process.cwd();
  process.stdout.write(`${render(survey(tasksFromArgv(), { cwd }))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
