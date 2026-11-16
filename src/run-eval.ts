// @ts-check
// module: the worker eval (A11-431) -- replays merged tickets through a headless worker with the current brief, model and effort, and scores what it made
//
// FOR EACH TICKET OF A SET (`run-eval/set.ts`) it makes a throwaway clone at the ticket's base sha (`run-eval/sandbox.ts`), writes the brief the board would write today
// (`run-eval/worker.ts`), runs the worker headlessly with nothing able to leave the machine, and scores the tree the worker left:
// - TESTS: whether the entry's test command passes in it (the agent-org default is `check:changed`, against the base sha as `origin/main`);
// - VERDICT: the reviewer's, offline, as `review-eval.ts` asks it (the reviewer's model and effort, the `row-review` skill, a read-only sandbox), with the ticket as the spec;
// - SIMILARITY and OUTSIDE: how close the worker's diff is to the merged pull request's, and the files it touched that the merged one did not (`run-eval/diff-score.ts`);
// - TOKENS and WALL TIME of the worker's run.
// Tests and the verdict come first in the table: similarity is a weak signal (the plan).
//
// A STEP THAT FAILS IS A SCORE, NEVER A SKIP: a ticket whose clone, worker, tests or review failed keeps a row, with what failed in its note, and counts against the totals.
//
// A RUN IS STORED by its set, the sha it ran from and the config key it set (`run-eval/store.ts`), and `compare` prints two stored runs side by side (`run-eval/compare.ts`). A
// run may turn one switch of the host file on or off (`run-eval/key.ts`), and it stops before the next ticket once its tokens reach `tickets.evalTokenCap` (the epic's spend, Q4).
//
// NO `gh`, `git`, `claude` OR `codex` CALL IS MADE IN THIS FILE: they are `RunEvalDeps`, supplied by `scripts/run-eval.ts`, and the tests hand in fakes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installSkill, REVIEWER_EFFORT, REVIEWER_MODEL, verdictOf, type Label } from "./review-eval.ts";
import { filesOutside, readDiff, similarity } from "./run-eval/diff-score.ts";
import { offlineEnv, PULL_BODY_FILE, writeStandIns, type Git, cloneAt } from "./run-eval/sandbox.ts";
import { compareTable } from "./run-eval/compare.ts";
import { parseKey, type KeySetting } from "./run-eval/key.ts";
import { DEFAULT_TEST, parseSet, type EvalEntry } from "./run-eval/set.ts";
import { COLUMNS, layOut } from "./run-eval/table.ts";
import { loadRun, runPath, setNameOf, storeRun, type Revision, type Stopped } from "./run-eval/store.ts";
import { evalBrief, evalSettings, tokensOfResult, workerArgs, type HostBrief, type Place } from "./run-eval/worker.ts";
import { type SchemaEntry } from "./ticket-mode/config-schema.ts";
import { type Ticket } from "./ticket-mode/source.ts";
import { BRIEF_FILE, type ParentTicket } from "./ticket-mode/worker-files.ts";

/** What the eval reads and runs. Every one is read-only toward the tracker and the code host. */
export type RunEvalDeps = Readonly<{
  /** The ticket, and its attachments downloaded into `dir`; and its parent with the parent's attachments (under `dir/parent`), or null when it has none. */
  readTicket: (key: string, dir: string) => Promise<{ ticket: Ticket; attachments: readonly string[]; parent: ParentTicket | null }>;
  /** The merged pull request's diff, its base to its head. */
  readMergedDiff: (repo: string, number: number) => string;
  /** Where the history of `repo` up to `sha` is fetched from: the host's checkout when it holds `sha`, else the repository's URL. */
  sourceOf: (repo: string, sha: string) => string;
  git: Git;
  /** Run the headless worker, `claude` with `args` in `cwd`, and return what it printed. */
  work: (opts: { cwd: string; args: readonly string[]; env: Record<string, string> }) => Promise<string>;
  /** Run a shell command in `cwd`; true when it exits 0. */
  test: (opts: { cwd: string; command: string; env: Record<string, string> }) => Promise<boolean>;
  /** Ask the reviewer, working in `cwd`, and return its last message (`review-eval.ts`'s `review`). */
  review: (opts: { cwd: string; prompt: string; model: string; effort: string }) => Promise<string>;
  host: HostBrief;
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
}>;

