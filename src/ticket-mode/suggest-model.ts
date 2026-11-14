// @ts-check
// module: the model and effort the queue footer suggests for the selected tickets (A11-435), from how past runs of their kind went in the outcome log (A11-430)
//
// ADVISORY ONLY: the suggestion is shown beside the batch's own choice, and the run starts on what the person queues. Nothing here chooses a model.
//
// A TICKET'S KIND is one of its labels in its repository. The selected tickets share a kind when they are all in one repository and all carry the label. For each kind they share, the
// past runs of that kind are grouped by model and effort; a group with fewer runs than `tickets.suggestMinSample` says nothing, and of the rest the one with the best first-pass rate is
// suggested, the larger sample winning a tie. Its reason and its sample size are always shown with it.
//
// FIRST PASS, as the outcome log can tell it: the run's worker delivered in one round, and no round followed to answer a review: one round ended `ready-pr`, `done` or `checked`, or a
// `draft-pr` round was followed only by the `reviewed` round a person's approval starts. A run that asked a person, crashed, stopped or was sent back for another round did not pass first time.
// Planning, publishing and wrong-repository runs are no worker's, and are not counted. A run that has passed so far is counted only once its latest round is UNDECIDED_MS old, since its
// review may still send it back; one that has failed is counted at once.

import { existsSync, statSync } from "node:fs";
import { latestOutcomes, type OutcomeRecord, outcomesPath, readOutcomes } from "./outcomes/outcome-record.ts";
import { repoOfProject } from "./project-repo.ts";
import type { Ticket } from "./source.ts";

/** How long a run that has passed so far waits before it counts as a first pass: its review may still send it back. */
export const UNDECIDED_MS = 24 * 60 * 60 * 1000;

/** What the footer shows: the model and effort, the first-pass rate as a whole percent, the sample size, the kind it was read from, and the reason in words. */
export type Suggestion = Readonly<{ model: string; effort: string; firstPass: number; n: number; label: string; repo: string; reason: string }>;

/** What `/api/suggestion` answers: the suggestion for the tickets it names, or null when there is none. */
export type SuggestionView = Readonly<{ suggestion: Suggestion | null }>;

/** What a ticket is matched to past runs by: its repository, or null when it names none on this machine, and its labels. */
export type TicketKind = Readonly<{ repo: string | null; labels: readonly string[] }>;

/** The kinds of run that are no worker's: they deliver nothing a review passes. */
const NOT_WORKER = new Set(["planned", "published", "drafted", "wrong-repo"]);
/** The single rounds that are a first pass. */
const DELIVERED = new Set(["ready-pr", "done", "checked"]);

/** Whether `record`'s rounds are a first pass so far: one round that delivered, or a draft and the review run its approval started. PURE. */
function passedSoFar({ rounds }: OutcomeRecord): boolean {
  const outcomes = rounds.map(({ outcome }) => outcome);
  if (outcomes.length === 1) return DELIVERED.has(outcomes[0] ?? "");
  return outcomes.length === 2 && outcomes[0] === "draft-pr" && outcomes[1] === "reviewed";
}

/** How a run counts toward a suggestion: a first pass, not one, or not at all: no worker's run, or a pass its review may still undo. */
export type FirstPass = "passed" | "failed" | "uncounted";

/** How `record`'s run counts toward a suggestion at `now`. PURE. */
export function firstPassOf(record: OutcomeRecord, now: number): FirstPass {
  if (record.rounds.some(({ outcome }) => NOT_WORKER.has(outcome))) return "uncounted";
  if (!passedSoFar(record)) return "failed";
  return now - record.at >= UNDECIDED_MS ? "passed" : "uncounted";
}

/** The repository named on the description's own `**Repository:** <repo>` line, which the board's ticket writers end a description with. */
const REPOSITORY_LINE = /^\*\*Repository:\*\*\s*`?([\w.-]+)`?\s*$/m;

/** A ticket's kind: the repository its project names, else the one its description's `**Repository:**` line names, as one of `clones`; and its labels' names. PURE. */
export function kindOf(ticket: Pick<Ticket, "projectSummary" | "description" | "labels">, clones: readonly string[]): TicketKind {
  const named = REPOSITORY_LINE.exec(ticket.description)?.[1];
  const repo = repoOfProject(ticket.projectSummary, clones) ?? (named !== undefined && clones.includes(named) ? named : null);
  return { repo, labels: (ticket.labels ?? []).map(({ name }) => name) };
}

/** The repository and labels a batch's tickets all share. */
type SharedKind = Readonly<{ repo: string; labels: readonly string[] }>;

