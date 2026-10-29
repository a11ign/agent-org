// @ts-check
// module: what the pool reads from a run's files -- its outcome, its plan files, and the lines it quotes to a worker

import { type WrittenOutcome } from "./queue/queue-entries-and-outcomes.ts";
import { join } from "node:path";
import { conflictLine, OUTCOME_FILE, PUBLISHED_FILE, STALE_OUTCOME_FILE } from "./worker-files.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { checkOutcome, isStale } from "./outcome.ts";
import { escalationReason } from "./escalation.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { BaseMergeStep } from "./queue/run-log.ts";

/** The largest file a planning run's plan may hold. A plan is prose; anything bigger is not one. */
export const PLAN_FILE_BYTES = 1_000_000;

/** How much of a batch ticket's `QUESTION.md` becomes the reason its run hands it to a person. */
export const QUESTION_CHARS = 500;

/**
 * The comment the board posts on a ticket it completes on its worker's `done` (A11-91): the reason, the evidence as a list, and whose verdict the
 * completion is. PURE.
 */
export const doneComment = ({ reason, evidence }: Readonly<{ reason: string; evidence: readonly string[] }>): string =>
  [reason, `Evidence:\n${evidence.map((line) => `- ${line}`).join("\n")}`, "Completed by the ticket board on the worker's verified outcome."].join("\n\n");

/**
 * The outcome a worker wrote, or `needs-human` saying why the file is not one: the field the contract wants and what the file holds in its place (the
 * text the Stop hook refuses it with, A11-118). An unreadable file is flagged, so a corrected one is read again. A `working` one is not how the run
 * ended: `settle` records it as the run's latest note. PURE over the file's text.
 */
/**
 * Marks a run's outcome stale, beside the file: the stop hook judges an outcome written at or before `since` (ms) as no outcome, so its worker writes a
 * new one. Nothing is moved, so the worker's own file is never taken from it (A11-152).
 */
export function markOutcomeStale(dir: string, since: number): void {
  writeFileSync(join(dir, STALE_OUTCOME_FILE), `${since}\n`);
}

/**
 * Whether the worker wrote the outcome file beside `dir` since its run was marked stale. A file the run parked on is no outcome for the board either, so a
 * worker that ends with none ends the run with none, as the stop hook judges it (A11-152).
 */
export function outcomeWritten(dir: string): boolean {
  const path = join(dir, OUTCOME_FILE);
  if (!existsSync(path)) return false;
  const mark = join(dir, STALE_OUTCOME_FILE);
  return !isStale(statSync(path).mtimeMs, existsSync(mark) ? readFileSync(mark, "utf8") : undefined);
}

export function parseOutcome(text: string, { talk = false }: Readonly<{ talk?: boolean }> = {}): WrittenOutcome {
  const checked = checkOutcome(text);
  if (!checked.ok) return { kind: "needs-human", reason: `the worker's outcome file is not valid: ${checked.problem}`, unreadable: true };
  const { outcome } = checked;
  if (outcome.kind === "published" || outcome.kind === "drafted") return { kind: "needs-human", reason: `the worker wrote ${outcome.kind}, which this run cannot end on` };
  // The card says which item of the escalation list a stop is for, or that it is on none (A11-257). A talk session's stop only says it waits for the person in its terminal.
  return outcome.kind === "needs-human" && !talk ? { ...outcome, reason: escalationReason(outcome.escalation, outcome.reason) } : outcome;
}

/**
 * How a publish run ended, from its outcome file's text and the links file in `dir` beside it, which this reads: the messages it posted, or why
 * it failed. A `published` outcome needs the links file, a list of web addresses, which may be empty.
 */
export function publishResult(outcomeText: string, dir: string): Readonly<{ links: readonly string[] } | { failure: string }> {
  let outcome: Record<string, unknown> | null = null;
  try {
    outcome = JSON.parse(outcomeText) as Record<string, unknown> | null;
  } catch {
    // reported below
  }
  if (outcome === null || typeof outcome !== "object") return { failure: `its outcome file could not be read: ${outcomeText.slice(0, 200)}` };
  if (outcome.kind === "needs-human") return { failure: String(outcome.reason ?? "it handed the run back") };
  if (outcome.kind !== "published") return { failure: `it wrote the outcome ${JSON.stringify(outcome.kind)}, which a publish run cannot end on` };
  const path = join(dir, PUBLISHED_FILE);
  try {
    const links = (JSON.parse(readFileSync(path, "utf8")) as { links?: unknown }).links;
    if (Array.isArray(links) && links.every((link) => typeof link === "string" && /^https:\/\/\S+$/.test(link))) return { links };
  } catch {
    // falls through to the refusal below
  }
  return { failure: `it wrote published, but ${path} does not hold { "links": ["https://..."] }` };
}

