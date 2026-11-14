// @ts-check
// module: the ticket-mode daily retro (A11-432) -- once a UTC day, each repository's recent runs are read for recurring causes, and its lessons file is written
//
// OFF UNLESS `tickets.lessons` IS TRUE: the feature ships off and turns on only when the offline test (the M2 eval set, run with lessons off and on) shows no drop (the plan's step 3).
//
// ONCE A UTC DAY, AT THE FIRST SWEEP OF THE DAY. The board runs this with its feedback sweeps; the day it last ran is kept in `lessons-retro.json`, written BEFORE the model is asked, so a
// retro that fails is tried again tomorrow, not every sweep of today (each try is a model run).
//
// NEVER HOLDS THE BOARD'S LOOP: the model runs under `execFile` (`realExecAsync`), the sweep is not started over itself while it runs, and its reads are a few local files.
//
// EVERY REPOSITORY WITH A LESSONS FILE IS RETRO'D, even with nothing to read: its stale lessons still expire. A repository with items asks the model once; one whose answer cannot be read keeps
// its lessons as they were, but for those that expire.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecResult } from "../../plugins/manifest.ts";
import { latestOutcomes, outcomesPath, readOutcomes } from "../outcomes/outcome-record.ts";
import type { RunEvent } from "../queue/run-log.ts";
import { RETRO_DAYS, retroEvidence, type RetroItem } from "./evidence.ts";
import { type Lesson, lessonsDir, mergeLessons, type Proposal, readLessons, writeLessons } from "./lessons-store.ts";
import { proposalsOf, replyOf, retroPrompt } from "./retro-prompt.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The model the retro asks. One run a day per repository with items. */
export const RETRO_MODEL = "sonnet";

/** The longest one repository's retro may run before it is cut. */
const RETRO_TIMEOUT_MS = 15 * 60 * 1000;

export type RetroDeps = Readonly<{
  /** Whether `tickets.lessons` is on. */
  on: () => boolean;
  stateDir: string;
  /** The queue's run logs, by ticket key. */
  runLog: () => Readonly<Record<string, readonly RunEvent[]>>;
  /** Ask the model `prompt`, headless: the board's is {@link askClaude}. */
  ask: (prompt: string) => Promise<ExecResult>;
  now: () => number;
  log: (line: string) => void;
}>;

/** The file the day of the last retro is kept in. */
export const retroStatePath = (stateDir: string): string => join(stateDir, "tickets", "lessons-retro.json");

/** The UTC date of `at`, as `YYYY-MM-DD`. PURE. */
const dateOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The day the last retro ran, or null when none has. A file that cannot be read is none: the worst that does is one more retro. */
function lastRan(stateDir: string): string | null {
  try {
    const { ranOn } = JSON.parse(readFileSync(retroStatePath(stateDir), "utf8")) as { ranOn?: unknown };
    return typeof ranOn === "string" ? ranOn : null;
  } catch {
    return null;
  }
}

function recordRan(stateDir: string, day: string): void {
  const path = retroStatePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ranOn: day })}\n`);
}

/** The board's sweep: when `tickets.lessons` is on and no retro has run today, run one. */
export function retroSweep(deps: RetroDeps): () => Promise<void> {
  return async () => {
    if (!deps.on()) return;
    const now = deps.now();
    if (lastRan(deps.stateDir) === dateOf(now)) return;
    recordRan(deps.stateDir, dateOf(now));
    await runRetro(deps, now);
  };
}

/** The repositories that have a lessons file. */
function reposWithLessons(stateDir: string): string[] {
  const dir = lessonsDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => repoOfFile(name.slice(0, -".json".length)));
}

/** The repository a lessons file's name stands for, or none for a name that is not one `lessonsPath` writes: a stray file stops no repository's retro. PURE. */
function repoOfFile(name: string): string[] {
  try {
    return [decodeURIComponent(name)];
  } catch {
    return [];
  }
}

/** One retro at `now`: every repository with items or a lessons file has its lessons merged and written. One that fails is said, and the others go on. */
export async function runRetro(deps: RetroDeps, now: number): Promise<void> {
  const evidence = retroEvidence({ records: latestOutcomes(readOutcomes(outcomesPath(deps.stateDir))), runLog: deps.runLog(), since: now - RETRO_DAYS * DAY_MS });
  const repos = [...new Set([...evidence.keys(), ...reposWithLessons(deps.stateDir)])].sort();
  for (const repo of repos) {
    try {
      await retroOne(deps, repo, evidence.get(repo) ?? [], now);
    } catch (error) {
      deps.log(`the retro of ${repo} failed: ${(error as Error).message}`);
    }
  }
}

async function retroOne(deps: RetroDeps, repo: string, items: readonly RetroItem[], now: number): Promise<void> {
  const lessons = readLessons(deps.stateDir, repo);
  const proposals = items.length === 0 ? [] : await askFor(deps, repo, lessons, items);
  writeLessons(deps.stateDir, repo, mergeLessons(lessons, proposals, now, (n) => `L${now.toString(36)}-${n}`));
}

/** The model's checked proposals for `repo`, or none when its answer cannot be read, which is said. */
async function askFor(deps: RetroDeps, repo: string, lessons: readonly Lesson[], items: readonly RetroItem[]): Promise<Proposal[]> {
  const answer = await deps.ask(retroPrompt(repo, lessons, items));
  const reply = answer.status === 0 ? replyOf(answer.stdout) : null;
  const proposals = reply === null ? null : proposalsOf(reply, new Set(items.map((item) => item.run)), lessons);
  if (proposals === null) deps.log(`the retro of ${repo} got no answer it could read (exit ${String(answer.status)}): ${(answer.stderr || answer.stdout).trim().split("\n")[0] ?? ""}`);
  return proposals ?? [];
}

/** The most the retro's model run may spend, in dollars, and the turns it may take: one answer, with no tool to call, needs one. */
const RETRO_MAX_BUDGET_USD = 2;
const RETRO_MAX_TURNS = 2;

/**
 * The headless `claude` the board asks, its prompt read from stdin: no tool, no MCP server (nor the account's connectors, {@link RETRO_ENV}), no session kept, no permission prompt, a bound on its
 * turns and its spend, and its result as JSON.
 */
export function claudeArgs(): string[] {
  return ["-p", "--output-format", "json", "--model", RETRO_MODEL, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none",
    "--max-turns", String(RETRO_MAX_TURNS), "--max-budget-usd", String(RETRO_MAX_BUDGET_USD)];
}

/** The env the retro's model run adds: the account's claude.ai connectors off, as the eval's worker has them (`run-eval/sandbox.ts`). */
export const RETRO_ENV: Readonly<Record<string, string>> = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" };

type Exec = (file: string, args: readonly string[], options: { timeoutMs: number; cwd: string; input: string; env: Readonly<Record<string, string>> }) => Promise<ExecResult>;

/** Ask `claude` through `exec` (the board passes `realExecAsync`), in `stateDir`, the prompt on stdin, cut at {@link RETRO_TIMEOUT_MS}. */
export function askClaude(exec: Exec, stateDir: string): (prompt: string) => Promise<ExecResult> {
  return (prompt) => exec("claude", claudeArgs(), { timeoutMs: RETRO_TIMEOUT_MS, cwd: stateDir, input: prompt, env: RETRO_ENV });
}
