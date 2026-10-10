// #4750 (use 2 of a11ign#4627): A QUESTION THE PROVIDER KEEPS BEING UNSURE OF FILES ITS OWN IMPROVEMENT ROW. `provider-confidence.ts` reads the decision log into one row per use and question; this acts on
// the reading, so nobody has to notice. A question is low-confidence when it was asked at least `MIN_DECISIONS` times in the window AND MORE than `MIN_UNDER_FLOOR_SHARE` of those answers were
// the provider's own, held back by the floor. Both edges are exclusive-on-the-share and inclusive-on-the-count: 20 decisions at exactly 30% is not, 19 at 100% is not, 20 at 35% is.
//
// ONE ROW PER QUESTION, AND NEVER A SECOND WHILE ONE IS OPEN. The tracker is the memory, read each run: an open row of the class carrying the question's title means it is already being worked.
// A row that CLOSED inside the window also holds the question back, because the window still contains the decisions that made it low; refiling then would open a twin the minute the fix merged.
// A tracker that cannot be read files nothing: not seeing an open row is not seeing none.
//
// WHY NOT `fileClassRepeats`. The row asked for it, and it cannot carry this: it files only a class the project's index names, once per CLASS (a question is not one), only at a second CLOSED
// occurrence, and with the class-repeat body. This module keeps what that file does well, which is `runRowFile` (the same `row-file`, the same launch reason) and the `class:` label, and
// supplies the per-question key and body. THE CLASS NEEDS AN ENTRY IN THE PROJECT'S `.agent-org/failure-classes.json` (`provider-low-confidence`) before a row carrying its label closes,
// or the class-repeat reading names it an unknown class: that file is the project's, not this repository's.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). With no `jev` provider declared, no key or the question's use switched off, nothing is filed and nothing is asked of `gh`: `uses` is empty and the
// first thing `fileLowConfidence` does is return. No Jev-specific code lives here beyond the declared provider's name, which `provider-confidence.ts` reads the same way.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { confidenceReading, DEFAULT_WINDOW_MS, formatConfidenceReading, parseWindow, type ConfidenceReading, type ConfidenceRow } from "./provider-confidence.ts";

/** The least decisions a question must have been asked in the window before its share means anything. */
export const MIN_DECISIONS = 20;
/** The share of those held back by the floor that a question must EXCEED. */
export const MIN_UNDER_FLOOR_SHARE = 0.3;
/** The ledger class every improvement row carries as `class:provider-low-confidence`. */
export const CLASS_ID = "provider-low-confidence";
const CLASS_LABEL = `class:${CLASS_ID}`;
const CLASS_LABEL_DESCRIPTION = "A question the decision provider is often unsure of: its improvement row (a11ign/a11ign#4750)";
/** The session a row is filed as when the caller names none: the gate that will run this. */
const FILER_SESSION = "work-gate";
/** `gh issue list` is asked for this many rows; a listing that fills it may be cut short, so it is refused rather than read as complete. */
const LIST_LIMIT = 200;
const PERCENT = 100;
const EMPTY = "-";
const MS_PER_HOUR = 3_600_000;
const NO_PROVIDER = "No decision provider is declared, or no use is switched on: nothing is asked and nothing is filed.";
const REPO_KEY = "agent-org";

export type LowConfidenceOptions = { minDecisions?: number; share?: number };

/** `<use>/<question>`: the one name a question has across the reading, the row's title and the check command. */
export const questionKey = (row: Pick<ConfidenceRow, "use" | "question">): string => `${row.use}/${row.question}`;

/**
 * THE QUESTIONS WORTH A ROW: asked at least `minDecisions` times and held back by the floor on MORE than `share` of them. Pure, over the reading `confidenceReading` returns. An answer that fell back
 * for any other reason (a refusal, a 422) is not under the floor, so it is not counted here (`provider-confidence.ts` counts it apart).
 */
export function lowConfidenceQuestions(reading: ConfidenceReading, { minDecisions = MIN_DECISIONS, share = MIN_UNDER_FLOOR_SHARE }: LowConfidenceOptions = {}): ConfidenceRow[] {
  return reading.rows.filter((row) => row.asked >= minDecisions && row.underFloorShare > share);
}

export type QuestionVerdict = "settled" | "still-low" | "too-few" | "not-asked";

