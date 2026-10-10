// #4748 (use 1 and 2 of a11ign#4627): THE PROVIDER'S CONFIDENCE, READ. Every decision record carries a `confidence` per answer and a `fellBack` flag, and until this module nobody counted them:
// a `score` at 0.61 and a `subsystems` at 0.46 were found by reading the log by eye. This turns the decision log (`decision-provider.ts`'s `logged` lines) into one row per use and question: the
// decisions asked, the share held back for being under the floor, and the mean and median confidence the provider gave.
//
// A FALL-BACK FOR BEING UNDER THE FLOOR AND A FALL-BACK FOR ANYTHING ELSE ARE DIFFERENT FINDINGS. An answer held back by the floor still carries a `confidence` and the `asked` value it replaced
// (`settle`); a refusal, a 422, a timeout or an unreadable answer carries neither. The first is the provider telling us it was unsure, and is what "give it better confidence" is about; the second is
// the provider not answering, counted apart and never as low confidence, because a floor tuned against a 422 would be tuned against nothing.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627): with no provider, no key or the use switched off nothing was asked and no line was written, so the reading is empty and says so, quietly.
//
// A LINE THIS MODULE CANNOT READ IS COUNTED AND NAMED (its position in the log), never dropped: a reading that skipped lines without saying would look complete and be wrong by exactly the
// lines that mattered. Posting this daily is a later row (a11ign#4748's done-when 3); this one builds the reading and a CLI that prints it.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "@a11ign/toolchain/lib/cli-flags";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/** The widest window a `Date` can start: 100,000,000 days, the range of JavaScript's time value. A wider one has no start to print, so it is refused and not turned into a `RangeError` at the end of the CLI. */
export const MAX_WINDOW_MS = 8.64e15;
/** The reading is DAILY, so a bare `node src/provider-confidence.ts` asks for the last day. */
export const DEFAULT_WINDOW_MS = MS_PER_DAY;
/** The line numbers a formatted reading names before it says how many more there were. */
const NAMED_LINES = 10;
const PERCENT = 100;
const EMPTY_READING = "no provider decisions in the window";

/** What `settle` writes for an answer the floor held back: `under the floor 0.7`. The number is read off the line, because the floor is the host's and a question's own, not this module's. */
const FLOOR_IN_REASON = /under the floor (\d*\.?\d+)/;

export type ConfidenceRow = {
  use: string;
  question: string;
  /** Decisions in the window that put this question to the provider. */
  asked: number;
  /** Of those, answers the provider gave and the floor held back. A fall-back for any other reason is `otherFallback`. */
  underFloor: number;
  /** Answers replaced for a reason that is not the floor: a refusal, a 422, a timeout, an unreadable answer. */
  otherFallback: number;
  /** Answers that carried a confidence, which is what `meanConfidence` and `medianConfidence` are over (an answer held back by the floor included: it is what the provider said). */
  answered: number;
  underFloorShare: number;
  meanConfidence: number | undefined;
  medianConfidence: number | undefined;
  /** `lines`: the floor an under-floor answer in the window named. `declared`: the host's own, shown because no answer fell under it. Absent: neither is known. */
  floor: { value: number; from: "lines" | "declared" } | undefined;
};

export type ConfidenceReading = {
  since: number;
  until: number;
  /** Decision lines in the window, one per time the provider was asked. */
  decisions: number;
  rows: ConfidenceRow[];
  /** Lines that were not JSON, or were JSON this module could not read as a decision or an outcome. `lines` are 1-based positions in the input, whatever the window. */
  unreadable: { count: number; lines: number[] };
};