/** The repository and labels every one of `kinds` shares, or null when they are not all in one known repository. PURE. */
function sharedKind(kinds: readonly TicketKind[]): SharedKind | null {
  const [first, ...rest] = kinds;
  if (first?.repo == null || rest.some(({ repo }) => repo !== first.repo)) return null;
  return { repo: first.repo, labels: first.labels.filter((label) => rest.every(({ labels }) => labels.includes(label))) };
}

type Group = { model: string; effort: string; label: string; passed: number; n: number };

/** The decided worker runs of `label` in `repo`, by model and effort. PURE. */
function groupsOf(records: readonly OutcomeRecord[], repo: string, label: string, now: number): Group[] {
  const groups = new Map<string, Group>();
  for (const record of records) {
    if (!record.repos.includes(repo) || !record.labels.includes(label)) continue;
    const counted = firstPassOf(record, now);
    if (counted === "uncounted") continue;
    const at = `${record.model}/${record.effort}`;
    const group = groups.get(at) ?? { model: record.model, effort: record.effort, label, passed: 0, n: 0 };
    group.n += 1;
    if (counted === "passed") group.passed += 1;
    groups.set(at, group);
  }
  return [...groups.values()];
}

/** The better of two groups: the higher first-pass rate, then the larger sample. PURE. */
const better = (a: Group, b: Group): Group => {
  const byRate = a.passed * b.n - b.passed * a.n;
  if (byRate !== 0) return byRate > 0 ? a : b;
  return b.n > a.n ? b : a;
};

type SuggestOptions = Readonly<{ minSample: number; now: number }>;

/**
 * The suggestion for a batch of tickets of `kinds`, from the outcome log's `records` (every line, or each run's latest), or null: when the tickets share no repository and label, or no model
 * and effort has `minSample` decided runs of a kind they share. PURE.
 */
export function suggestionOf(records: readonly OutcomeRecord[], kinds: readonly TicketKind[], options: SuggestOptions): Suggestion | null {
  const shared = sharedKind(kinds);
  return shared === null ? null : suggestionFor(records, shared, options);
}

/** The suggestion for tickets of the `shared` kind, from the outcome log's `records`, or null when no model and effort has `minSample` decided runs of a label they share. PURE. */
function suggestionFor(records: readonly OutcomeRecord[], shared: SharedKind, { minSample, now }: SuggestOptions): Suggestion | null {
  const runs = latestOutcomes(records);
  const candidates = shared.labels.flatMap((label) => groupsOf(runs, shared.repo, label, now)).filter(({ n }) => n >= minSample);
  if (candidates.length === 0) return null;
  const best = candidates.reduce(better);
  const firstPass = Math.round((100 * best.passed) / best.n);
  return {
    model: best.model, effort: best.effort, firstPass, n: best.n, label: best.label, repo: shared.repo,
    reason: `${firstPass}% first-pass, n=${best.n}, on ${best.label} tickets in ${shared.repo}`,
  };
}

/** The outcome log as last parsed, and the file's size and change time then. */
let parsed: Readonly<{ path: string; size: number; mtimeMs: number; records: readonly OutcomeRecord[] }> | null = null;

/**
 * The outcome log at `path`, parsed again only when its size or change time moved: the footer asks on each change of the selection, and the request thread answers every other read too.
 * A log that cannot be read throws each time, and is never kept.
 */
function outcomesAt(path: string): readonly OutcomeRecord[] {
  if (!existsSync(path)) return [];
  const { size, mtimeMs } = statSync(path);
  if (parsed?.path === path && parsed.size === size && parsed.mtimeMs === mtimeMs) return parsed.records;
  const records = readOutcomes(path);
  parsed = { path, size, mtimeMs, records };
  return records;
}

type SuggestionInput = Readonly<{ stateDir: string; tickets: readonly Ticket[]; clones: readonly string[] } & SuggestOptions>;

/** What `/api/suggestion` answers for `tickets`, read from the outcome log in `stateDir`. Throws, naming the line, when the log cannot be read: an unreadable log is an error, not "no suggestion". */
export function suggestionView({ stateDir, tickets, clones, minSample, now }: SuggestionInput): SuggestionView {
  const shared = sharedKind(tickets.map((ticket) => kindOf(ticket, clones)));
  // Tickets with no kind in common are not matched to any run, so the log is not read for them.
  if (shared === null || shared.labels.length === 0) return { suggestion: null };
  return { suggestion: suggestionFor(outcomesAt(outcomesPath(stateDir)), shared, { minSample, now }) };
}