/** Whether one question has come up: `settled` needs at least `minDecisions` AND a share at or under `share`. Too few decisions is a different answer from a good one, and never `settled`. */
export function questionVerdict(reading: ConfidenceReading, key: string, options: LowConfidenceOptions = {}): { verdict: QuestionVerdict; row?: ConfidenceRow } {
  const { minDecisions = MIN_DECISIONS, share = MIN_UNDER_FLOOR_SHARE } = options;
  const row = reading.rows.find((candidate) => questionKey(candidate) === key);
  if (row === undefined) return { verdict: "not-asked" };
  if (row.asked < minDecisions) return { verdict: "too-few", row };
  return { verdict: row.underFloorShare > share ? "still-low" : "settled", row };
}

// ---- THE ROW ----

/** The module that asks each use's questions, so the row's Region names the file whose criteria the work changes. A use not listed gets the shared adapter alone. */
const MODULE_OF_USE: Readonly<Record<string, string>> = {
  "model-routing": "engineer-route", "wake-triage": "triage-provider", "ci-failure-class": "ci-failure-class",
  "failure-class-match": "class-match", "duplicate-row": "duplicate-row", "review-depth": "review-depth",
};
const ADAPTER = "decision-provider";

/** The Region of a use's improvement row, as `row-file` reads it: keyed, because the paths are in `a11ign/agent-org` and a bare path is the project's own tree (#3056). */
export function regionFiles(use: string): string[] {
  const own = MODULE_OF_USE[use];
  const names = own === undefined ? [ADAPTER] : [own, ADAPTER];
  return names.flatMap((name) => [`src/${name}.ts`, `src/${name}.test.ts`]);
}

export const improvementTitle = (row: Pick<ConfidenceRow, "use" | "question">): string => `Raise the provider's confidence on ${questionKey(row)}`;

const percent = (share: number): string => `${Math.round(share * PERCENT)}%`;
const number = (value: number | undefined): string => (value === undefined ? EMPTY : value.toFixed(2));
const day = (at: number): string => new Date(at).toISOString();

/** The reading for ONE question as `provider-confidence.ts` prints it, under its command: what the Open-check shows is pasted from that formatter, not retyped. */
function transcript(row: ConfidenceRow, reading: ConfidenceReading, windowText: string): string {
  const single: ConfidenceReading = { ...reading, decisions: row.asked, rows: [row] };
  return [`$ node src/provider-confidence.ts --since ${windowText}`, formatConfidenceReading(single)].join("\n");
}

/** The window as `parseWindow` takes it back (`24h`, `7d`), so the command in the row asks for the span that was read. */
export function windowText(reading: ConfidenceReading): string {
  const hours = (reading.until - reading.since) / MS_PER_HOUR;
  return Number.isInteger(hours / 24) && hours >= 24 ? `${hours / 24}d` : `${Math.max(1, Math.ceil(hours))}h`;
}