/** What one ticket scored. `null` is unknown (the step failed or could not run), which the totals never count as a pass. */
export type Scores = Readonly<{ tests: boolean | null; verdict: Label | null; similarity: number | null; outside: readonly string[]; tokens: number | null; wallMs: number }>;

export type TicketResult = Readonly<{ entry: EvalEntry; scores: Scores; notes: readonly string[]; dir: string }>;

/** The model and effort the worker runs with, and the directory each ticket's throwaway folder is made under. */
export type RunOptions = Readonly<{ model: string; effort: string; workDir: string }>;

const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0];

/** The repository's name without its owner, which is the clone's name in the brief, as the host's `clones` name it. PURE. */
const nameOf = (repo: string): string => repo.replace(/^[^/]+\//, "");

/** A ticket's throwaway folder: the worker's places, and the eval's own bare origin, record of stand-in calls, empty `gh` configuration and the host file that does not exist. */
type EvalPlace = Place & Readonly<{ dir: string; origin: string; record: string; ghConfig: string; noHost: string }>;

/** The ticket's throwaway folder and the places in it. */
function placeFor(entry: EvalEntry, workDir: string): EvalPlace {
  const dir = mkdtempSync(join(workDir, `${entry.ticket}-`));
  const place = { dir, folder: join(dir, "folder"), ticketDir: join(dir, "ticket"), clones: { [nameOf(entry.repo)]: join(dir, "clone") }, standIns: join(dir, "bin"),
    origin: join(dir, "origin.git"), record: join(dir, "record"), ghConfig: join(dir, "gh-config"), noHost: join(dir, "no-host.json") };
  for (const made of [place.folder, place.ticketDir, place.ghConfig]) mkdirSync(made, { recursive: true });
  return place;
}

/** The prompt the reviewer is given: `review-eval.ts`'s ask, with the ticket as the spec and the worker's pull request when it opened one. It states no expected verdict. PURE. */
export function ticketReviewPrompt({ ticket, diff, pullRequest }: { ticket: string; diff: string; pullRequest: string | null }): string {
  return [
    "Review a pull request with the `row-review` skill. This is an OFFLINE evaluation: post nothing, run no `gh` command and change nothing.",
    `- The ticket it is for (its acceptance criteria and Decisions are the spec): ${ticket}`,
    pullRequest === null ? "- No pull request body was written; judge the diff against the ticket." : `- The pull request (title and body): ${pullRequest}`,
    `- The diff, base to the worker's tree: ${diff}`,
    "- The worker's tree is the current directory, read-only: search it with `git grep` or `grep -rn`.",
    "No check was run for you; read the tests the change adds or relies on.",
    "Finish with one last line, exactly `VERDICT: convinced` or `VERDICT: not convinced`, and nothing after it.",
  ].join("\n");
}

/** The tree the worker left: its worktree under the folder, or the clone itself when it made none. */
const treeOf = (place: Place, repo: string): string => (existsSync(join(place.folder, nameOf(repo))) ? join(place.folder, nameOf(repo)) : place.clones[nameOf(repo)]);

/** Everything the worker changed from the base sha, committed or not, untracked files included. */
function workerDiff(git: Git, tree: string, baseSha: string): string {
  git(["add", "--all"], tree);
  return git(["diff", "--cached", baseSha], tree);
}

/** The worker's folder made ready: the ticket, its parent and their attachments read, its brief and settings written, and the stand-ins put in place. */
async function prepareWorker(entry: EvalEntry, deps: RunEvalDeps, options: RunOptions, place: EvalPlace): Promise<void> {
  const { ticket, attachments, parent } = await deps.readTicket(entry.ticket, place.ticketDir);
  writeFileSync(join(place.dir, "ticket.md"), `# ${ticket.key}: ${ticket.title}\n\n${ticket.description}\n`);
  writeFileSync(join(place.ticketDir, BRIEF_FILE), evalBrief({ ticket, attachments, parent, place, host: deps.host, repo: nameOf(entry.repo), now: deps.now() }));
  mkdirSync(join(place.folder, ".claude"), { recursive: true });
  writeFileSync(join(place.folder, ".claude", "settings.local.json"), `${JSON.stringify(evalSettings({ model: options.model, place, host: deps.host }), null, 2)}\n`);
  writeStandIns(place.standIns, { record: place.record, clones: place.clones, folder: place.folder, branch: ticket.branch });
}

/** The worker's run, `claude` headless and offline in its prepared folder. Returns its tokens and wall time, and a note when it failed: a failed run is still scored. */
async function runWorker(entry: EvalEntry, deps: RunEvalDeps, options: RunOptions, place: EvalPlace): Promise<{ tokens: number | null; wallMs: number; note?: string }> {
  const started = deps.now();
  try {
    const stdout = await deps.work({ cwd: place.folder, args: workerArgs({ name: `eval-${entry.ticket}`, model: options.model, effort: options.effort, ticketDir: place.ticketDir }), env: offlineEnv(deps.env, place) });
    writeFileSync(join(place.record, "worker-result.json"), stdout);
    return { tokens: tokensOfResult(stdout), wallMs: deps.now() - started };
  } catch (error) {
    // A worker that exits non-zero may still have printed its result: its tokens were spent, and the token cap must count them. One killed for its time printed none, and is unknown.
    const printed = (error as { stdout?: unknown })?.stdout;
    return { tokens: typeof printed === "string" ? tokensOfResult(printed) : null, wallMs: deps.now() - started, note: `worker failed: ${firstLine(error)}` };
  }
}

/** The reviewer's verdict on the worker's diff, or null with the reason. */
async function reviewOf(entry: EvalEntry, deps: RunEvalDeps, place: EvalPlace, tree: string, diff: string): Promise<{ verdict: Label | null; note?: string }> {
  if (diff.trim() === "") return { verdict: null, note: "no review: the worker changed nothing" };
  const diffFile = join(place.dir, "worker.patch");
  writeFileSync(diffFile, diff);
  const pullBody = join(place.record, PULL_BODY_FILE);
  installSkill(tree);
  const reply = await deps.review({ cwd: tree, prompt: ticketReviewPrompt({ ticket: join(place.dir, "ticket.md"), diff: diffFile, pullRequest: existsSync(pullBody) ? pullBody : null }), model: REVIEWER_MODEL, effort: REVIEWER_EFFORT });
  writeFileSync(join(place.dir, "review.md"), reply);
  const verdict = verdictOf(reply);
  return verdict === null ? { verdict, note: `no verdict in the review (kept at ${join(place.dir, "review.md")})` } : { verdict };
}

const UNKNOWN: Scores = { tests: null, verdict: null, similarity: null, outside: [], tokens: null, wallMs: 0 };

/** One ticket, start to scores. Never throws: a step that fails leaves its score unknown and says why in the notes, and a ticket whose folder cannot be made is a row of unknowns. */
export async function evaluateTicket(entry: EvalEntry, deps: RunEvalDeps, options: RunOptions): Promise<TicketResult> {
  let place: EvalPlace;
  try {
    place = placeFor(entry, options.workDir);
  } catch (error) {
    return { entry, scores: UNKNOWN, notes: [`making its folder failed: ${firstLine(error)}`], dir: "" };
  }
  return scoreIn(entry, deps, options, place);
}

/** The steps of one ticket in its folder: read, clone, prepare, work, then score what the worker left. */
async function scoreIn(entry: EvalEntry, deps: RunEvalDeps, options: RunOptions, place: EvalPlace): Promise<TicketResult> {
  const notes: string[] = [];
  const step = async <T>(what: string, run: () => T | Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      notes.push(`${what} failed: ${firstLine(error)}`);
      return null;
    }
  };
  const merged = await step("reading the merged diff", () => deps.readMergedDiff(entry.repo, entry.mergedPr));
  const cloned = merged !== null && (await step("the clone", () => (cloneAt(deps.git, { source: deps.sourceOf(entry.repo, entry.baseSha), sha: entry.baseSha, origin: place.origin, clone: place.clones[nameOf(entry.repo)] }), true))) === true;
  const prepared = cloned && (await step("reading the ticket", () => prepareWorker(entry, deps, options, place).then(() => true))) === true;
  if (merged === null || !prepared) return { entry, scores: UNKNOWN, notes, dir: place.dir };
  const run = await runWorker(entry, deps, options, place);
  if (run.note !== undefined) notes.push(run.note);
  const tree = treeOf(place, entry.repo);
  const diff = await step("reading the worker's diff", () => workerDiff(deps.git, tree, entry.baseSha));
  const tests = await step("the tests", () => deps.test({ cwd: tree, command: entry.test ?? DEFAULT_TEST, env: offlineEnv(deps.env, place) }));
  // A diff that could not be read leaves similarity, outside and the verdict unknown: an empty one would read as a worker that changed nothing.
  const review = diff === null ? null : await step("the review", () => reviewOf(entry, deps, place, tree, diff));
  if (review?.note !== undefined) notes.push(review.note);
  const worker = diff === null ? null : readDiff(diff);
  const answer = readDiff(merged);
  return { entry, notes, dir: place.dir, scores: { tests, verdict: review?.verdict ?? null, similarity: worker === null ? null : similarity(worker, answer), outside: worker === null ? [] : filesOutside(worker, answer), tokens: run.tokens, wallMs: run.wallMs } };
}