type AnswerReading = { fellBack: boolean; confidence: number | undefined; underFloor: boolean; floor: number | undefined };
type DecisionLine = { use: string; at: number; answers: Array<[string, AnswerReading]> };
type Parsed = { kind: "decision"; decision: DecisionLine } | { kind: "outcome" } | { kind: "blank" } | { kind: "unreadable" };
type Tally = { use: string; question: string; asked: number; underFloor: number; otherFallback: number; confidences: number[]; floor: { value: number; at: number } | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function floorIn(reason: unknown): number | undefined {
  const named = typeof reason === "string" ? FLOOR_IN_REASON.exec(reason)?.[1] : undefined;
  return named === undefined ? undefined : Number(named);
}

/** One answer of a decision line, or `undefined` when it is not the shape `decision-provider` writes (a `fellBack` boolean, a `confidence` that is a number when it is there at all). */
function readAnswer(raw: unknown): AnswerReading | undefined {
  if (!isRecord(raw) || typeof raw.fellBack !== "boolean") return undefined;
  if (raw.confidence !== undefined && !isNumber(raw.confidence)) return undefined;
  const confidence = raw.confidence;
  // `asked` is the provider's own answer, kept when the floor replaced it: an answer with a confidence and an `asked` that fell back fell back FOR the floor, whatever words the reason uses.
  const underFloor = raw.fellBack && confidence !== undefined && raw.asked !== undefined;
  return { fellBack: raw.fellBack, confidence, underFloor, floor: underFloor ? floorIn(raw.reason) : undefined };
}

function readDecision(line: Record<string, unknown>): DecisionLine | undefined {
  if (typeof line.use !== "string" || line.use === "" || !isNumber(line.at) || !isRecord(line.answers)) return undefined;
  const answers: Array<[string, AnswerReading]> = [];
  for (const [question, raw] of Object.entries(line.answers)) {
    const answer = readAnswer(raw);
    if (answer === undefined) return undefined;
    answers.push([question, answer]);
  }
  return { use: line.use, at: line.at, answers };
}

/** `recordOutcome` appends `{ use, id, outcome, at }` after a decision: understood, and not a decision asked, so it is neither counted nor reported as unreadable. */
const isOutcome = (line: Record<string, unknown>): boolean =>
  typeof line.use === "string" && typeof line.outcome === "string" && isNumber(line.at) && line.answers === undefined;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A line that is not JSON is the `unreadable` kind, which is how the caller hears of it: it is counted and named, not lost.
    return undefined;
  }
}

function parseLine(raw: unknown): Parsed {
  // A blank line is the log's trailing newline, not a record; the JSON text `null` is a line and is not one this module can read.
  if (typeof raw === "string" && raw.trim() === "") return { kind: "blank" };
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)) return { kind: "unreadable" };
  if (isOutcome(value)) return { kind: "outcome" };
  const decision = readDecision(value);
  return decision === undefined ? { kind: "unreadable" } : { kind: "decision", decision };
}

function tallyFor(tallies: Map<string, Tally>, use: string, question: string): Tally {
  const key = JSON.stringify([use, question]);
  let tally = tallies.get(key);
  if (tally === undefined) {
    tally = { use, question, asked: 0, underFloor: 0, otherFallback: 0, confidences: [], floor: undefined };
    tallies.set(key, tally);
  }
  return tally;
}