/** The body of one improvement row: what was read, where the work is, the method, and the commands that say it is done. It states the figures it was filed on and no more. */
export function improvementBody(row: ConfidenceRow, reading: ConfidenceReading): string {
  const key = questionKey(row);
  const span = windowText(reading);
  const floor = row.floor === undefined ? "a floor the log did not name" : `the floor ${row.floor.value}`;
  const unit = regionFiles(row.use).filter((file) => file.endsWith(".test.ts"));
  return [
    "## What it is", "",
    `**The provider was held back by its floor on ${row.underFloor} of ${row.asked} decisions (${percent(row.underFloorShare)}) for \`${key}\`**, between ${day(reading.since)} and ${day(reading.until)}: `
      + `a mean confidence of ${number(row.meanConfidence)} and a median of ${number(row.medianConfidence)} against ${floor}. Each held-back answer took the deterministic rule instead, `
      + "so the provider is asked on this question and not used.", "",
    `The bar is MORE than ${percent(MIN_UNDER_FLOOR_SHARE)} of at least ${MIN_DECISIONS} decisions, and a refusal, a 422 or a timeout is not counted (a11ign/a11ign#4750, use 2 of #4627). `
      + "Filed by the filer that read the decision log; nobody had to notice.", "",
    "The provider stays OPTIONAL (chairman, #4627): this row changes the question's wording and state, never whether a provider is needed.", "",
    "The repository is `a11ign/agent-org`; paths are relative to its root.", "",
    "## Region", "", "```", ...regionFiles(row.use).map((file) => `${REPO_KEY}:${file}`), "```", "",
    "## Change", "",
    "The improvement method is TypeSafe's own guidance (its `confidence` page and the consistency cookbooks for Noul and Choice), as a11ign/a11ign#4751 applied it to the routing questions:", "",
    "1. **Structured `criteria`:** each option carries `what`, `not_for` and `examples`, in place of a one-line description.",
    "2. **A score's `levels`** each carry a `summary` and `signals` (the observable features of a row at that level).",
    "3. **Examples from OUR closed rows,** whose correct answer is now known from the outcome, each cited by row number; at least two per option, none invented.",
    "4. **Trimmed, structured `state`:** only the fields the criteria name, under `MAX_STATE_BYTES`, never an agent-written body.",
    "5. **Tests:** every option has `what`, `not_for` and two examples naming a real row, with a control that fails on an example naming a row that is not in the closed-row list.", "",
    "## Acceptance", "", "```bash",
    `cd ~/repos/agent-org && pnpm exec rstest run --config scripts/rstest/rstest.config.* ${unit.join(" ")}`, "```", "",
    "## Done-when", "",
    "1. The Acceptance passes and the pull request is merged.",
    `2. After a release carrying the merge and at least ${MIN_DECISIONS} decisions of \`${row.use}\` made on it, \`node src/provider-low-confidence.ts --question=${key}\` run with \`--since\` `
      + "set to a window that starts AFTER that release exits 0, and its output is quoted on the row beside the reading above. Exit 1 is still low, and exit 2 is too few decisions to say: neither closes the row.", "",
    "## Open-check", "", "```", transcript(row, reading, span), "```", "",
    "## Fleet", "", "No (source and tests only).", "",
  ].join("\n");
}

/** The argv `row-file` is given: the home tracker (`--tracker=` is its empty key, as for the class row), the class label and the session. Not a defect, so no `--kind`. */
export function improvementArgv(row: ConfidenceRow, reading: ConfidenceReading, session: string = FILER_SESSION): string[] {
  return ["--tracker=", "--label", CLASS_LABEL, `--session=${session}`, "--title", improvementTitle(row), "--body", improvementBody(row, reading)];
}

// ---- FILING ----

/** `gh` as `class-repeat.ts` calls it: arguments in, stdout out, a throw on a refusal. */
export type Gh = (args: string[]) => string;

export type FilingIo = {
  /** The uses the provider may be asked about: empty with no `jev` provider declared, and otherwise those switched on. Anything else is not read and not filed. */
  uses: ReadonlySet<string>;
  run: Gh;
  repo: string;
  fileRow: (argv: string[]) => string;
  session?: string;
  options?: LowConfidenceOptions;
};

export type Outcome = { filed: string } | { skipped: string } | { refused: string };

type Tracked = { number: number; title: string; state: string; closedAt: string | null };

const messageOf = (err: unknown): string => String((err as { message?: unknown })?.message ?? err).split("\n")[0].slice(0, 200);

/** The rows of the class, open and closed. A listing that filled `LIST_LIMIT` may have been cut short and is refused, never read as the whole. */
function listTracked(run: Gh, repo: string): Tracked[] | { unreadable: string } {
  try {
    const rows = JSON.parse(run(["issue", "list", "--repo", repo, "--label", CLASS_LABEL, "--state", "all", "--limit", String(LIST_LIMIT), "--json", "number,title,state,closedAt"]));
    if (!Array.isArray(rows)) return { unreadable: "the tracker's listing was not a list" };
    if (rows.length >= LIST_LIMIT) return { unreadable: `the listing filled its ${LIST_LIMIT}-row limit and may be cut short` };
    return rows as Tracked[];
  } catch (err) {
    return { unreadable: messageOf(err) };
  }
}

/** Why a question is not filed this run, or `undefined` when it should be: an open row of its title, or one that closed after the window began. */
function heldBack(row: ConfidenceRow, tracked: readonly Tracked[], since: number): string | undefined {
  const title = improvementTitle(row);
  const open = tracked.find((entry) => entry.title === title && entry.state.toUpperCase() === "OPEN");
  if (open !== undefined) return `#${open.number} is open for it`;
  const recent = tracked.find((entry) => entry.title === title && entry.closedAt !== null && Date.parse(entry.closedAt) > since);
  return recent === undefined ? undefined : `#${recent.number} closed inside the window, which still holds the decisions that made it low`;
}