/** One score as the table prints it; `?` is unknown. PURE. */
function cells({ entry, scores }: TicketResult): string[] {
  const { tests, verdict, similarity: close, outside, tokens, wallMs } = scores;
  return [entry.ticket, tests === null ? "?" : tests ? "pass" : "fail", verdict ?? "?", close === null ? "?" : close.toFixed(2), String(outside.length), tokens === null ? "?" : String(tokens), `${Math.round(wallMs / 1000)}s`];
}

/** The totals row: passes and convinced verdicts of all, mean similarity of the known, files outside, tokens of the known (with how many are unknown) and wall time. PURE. */
function totals(results: readonly TicketResult[]): string[] {
  const all = results.map(({ scores }) => scores);
  const known = all.map(({ similarity: close }) => close).filter((close) => close !== null);
  const tokens = all.map(({ tokens: used }) => used).filter((used) => used !== null);
  const unknownTokens = all.length - tokens.length;
  return ["total", `${all.filter(({ tests }) => tests === true).length}/${all.length}`, `${all.filter(({ verdict }) => verdict === "convinced").length}/${all.length} convinced`,
    known.length === 0 ? "?" : (known.reduce((a, b) => a + b, 0) / known.length).toFixed(2), String(all.reduce((n, { outside }) => n + outside.length, 0)),
    `${tokens.reduce((a, b) => a + b, 0)}${unknownTokens > 0 ? ` (+${unknownTokens} unknown)` : ""}`, `${Math.round(all.reduce((n, { wallMs }) => n + wallMs, 0) / 1000)}s`];
}

