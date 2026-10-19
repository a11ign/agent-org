// @ts-check
// module: what the pool reads from a run's files -- its outcome and proposed edit, its plan files, and the lines it quotes to a worker

import { declaredRemains, type ProposedEdit, type WrittenOutcome } from "./queue/declared-remains.ts";
import { join } from "node:path";
import { conflictLine, PUBLISHED_FILE } from "./worker-files.ts";
import { readFileSync } from "node:fs";
import { type PullFeedback } from "../ticket-port/pull-feedback.ts";

/** The largest file a planning run's plan may hold. A plan is prose; anything bigger is not one. */
export const PLAN_FILE_BYTES = 1_000_000;

/** How much of a batch ticket's `QUESTION.md` becomes the reason its run hands it to a person. */
export const QUESTION_CHARS = 500;

/** A pull request outcome's `partial` declaration, what remains of the ticket, when the worker wrote one (A11-92). */
const partialOf = (value: Record<string, unknown>): { partial?: string } => {
  const remains = typeof value.partial === "string" ? declaredRemains(value.partial) : null;
  return remains === null ? {} : { partial: remains };
};

/**
 * The comment the board posts on a ticket it completes on its worker's `done` (A11-91): the reason, the evidence as a list, and whose verdict the
 * completion is. PURE.
 */
export const doneComment = ({ reason, evidence }: Readonly<{ reason: string; evidence: readonly string[] }>): string =>
  [reason, `Evidence:\n${evidence.map((line) => `- ${line}`).join("\n")}`, "Completed by the ticket board on the worker's verified outcome."].join("\n\n");

/** The longest title a worker may propose for its ticket, in characters (A11-91). */
const TITLE_CHARS = 255;

/** The longest description a worker may propose for its ticket, in characters (A11-91). */
const DESCRIPTION_CHARS = 60_000;

/** How much of an outcome file a reason quotes when the file cannot be used. */
const QUOTED_CHARS = 200;

/** The outcomes a worker may propose an edit on (A11-91): the three in which it has read its ticket closely. */
const EDIT_KINDS: ReadonlySet<string> = new Set(["done", "checked", "needs-human"]);

/** Whether a title is one line of 1 to {@link TITLE_CHARS} characters, as the board writes it (A11-91). PURE. */
const fitsTitle = (title: unknown): title is string => typeof title === "string" && title.trim() !== "" && title.length <= TITLE_CHARS && !title.includes("\n");

/** Whether a description is text of up to {@link DESCRIPTION_CHARS} characters (A11-91). PURE. */
const fitsDescription = (description: unknown): description is string => typeof description === "string" && description.length <= DESCRIPTION_CHARS;

/**
 * The edit a worker proposed on its outcome, read once: the title and description it proposes and why, or why it is not one the board can apply
 * (A11-91): an object with a `why`, and a title or a description, or both. PURE.
 */
export function readEdit(edit: unknown): ProposedEdit | string {
  if (typeof edit !== "object" || edit === null || Array.isArray(edit)) return "is not an object";
  const { title, description, why } = edit as Record<string, unknown>;
  if (typeof why !== "string" || why.trim() === "") return "has no why";
  const proposed: { title?: string; description?: string; why: string } = { why };
  if (title !== undefined) {
    if (!fitsTitle(title)) return `proposes a title that is not one line of 1 to ${TITLE_CHARS} characters`;
    proposed.title = title;
  }
  if (description !== undefined) {
    if (!fitsDescription(description)) return `proposes a description of more than ${DESCRIPTION_CHARS.toLocaleString("en-US")} characters`;
    proposed.description = description;
  }
  return proposed.title === undefined && proposed.description === undefined ? "proposes neither a title nor a description" : proposed;
}

/** The outcome field that carries a proposed edit, or nothing when the worker proposed none (A11-91). PURE. */
const editField = (edit: ProposedEdit | undefined): Readonly<{ edit?: ProposedEdit }> => (edit === undefined ? {} : { edit });

/** Whether a line of evidence is text the board keeps: a non-empty string (A11-91). PURE. */
const isEvidenceLine = (line: unknown): line is string => typeof line === "string" && line.trim() !== "";

/**
 * A `done` outcome, or a `needs-human` naming what it lacks: the board completes a ticket only on a reason and evidence that say what was checked
 * and what it showed (ADR 0021/0047: a prediction never fills an evidence field). PURE.
 */