function rowNumberOf(output: string): string {
  const last = output.trim().split("\n").pop() ?? "";
  const match = /\/issues\/(\d+)\s*$/.exec(last);
  return match?.[1] === undefined ? last.slice(0, 200) || "(row-file printed nothing)" : `#${match[1]}`;
}

/** The first line of `row-file`'s stderr that is not empty, which is its refusal; the error's own first line when it wrote none. */
function refusalOf(err: unknown): string {
  const line = String((err as { stderr?: unknown })?.stderr ?? "").split("\n").find((text) => text.trim() !== "");
  return (line ?? messageOf(err)).trim().slice(0, 200);
}

function fileOne(row: ConfidenceRow, reading: ConfidenceReading, io: FilingIo): Outcome {
  try {
    io.run(["label", "create", CLASS_LABEL, "--repo", io.repo, "--force", "--description", CLASS_LABEL_DESCRIPTION]);
    return { filed: rowNumberOf(io.fileRow(improvementArgv(row, reading, io.session))) };
  } catch (err) {
    return { refused: refusalOf(err) };
  }
}

/** THE QUESTIONS THIS RUN WOULD FILE AND THE ONES IT WOULD HOLD BACK, by key. Reads the tracker once, and only when a question is a candidate. */
export function candidates(reading: ConfidenceReading, io: Pick<FilingIo, "uses" | "run" | "repo" | "options">): { file: ConfidenceRow[]; skipped: Record<string, Outcome> } {
  const asked = lowConfidenceQuestions(reading, io.options).filter((row) => io.uses.has(row.use));
  if (asked.length === 0) return { file: [], skipped: {} };
  const tracked = listTracked(io.run, io.repo);
  if ("unreadable" in tracked) return { file: [], skipped: Object.fromEntries(asked.map((row) => [questionKey(row), { refused: `the tracker could not be read, so no open row could be ruled out: ${tracked.unreadable}` }])) };
  const skipped: Record<string, Outcome> = {};
  const file: ConfidenceRow[] = [];
  for (const row of asked) {
    const why = heldBack(row, tracked, reading.since);
    if (why === undefined) file.push(row);
    else skipped[questionKey(row)] = { skipped: why };
  }
  return { file, skipped };
}

/**
 * FILE ONE IMPROVEMENT ROW PER LOW-CONFIDENCE QUESTION, by key, never a second while one is open. Returns `{}` and asks `gh` nothing when no use is on or no question qualifies, so a host
 * without the provider is exactly as it was. NEVER THROWS: a refusal is the question's `refused`, and the next run tries again.
 */
export function fileLowConfidence(reading: ConfidenceReading, io: FilingIo): Record<string, Outcome> {
  const { file, skipped } = candidates(reading, io);
  const outcomes = { ...skipped };
  for (const row of file) outcomes[questionKey(row)] = fileOne(row, reading, io);
  return outcomes;
}

// ---- THE COMMAND ----

const EXIT = { OK: 0, STILL_LOW: 1, CANNOT_ASK: 2 };

function cannotAsk(message: string): never {
  process.stderr.write(`CANNOT ASK: ${message}\n`);
  process.exit(EXIT.CANNOT_ASK);
}

const flagText = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? flagValue(argv, name) : argv[at + 1];
};

/** An absent log is the provider never having been asked; any other failure to read it is not that. */
function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    return cannotAsk(`the decision log could not be read (${(err as { code?: string })?.code ?? "unknown error"}). That is a failed read, NOT a provider asked nothing.`);
  }
}

// THE HOST IS IMPORTED WHEN THE COMMAND NEEDS IT, NOT AT THE TOP, as `provider-confidence.ts` does: those modules resolve the host's checkout on import.

/** The uses the host's provider may answer: none when no `jev` provider is declared (or the declaration cannot be read), else those switched on in the project's switches file. */
async function liveUses(): Promise<Set<string>> {
  try {
    const { homeHostConfig } = await import("./host-config.ts");
    if (homeHostConfig().triage?.provider !== "jev") return new Set();
    const { decisionSwitchesPath, readSwitches } = await import("./decision-provider.ts");
    const { processState } = await import("./triage-provider.ts");
    const { HOME_CHECKOUT } = await import("./project-config.ts");
    const switches = readSwitches(decisionSwitchesPath(HOME_CHECKOUT), { diagnostic: () => {}, state: processState, read: readFileSync });
    return new Set(Object.entries(switches).filter(([, on]) => on === true).map(([use]) => use));
  } catch {
    // A declaration that cannot be read is a host with no provider to improve: this use is optional, and the tick's other reads say what is wrong with the host.
    return new Set();
  }
}

