/**
 * a11ign/a11ign#4679: ONE GUARD EVERY WRITER OF `answer:<session>` ASKS FIRST. At 2026-10-09T23:00:59Z to 23:01:56Z the workers account added `answer:orchestrator` and
 * `answer:product-manager` to about two dozen rows, closed ones included, none with a question: each label woke its owner with nothing to answer, and both cleared them by hand.
 * The label means "this session owes an answer"; a closed row owes nothing, and a row whose newest comment asks nobody anything has nothing to answer either.
 *
 * REFUSES, with the reason, rather than returning a boolean: the caller says why on its log, so a skipped label is a reading and not a silence. `null` is permitted.
 * The newest comment decides (a question asked and then answered by a later report is no longer owed), and an unreadable newest comment is a REFUSAL, never "allowed".
 */
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";

export type AnswerLabelFacts = {
  /** The row's state as the writer read it: `OPEN` or `CLOSED` (any case). */
  state: string;
  /** The row's newest comment, or `null` for a row with none. */
  lastComment: { body: string } | null;
  /** The session the label would wake (the part after `answer:`). */
  session: string;
};

const FENCE = /```[\s\S]*?```/g;

/** A question is a `?` outside code fences: a fenced command's `?` is a glob or a ternary, not the author asking. */
const asksSomething = (body: string): boolean => body.replace(FENCE, "").includes("?");

const namesSession = (body: string, session: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_-])${session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "i").test(body);

/** @returns `null` when the label may be added, else the reason it may not. */
export function answerLabelRefusal({ state, lastComment, session }: AnswerLabelFacts): string | null {
  if (state.toUpperCase() !== "OPEN") return `the row is ${state.toUpperCase() || "of unknown state"}, and a closed row owes nobody an answer`;
  if (lastComment === null) return `the row has no comment, so there is no question for ${session} to answer`;
  const body = lastComment.body ?? "";
  if (body.includes(CLAIM_RECORD_MARKER) && /\breleased by\b/.test(body) && namesSession(body, session)) return null;
  if (!asksSomething(body)) return `the newest comment asks nothing (no question mark outside a code fence), so ${session} would be woken with nothing to answer`;
  if (!namesSession(body, session)) return `the newest comment asks a question but does not name ${session}`;
  return null;
}