function doneOutcome(value: Record<string, unknown>, edit: ProposedEdit | undefined): WrittenOutcome {
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const evidence: unknown[] = Array.isArray(value.evidence) ? value.evidence : [];
  const lines = evidence.filter(isEvidenceLine);
  if (reason === "" || lines.length === 0 || lines.length !== evidence.length) {
    const missing = reason === "" ? "a reason" : "evidence: a non-empty list of non-empty lines, one per Done-when item";
    return { kind: "needs-human", reason: `the worker wrote done without ${missing}, so the ticket was not completed` };
  }
  return { kind: "done", reason, evidence: lines.map((line) => line.trim()), ...editField(edit) };
}

/**
 * The outcome a worker wrote, or `needs-human` saying the file could not be read, or what in it cannot be used. A `working` one is not how the run
 * ended: `settle` records it as the run's latest note. PURE over the file's text.
 */
export function parseOutcome(text: string): WrittenOutcome {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const edit = EDIT_KINDS.has(String(value.kind)) && value.edit !== undefined ? readEdit(value.edit) : undefined;
    if (typeof edit === "string") return { kind: "needs-human", reason: `the worker's proposed edit to the ticket ${edit}, so nothing was proposed: ${text.slice(0, QUOTED_CHARS)}` };
    if (value.kind === "done") return doneOutcome(value, edit);
    if (value.kind === "draft-pr" && Array.isArray(value.prs)) {
      return { kind: "draft-pr", prs: value.prs.map((pr: Record<string, unknown>) => ({ repo: String(pr.repo ?? ""), url: String(pr.url ?? "") })), ...partialOf(value) };
    }
    if (value.kind === "ready-pr" && Array.isArray(value.prs)) {
      return { kind: "ready-pr", prs: value.prs.map((pr: Record<string, unknown>) => ({ repo: String(pr.repo ?? ""), url: String(pr.url ?? "") })), ...partialOf(value) };
    }
    if (value.kind === "planned") return { kind: "planned" };
    if (value.kind === "checked") return { kind: "checked", reason: String(value.reason ?? ""), ...editField(edit) };
    // A review run's pull requests are the ones the person approved, which the pool holds: `settle` puts them in.
    if (value.kind === "reviewed") return { kind: "reviewed", prs: [] };
    if (value.kind === "wrong-repo") return { kind: "wrong-repo", where: String(value.where ?? "") };
    if (value.kind === "needs-human") return { kind: "needs-human", reason: String(value.reason ?? ""), ...editField(edit) };
    if (value.kind === "working") return { kind: "working", reason: String(value.reason ?? "") };
  } catch {
    // falls through to the unreadable outcome below
  }
  return { kind: "needs-human", reason: `the worker's outcome file could not be read: ${text.slice(0, QUOTED_CHARS)}` };
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
 * What new feedback, if any, reached a run's pull requests after `since`, the end of its last round, as the round's brief names it: the newest
 * comments and who left them, and the checks that failed; and each pull request that conflicts with its base. Null when nothing is newer. PURE.
 */
export function feedbackSince(reads: readonly Readonly<{ url: string; read: PullFeedback }>[], since: number): string | null {
  const lines = reads.filter(({ read }) => read.state === "open").flatMap(({ url, read }) => [
    // A conflict is a state, so its line does not wait for `since`: it is named on every watch until the pull request is clear of it.
    ...(read.conflicting ? [conflictLine(url, read.base)] : []),
    ...(read.feedbackAt !== null && read.feedbackAt > since ? [`New review feedback on ${url}, the newest from ${read.authors[0] ?? "someone"}.`] : []),
    ...(read.failedAt !== null && read.failedAt > since ? [`${read.failing.join(", ")} failed on the head commit of ${url}.`] : []),
  ]);
  return lines.length === 0 ? null : lines.join("\n");
}

/**
 * The conflict lines of a run's open pull requests, as {@link feedbackSince} names them, and no other feedback: all that wakes a parked run
 * (A11-89). Null when none of them conflicts. PURE.
 */
export function conflictLines(reads: readonly Readonly<{ url: string; read: PullFeedback }>[]): string | null {
  const lines = reads.filter(({ read }) => read.state === "open" && read.conflicting).map(({ url, read }) => conflictLine(url, read.base));
  return lines.length === 0 ? null : lines.join("\n");
}