/** The line that says a run stopped at the token cap, how far it got and which tickets it never started. PURE. */
export const stoppedLine = ({ ran, of, tokens, cap, notStarted }: Stopped): string =>
  `stopped by the token cap: ${ran} of ${of} tickets ran, ${tokens} tokens spent of a cap of ${cap} (tickets.evalTokenCap); not started: ${notStarted.join(", ")}`;

/** The table, a row per ticket and a total, then each ticket's notes and folder, and, for a run the token cap stopped, how far it got. PURE. */
export function report(results: readonly TicketResult[], { model, effort, set, key = null, stopped = null }: { model: string; effort: string; set: string; key?: KeySetting | null; stopped?: Stopped | null }): string {
  const table = layOut([[...COLUMNS], ...results.map(cells), totals(results)]);
  const notes = results.flatMap(({ entry, notes: said, dir }) => [`${entry.ticket}: ${dir}`, ...said.map((note) => `  ${note}`)]);
  const keyWords = key === null ? "" : `, ${key.name} ${key.on ? "on" : "off"}`;
  return [`worker eval of ${set} (${model}, effort ${effort}${keyWords})`, ...table, ...(stopped === null ? [] : ["", stoppedLine(stopped)]), "", ...notes].join("\n") + "\n";
}

/** Where a set named without a path is read: `evals/sets/<name>.json` of this checkout. */
export const SETS_DIR = fileURLToPath(new URL("../evals/sets/", import.meta.url));