/**
 * What the board did about a pull request that conflicts with its base or is behind it, at one head (A11-286), as the pool keeps it in memory by the pull request's address: `head` is the commit it was done at, and `step` is
 * what was done ({@link BaseMergeStep}), or `listing` while the files of a real conflict are being read, or `refused` when the host would not update the branch (`reason`, GitHub's first line), which is asked again on the next sweep.
 * `files` are the files a real conflict touches: null when they could not be listed, absent before they were. `baseSha` is the commit the base was at when they were listed, null when it could not be read (A11-374). `at` is when the step was recorded (the pool's clock), which tells a merge the host accepted that never moved the head.
 */
export type BaseMerge = Readonly<{ head: string; step: BaseMergeStep | "listing" | "refused"; files?: readonly string[] | null; baseSha?: string | null; reason?: string; at?: number }>;

/** What the board has done about each pull request's base, by the pull request's address. */
export type BaseMerges = ReadonlyMap<string, BaseMerge>;

/** The `git` command that merges `base` into a branch, as a conflict round's brief gives it. */
export const mergeCommand = (base: string | null): string => `git fetch origin ${base ?? "<base>"} && git merge origin/${base ?? "<base>"}`;

/**
 * The two lines a conflict round adds to the conflict line once the board's own merge of the base reported a real conflict (A11-286): the files it conflicted in (or that they could not be listed), and the merge command to run, so the worker
 * starts from what the merge found. PURE.
 */
export function baseMergeLines(base: string | null, files: readonly string[] | null | undefined): readonly string[] {
  const named = base ?? "its base";
  const conflicted = files === undefined || files === null || files.length === 0 ? `Merging ${named} into it conflicted, and the board could not list the files.` : `Merging ${named} into it conflicted in ${files.join(", ")}.`;
  return [conflicted, `Merge it with: ${mergeCommand(base)}, resolve the files above, run the tests and push.`];
}

/**
 * The lines about one conflicting pull request, given what the board did about its base at the head it is read at: none while the board's merge is under way (`merging`, or the files of a conflict are being listed), the conflict line and the two
 * lines of {@link baseMergeLines} once the merge found a real conflict (`round`), and the conflict line alone otherwise. PURE.
 */
function conflictOf(url: string, read: PullFeedback, merges: BaseMerges | undefined): readonly string[] {
  const done = merges?.get(url);
  const at = done !== undefined && done.head === read.head ? done : undefined;
  if (at?.step === "merging" || at?.step === "listing") return [];
  return [conflictLine(url, read.base), ...(at?.step === "round" ? baseMergeLines(read.base, at.files) : [])];
}

/**
 * What new feedback, if any, reached a run's pull requests after `since`, the end of its last round, as the round's brief names it: the newest
 * comments and who left them; and each pull request that conflicts with its base. Null when nothing is newer. The checks that failed are not here: they are
 * answered once for each head they are red at, with their log lines (`answerChecks`, A11-154). A conflict the board is merging the base into is not named, and one its merge found real is named with the files and the command (`merges`, A11-286). PURE.
 */
export function feedbackSince(reads: readonly Readonly<{ url: string; read: PullFeedback }>[], since: number, merges?: BaseMerges): string | null {
  const lines = reads.filter(({ read }) => read.state === "open").flatMap(({ url, read }) => [
    // A conflict is a state, so its line does not wait for `since`: it is named on every watch until the pull request is clear of it.
    ...(read.conflicting ? conflictOf(url, read, merges) : []),
    ...(read.feedbackAt !== null && read.feedbackAt > since ? [`New review feedback on ${url}, the newest from ${read.authors[0] ?? "someone"}.`] : []),
  ]);
  return lines.length === 0 ? null : lines.join("\n");
}

/**
 * The conflict lines of a run's open pull requests, as {@link feedbackSince} names them, and no other feedback: all that wakes a parked run
 * (A11-89). Null when none of them conflicts. PURE.
 */
export function conflictLines(reads: readonly Readonly<{ url: string; read: PullFeedback }>[], merges?: BaseMerges): string | null {
  const lines = reads.filter(({ read }) => read.state === "open" && read.conflicting).flatMap(({ url, read }) => conflictOf(url, read, merges));
  return lines.length === 0 ? null : lines.join("\n");
}