async function liveReading(argv: readonly string[]): Promise<ConfidenceReading> {
  const since = flagText(argv, "since");
  const windowMs = since === undefined ? DEFAULT_WINDOW_MS : parseWindow(since);
  if (windowMs === undefined) cannotAsk(`--since takes a number and m, h or d (30m, 24h, 7d), not ${JSON.stringify(since)}.`);
  let logPath = flagValue(argv, "log");
  if (logPath === undefined) {
    const { stateEntryPath } = await import("./host-config.ts");
    const { decisionLogPathFrom } = await import("./decision-provider.ts");
    logPath = decisionLogPathFrom(stateEntryPath("wake-ledger"));
  }
  return confidenceReading(readLog(logPath), { now: Date.now(), windowMs });
}

function printCheck(reading: ConfidenceReading, key: string): never {
  const { verdict, row } = questionVerdict(reading, key);
  const figures = row === undefined ? "it was not asked in the window" : `${row.underFloor} of ${row.asked} under the floor (${percent(row.underFloorShare)})`;
  process.stdout.write(`${key}: ${verdict}: ${figures}. The bar is more than ${percent(MIN_UNDER_FLOOR_SHARE)} of at least ${MIN_DECISIONS}.\n`);
  return process.exit(verdict === "settled" ? EXIT.OK : verdict === "still-low" ? EXIT.STILL_LOW : EXIT.CANNOT_ASK);
}

/** What a run would file, one line a question, with the title; `--file` is what files it. */
function describePlan(reading: ConfidenceReading, plan: ReturnType<typeof candidates>): string {
  if (plan.file.length === 0 && Object.keys(plan.skipped).length === 0) return `No question is under the floor on more than ${percent(MIN_UNDER_FLOOR_SHARE)} of at least ${MIN_DECISIONS} decisions: nothing to file.`;
  const lines = [
    ...plan.file.map((row) => `WOULD FILE: ${improvementTitle(row)} (${row.underFloor} of ${row.asked}, ${percent(row.underFloorShare)}; mean ${number(row.meanConfidence)}, median ${number(row.medianConfidence)})`),
    ...Object.entries(plan.skipped).map(([key, outcome]) => `NOT FILED: ${key}: ${"skipped" in outcome ? outcome.skipped : "refused" in outcome ? outcome.refused : ""}`),
  ];
  return [`Provider low confidence, ${day(reading.since)} to ${day(reading.until)}`, "", ...lines].join("\n");
}

/** `gh` and the home tracker's repository, resolved only when a question may be filed: a host with no provider never needs either. */
async function liveTracker(argv: readonly string[]): Promise<{ run: Gh; repo: string }> {
  const { execFileSync } = await import("node:child_process");
  const { homeProjectDeclaration } = await import("./project-config.ts");
  const run: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { run, repo: flagValue(argv, "repo") ?? homeProjectDeclaration().repo };
}

async function fileMode(argv: readonly string[], reading: ConfidenceReading, io: Pick<FilingIo, "uses" | "run" | "repo">): Promise<void> {
  const session = flagValue(argv, "session");
  if (session === undefined) cannotAsk("--file takes --session=<you>: a row filed as nobody has no owner to ask.");
  const { runRowFile } = await import("./class-repeat.ts");
  process.stdout.write(`${JSON.stringify(fileLowConfidence(reading, { ...io, fileRow: runRowFile, session }), null, 2)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(["--since", "--since=", "--log=", "--question=", "--file", "--session=", "--repo="], { entry: import.meta.url, command: "node src/provider-low-confidence.ts" });
  const reading = await liveReading(process.argv);
  const key = flagValue(argv, "question");
  if (key !== undefined) printCheck(reading, key);
  const uses = await liveUses();
  if (uses.size === 0) {
    process.stdout.write(`${NO_PROVIDER}\n`);
    process.exit(EXIT.OK);
  }
  const io = { uses, ...await liveTracker(argv) };
  if (argv.includes("--file")) await fileMode(argv, reading, io);
  else process.stdout.write(`${describePlan(reading, candidates(reading, io))}\n`);
  process.exit(EXIT.OK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