/** The file a `--set` names: a path as given when it has a `/` or ends in `.json`, else the checked-in set of that name. PURE. */
export const setFile = (name: string, dir: string = SETS_DIR): string => (name.includes("/") || name.endsWith(".json") ? name : join(dir, `${name}.json`));

export const USAGE = [
  "usage: run-eval --set <name|file.json> [--only A11-1,...] [--model M] [--effort E] [--key <switch>=on|off] [--replace]  (each also as --flag=value)",
  "       run-eval compare --set <name|file.json> <A> <B>  (a run is a sha or its start, with @<switch>=on|off when it set a key)",
].join("\n");

/** The options that take a value, and the one that takes none. */
const VALUED = new Set(["set", "only", "model", "effort", "key"]);
const FLAGS = new Set(["replace"]);

/** The arguments: the options, and the words that are not options (a compare's two runs). Or a refusal. PURE. */
export function parseArgs(argv: readonly string[]): { options: Map<string, string>; words: string[] } | string {
  const options = new Map<string, string>();
  const words: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    const found = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (found === null) {
      words.push(arg);
      continue;
    }
    if (FLAGS.has(found[1]) && found[2] === undefined) {
      options.set(found[1], "");
      continue;
    }
    const value = VALUED.has(found[1]) ? found[2] ?? argv[++at] : undefined;
    if (value === undefined) return `unknown or incomplete argument: ${arg}`;
    options.set(found[1], value);
  }
  return options.has("set") ? { options, words } : "--set is required";
}

/** Say why the command refuses, and return its exit code, 2. */
function refuse(err: (text: string) => void, why: string): number {
  err(`${why}\n`);
  return 2;
}

/** Where results are stored, the commit the eval runs from and the token cap a run stops at (`tickets.evalTokenCap`). */
export type StoreOptions = Readonly<{ resultsDir: string; revision: Revision; tokenCap: number }>;

/** The tickets of `chosen` worked in order until the token cap is reached before the next would start. Unknown tokens count as none, and the report says how many were unknown. */
async function runSet(chosen: readonly EvalEntry[], deps: RunEvalDeps, run: RunOptions, tokenCap: number): Promise<{ results: TicketResult[]; stopped: Stopped | null }> {
  const results: TicketResult[] = [];
  let spent = 0;
  for (const [at, entry] of chosen.entries()) {
    if (spent >= tokenCap) return { results, stopped: { ran: at, of: chosen.length, tokens: spent, cap: tokenCap, notStarted: chosen.slice(at).map(({ ticket }) => ticket) } };
    const result = await evaluateTicket(entry, deps, run);
    results.push(result);
    spent += result.scores.tokens ?? 0;
  }
  return { results, stopped: null };
}