function addAnswer(tally: Tally, answer: AnswerReading, at: number): void {
  tally.asked += 1;
  if (answer.confidence !== undefined) tally.confidences.push(answer.confidence);
  if (answer.underFloor) tally.underFloor += 1;
  else if (answer.fellBack) tally.otherFallback += 1;
  // The latest floor wins: a floor that was moved is the one now in force.
  if (answer.floor !== undefined && (tally.floor === undefined || at >= tally.floor.at)) tally.floor = { value: answer.floor, at };
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function rowOf(tally: Tally, declaredFloor: number | undefined): ConfidenceRow {
  const floor = tally.floor !== undefined ? { value: tally.floor.value, from: "lines" as const }
    : declaredFloor !== undefined ? { value: declaredFloor, from: "declared" as const } : undefined;
  return {
    use: tally.use, question: tally.question, asked: tally.asked, underFloor: tally.underFloor, otherFallback: tally.otherFallback,
    answered: tally.confidences.length, underFloorShare: tally.underFloor / tally.asked,
    meanConfidence: mean(tally.confidences), medianConfidence: median(tally.confidences), floor,
  };
}

export type ReadingOptions = {
  now: number;
  windowMs: number;
  /** The host's declared floor, for a row where no answer fell under it and so no line named one. */
  declaredFloor?: number;
};

/**
 * THE READING, over decision-log lines. A `string` is a raw log line; anything else is a line already parsed. The window is `[now - windowMs, now]` over each decision's `at`, so an older
 * line, and one from the future of `now`, is not counted. Rows come back ordered by use and then question.
 */
export function confidenceReading(lines: readonly unknown[], { now, windowMs, declaredFloor }: ReadingOptions): ConfidenceReading {
  if (!(windowMs > 0 && windowMs <= MAX_WINDOW_MS)) throw new RangeError(`the window must be from 1 to ${MAX_WINDOW_MS} milliseconds, not ${String(windowMs)}`);
  const since = now - windowMs;
  const tallies = new Map<string, Tally>();
  const unreadable: number[] = [];
  let decisions = 0;
  lines.forEach((raw, index) => {
    const parsed = parseLine(raw);
    if (parsed.kind === "unreadable") unreadable.push(index + 1);
    if (parsed.kind !== "decision" || parsed.decision.at < since || parsed.decision.at > now) return;
    decisions += 1;
    for (const [question, answer] of parsed.decision.answers) addAnswer(tallyFor(tallies, parsed.decision.use, question), answer, parsed.decision.at);
  });
  const rows = [...tallies.values()]
    .map((tally) => rowOf(tally, declaredFloor))
    .sort((a, b) => a.use.localeCompare(b.use) || a.question.localeCompare(b.question));
  return { since, until: now, decisions, rows, unreadable: { count: unreadable.length, lines: unreadable } };
}

const percent = (share: number): string => `${Math.round(share * PERCENT)}%`;
const confidenceText = (value: number | undefined): string => (value === undefined ? "-" : value.toFixed(2));
const floorText = (floor: ConfidenceRow["floor"]): string =>
  floor === undefined ? "not known" : `${floor.value}${floor.from === "declared" ? " (declared)" : ""}`;

function table(rows: readonly string[][]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
}

function unreadableText({ count, lines }: ConfidenceReading["unreadable"]): string[] {
  if (count === 0) return [];
  const named = lines.slice(0, NAMED_LINES).join(", ");
  const more = count > NAMED_LINES ? ` and ${count - NAMED_LINES} more` : "";
  return [`${count} log line${count === 1 ? "" : "s"} could not be read and ${count === 1 ? "is" : "are"} not in this reading: line ${named}${more}.`];
}

/** The plain table a person reads: one row per question, the floor beside it. An empty reading says `no provider decisions in the window` and still names any unreadable line. */
export function formatConfidenceReading(reading: ConfidenceReading): string {
  const span = `${new Date(reading.since).toISOString()} to ${new Date(reading.until).toISOString()}`;
  const head = [`Provider confidence, ${span}`, ""];
  if (reading.rows.length === 0) return [...head, EMPTY_READING, ...unreadableText(reading.unreadable)].join("\n");
  const cells = reading.rows.map((row) => [
    row.use, row.question, String(row.asked), String(row.underFloor), percent(row.underFloorShare), String(row.otherFallback),
    String(row.answered), confidenceText(row.meanConfidence), confidenceText(row.medianConfidence), floorText(row.floor),
  ]);
  const header = ["use", "question", "asked", "under floor", "share", "other fallback", "answered", "mean", "median", "floor"];
  return [
    ...head, ...table([header, ...cells]), "",
    `${reading.decisions} decision${reading.decisions === 1 ? "" : "s"} asked in the window.`,
    "under floor: the provider answered and the floor held it back. other fallback: a refusal, a 422, a timeout or an unreadable answer, never counted as low confidence.",
    "mean and median are over the answers that carried a confidence, an under-floor one included.",
    ...unreadableText(reading.unreadable),
  ].join("\n");
}

const WINDOW_UNITS: Readonly<Record<string, number>> = { m: MS_PER_MINUTE, h: MS_PER_HOUR, d: MS_PER_DAY };

/** `30m`, `24h` or `7d` as milliseconds; anything else, or a span past {@link MAX_WINDOW_MS}, is `undefined`, because a window guessed at would be a reading of some other span. */
export function parseWindow(text: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(text);
  const unit = match?.[2] === undefined ? undefined : WINDOW_UNITS[match[2]];
  const count = match?.[1] === undefined ? 0 : Number(match[1]);
  const span = unit === undefined ? 0 : count * unit;
  return span > 0 && span <= MAX_WINDOW_MS ? span : undefined;
}

/** `--since 24h` and `--since=24h` are the same request: the row spells the first, the repository's other commands the second. */
function sinceFrom(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--since");
  return at === -1 ? flagValue(argv, "since") : argv[at + 1];
}

// THE HOST IS IMPORTED WHEN THE CLI NEEDS IT, NOT AT THE TOP. The modules that know the host resolve its checkout on import, so a top-level import would make the reading itself (and its test)
// refuse on a machine with no `AGENT_ORG_HOST` for a question that is only about lines it is handed.

/** The host's declared floor when it declares a provider; a host whose declaration cannot be read says so and shows no floor it did not see on a line. */
async function declaredFloorOrNone(): Promise<number | undefined> {
  try {
    const triage = (await import("./host-config.ts")).homeHostConfig().triage;
    return triage?.provider === "jev" ? triage.minConfidence : undefined;
  } catch {
    process.stderr.write("agent-org: provider-confidence: the host declaration could not be read, so a floor is shown only where a log line named one\n");
    return undefined;
  }
}

const EXIT = { REPORTED: 0, CANNOT_ASK: 2 };

function cannotAsk(message: string): never {
  process.stderr.write(`CANNOT ASK: ${message}\n`);
  process.exit(EXIT.CANNOT_ASK);
}

/** An absent log is the provider never having been asked, so the reading is empty; any other failure to read it is not that, and is not reported as that. */
function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    return cannotAsk(`the decision log could not be read (${(err as { code?: string })?.code ?? "unknown error"}). That is a failed read, NOT a provider asked nothing.`);
  }
}

