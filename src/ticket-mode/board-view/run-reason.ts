// @ts-check
// module: the reason line a run's card shows, and the question it keeps one click away (PURE)
import { pullAnswer, type PullAnswer } from "./pull-answer.ts";
import { rebaseNote, retargetNote, verdictNote, workingNote } from "./pull-status-and-notes.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

/** The words a card's reason line says for an answered run, in place of its question. */
const ANSWER_LINE: Readonly<Record<PullAnswer, string>> = { approved: "Approved", answered: "Answered: awaiting review" };

/** What the worker says of a run: its handed-back reason, the background work it is waiting on, the question it asked, why it stopped, or where its work belongs. PURE. */
function askedReason(entry: ViewEntry): string | null {
  const outcome = entry.outcome;
  const note = workingNote(entry);
  if (entry.handedBack) return entry.handedBack;
  if (note !== null && !note.stalled) return note.text;
  if (outcome === undefined) return null;
  if (outcome.kind === "wrong-repo") return `Belongs in: ${outcome.where}`;
  if (outcome.kind === "no-outcome") return "Stopped without writing an outcome";
  return ["needs-human", "crashed", "checked", "done"].includes(outcome.kind) ? outcome.reason ?? null : null;
}

/**
 * The reason line a run's card shows, and the question it keeps one click away. A needs-human run whose pull requests answered it says "Answered: awaiting
 * review" or "Approved" from them, and keeps what it asked as `question`. A text the card already shows as the rebase, retarget or verdict note is not said a
 * second time, as the line or as the question (A11-153). PURE.
 */
export function reasonOf(entry: ViewEntry): Readonly<{ line: string | null; question: string | null }> {
  const shown = [rebaseNote(entry), retargetNote(entry), verdictNote(entry)];
  const once = (text: string | null): string | null => (text === null || shown.includes(text) ? null : text);
  const asked = once(askedReason(entry));
  const answer = pullAnswer(entry);
  return answer === null ? { line: asked, question: null } : { line: ANSWER_LINE[answer], question: asked };
}