/** The set `name` names, or why it cannot be read. */
function readSet(name: string, setsDir: string | undefined): readonly EvalEntry[] | string {
  try {
    return parseSet(readFileSync(setFile(name, setsDir), "utf8"));
  } catch (error) {
    return `REFUSED: the set ${name} cannot be read: ${firstLine(error)}`;
  }
}

/** The key `--key` names, null when it names none, or why it is refused. PURE. */
function keyOf(options: ReadonlyMap<string, string>, schema: readonly SchemaEntry[]): KeySetting | null | string {
  const text = options.get("key");
  if (text === undefined) return null;
  try {
    return parseKey(text, schema);
  } catch (error) {
    return `REFUSED ${firstLine(error)}`;
  }
}

type Io = Readonly<{ out?: (text: string) => void; err?: (text: string) => void }>;

/**
 * The command. Returns the exit code: 0 when every ticket ran (whatever it scored), 1 when the token cap stopped the run, 2 a refusal. `defaults` are the board's saved model and
 * effort. A run of the whole set is stored by its set, sha and key; one with `--only` is not, since it would stand for the set. A run already stored is refused unless `--replace`,
 * before any ticket starts, so a second run is never spent by accident.
 */
export async function main(argv: readonly string[], deps: RunEvalDeps, { defaults, out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text), workDir, setsDir, store, schema }: {
  defaults: { model: string; effort: string }; workDir?: string; setsDir?: string; store: StoreOptions; schema: readonly SchemaEntry[];
} & Io): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") return refuse(err, `REFUSED ${parsed}\n${USAGE}`);
  const { options, words } = parsed;
  if (words.length > 0) return refuse(err, `REFUSED unknown argument: ${words[0]}\n${USAGE}`);
  const name = options.get("set") as string;
  const set = readSet(name, setsDir);
  if (typeof set === "string") return refuse(err, set);
  const key = keyOf(options, schema);
  if (typeof key === "string") return refuse(err, key);
  const only = options.get("only")?.split(",").filter(Boolean);
  const chosen = only === undefined ? set : set.filter(({ ticket }) => only.includes(ticket));
  if (chosen.length === 0) return refuse(err, `REFUSED: --only names no ticket of ${name}`);
  const storedAt = runPath(store.resultsDir, name, store.revision, key);
  if (only === undefined && existsSync(storedAt) && !options.has("replace")) return refuse(err, `REFUSED: a run of ${name} at this sha is stored at ${storedAt}; pass --replace to run it again`);
  const run: RunOptions = { model: options.get("model") ?? defaults.model, effort: options.get("effort") ?? defaults.effort, workDir: workDir ?? mkdtempSync(join(tmpdir(), "run-eval-")) };
  const { results, stopped } = await runSet(chosen, deps, run, store.tokenCap);
  out(report(results, { ...run, set: name, key, stopped }));
  if (only !== undefined) out("not stored: --only runs part of the set\n");
  else out(`stored at ${storeRun(store.resultsDir, { v: 1, set: setNameOf(name), ...store.revision, key, model: run.model, effort: run.effort, at: deps.now(), stopped, results })}\n`);
  return stopped === null ? 0 : 1;
}

/** `compare --set <name> <A> <B>`: the two stored runs side by side. Returns 0, or 2 when a run cannot be read. */
export function compareMain(argv: readonly string[], { resultsDir, out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) }: { resultsDir: string } & Io): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") return refuse(err, `REFUSED ${parsed}\n${USAGE}`);
  const { options, words } = parsed;
  if (words.length !== 2 || options.size !== 1) return refuse(err, `REFUSED: compare takes --set and two runs\n${USAGE}`);
  const name = options.get("set") as string;
  try {
    out(compareTable(loadRun(resultsDir, name, words[0]), loadRun(resultsDir, name, words[1])));
    return 0;
  } catch (error) {
    return refuse(err, `REFUSED: ${firstLine(error)}`);
  }
}