/** The decision log beside this host's wake ledger. Not working that out is not an empty log: it is asked for `--log`. */
async function hostLogPath(): Promise<string> {
  try {
    const { stateEntryPath } = await import("./host-config.ts");
    const { decisionLogPathFrom } = await import("./decision-provider.ts");
    return decisionLogPathFrom(stateEntryPath("wake-ledger"));
  } catch (err) {
    return cannotAsk(`the decision log's place could not be worked out (${(err as Error)?.name ?? "unknown error"}); pass --log=<path>.`);
  }
}

async function main(): Promise<void> {
  refuseUnknownFlags(["--since", "--since=", "--log="], { entry: import.meta.url, command: "node src/provider-confidence.ts" });
  const since = sinceFrom(process.argv);
  const windowMs = since === undefined ? DEFAULT_WINDOW_MS : parseWindow(since);
  if (windowMs === undefined) cannotAsk(`--since takes a number and m, h or d (30m, 24h, 7d), not ${JSON.stringify(since)}.`);
  const logPath = flagValue(process.argv, "log") ?? await hostLogPath();
  const reading = confidenceReading(readLog(logPath), { now: Date.now(), windowMs, declaredFloor: await declaredFloorOrNone() });
  process.stdout.write(`${formatConfidenceReading(reading)}\n`);
  process.exit(EXIT.REPORTED);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
