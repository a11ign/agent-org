// @ts-check
// module: the outcome record (A11-430) -- one line per run in the board's outcome log, naming how each of its rounds ended and the tokens it spent, for the rollups by model, repository and label
//
// A RUN IS ITS FIRST START AND EVERY ROUND THAT CONTINUES IT: the review rounds, the talk sessions and the rounds a person's answer resumes, which all carry the run's `outcomeRun`. A retry
// starts a fresh worker, and so a new run. Each time a round ends, the run's whole record is appended again with that round added, so the log never waits for a run to be over (feedback can
// start another round days later): THE LATEST LINE OF A RUN IS ITS RECORD, and a reader keeps that one ({@link latestOutcomes}).
//
// AN UNREADABLE LOG IS AN ERROR, NOT EMPTY (A11-358): a line that is not a record throws, naming it. A log that does not exist yet holds no runs.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addModelTokens, type ModelTokens } from "./round-tokens.ts";

/** How one round of a run ended: when it started and ended, the outcome kind, the Claude session it ran in, and the tokens it spent, or why they could not be read. */
export type OutcomeRound = Readonly<{
  startedAt: number | null;
  endedAt: number;
  outcome: string;
  session?: string;
  /** The tokens the round's own turns spent, by model; absent when its transcript could not be read, which is `unread`, never 0. */
  tokens?: ModelTokens;
  unread?: string;
}>;

/** What a run carries from round to round: when it first started, and its rounds so far. */
export type OutcomeRun = Readonly<{ since: number; rounds: readonly OutcomeRound[] }>;

/** The batch a ticket's run planned it in: the batch's name, the ticket's place in it (from 1) and how many tickets shared the run's tokens. */
export type OutcomeBatch = Readonly<{ id: string; share: number; of: number }>;

/** One run's outcome record, as the log holds it. */
export type OutcomeRecord = Readonly<{
  v: 1;
  /** The run: its ticket and first start, `<key>@<ms>`. */
  run: string;
  ticket: string;
  at: number;
  model: string;
  effort: string;
  repos: readonly string[];
  labels: readonly string[];
  batch?: OutcomeBatch;
  rounds: readonly OutcomeRound[];
  /** How the run's latest round ended. */
  final: string;
  /** How many of its rounds ended handing it to a person. */
  needsYou: number;
  /** The time its rounds ran, added up: the waits between rounds are not the run's. */
  wallMs: number;
  /** The tokens of every round that could be read, by model. */
  tokens: ModelTokens;
}>;

/** The outcome log in `stateDir`. */
export const outcomesPath = (stateDir: string): string => join(stateDir, "tickets", "outcomes.jsonl");

/** What a run is known by apart from its rounds. */
export type OutcomeSubject = Readonly<{ ticket: string; model: string; effort: string; repos: readonly string[]; labels: readonly string[]; batch?: OutcomeBatch }>;

/** The record of a run with `rounds`, as it stands after its latest round. PURE. */
export function outcomeRecordOf(subject: OutcomeSubject, run: OutcomeRun): OutcomeRecord {
  const last = run.rounds.at(-1);
  if (last === undefined) throw new Error(`${subject.ticket}'s run has no round to record`);
  const { batch, ...rest } = subject;
  return {
    v: 1, run: `${subject.ticket}@${run.since}`, ...rest, ...(batch === undefined ? {} : { batch }), at: last.endedAt, rounds: run.rounds, final: last.outcome,
    needsYou: run.rounds.filter(({ outcome }) => outcome === "needs-human").length,
    wallMs: run.rounds.reduce((sum, { startedAt, endedAt }) => sum + (startedAt === null ? 0 : Math.max(0, endedAt - startedAt)), 0),
    tokens: addModelTokens(run.rounds.flatMap(({ tokens }) => (tokens === undefined ? [] : [tokens]))),
  };
}

/** Append `record` to the log at `path`, making its folder. Throws when it cannot be written. */
export function appendOutcome(path: string, record: OutcomeRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

const isRecord = (value: unknown): value is OutcomeRecord => {
  const record = value as Partial<Record<keyof OutcomeRecord, unknown>> | null;
  return typeof record === "object" && record !== null && record.v === 1 && typeof record.run === "string" && typeof record.ticket === "string" && typeof record.at === "number"
    && Array.isArray(record.rounds) && typeof record.tokens === "object" && record.tokens !== null;
};

/** Every line of the log at `path`, in order. None when there is no log yet. Throws, naming the line, when a line is not a record: an unreadable log is an error, not empty. */
export function readOutcomes(path: string): OutcomeRecord[] {
  if (!existsSync(path)) return [];
  const records: OutcomeRecord[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1} of the outcome log ${path} is not JSON`);
    }
    if (!isRecord(value)) throw new Error(`line ${index + 1} of the outcome log ${path} is not an outcome record`);
    records.push(value);
  }
  return records;
}

/** The record of each run: its latest line, in the order the runs first appear. PURE. */
export function latestOutcomes(records: readonly OutcomeRecord[]): OutcomeRecord[] {
  return [...new Map(records.map((record) => [record.run, record])).values()];
}
