// @ts-check
// module: a person's answer to a run that asked a question -- written into the ticket's Decisions, then sent to the run (A11-250)
//
// THE BOARD WRITES THE TICKET, AND ONLY FROM A PERSON'S REQUEST. `POST /api/queue/<KEY>/answer` is the one way a person's answer reaches a ticket's `## Decisions (<who>, <date>)`: the chairman session and the asks bot
// call it with the instance's key. The entry holds the question as the board holds it (the run's own `needs-human` reason, which nothing an agent writes later can change) and the answer as it was given. No worker's,
// planner's or reviewer's text is ever copied into one, so a reviewer that honours only what the ticket holds (`decisionsOf`) honours only what a person said.
//
// THE TICKET IS WRITTEN FIRST. A write the tracker refuses sends the run nothing. A message herdr refuses leaves the answer in the ticket, and a repeat of the same answer finds its entry there (`withAnswer`) and only
// sends. A run whose workspace is gone has nothing waiting: the answer stays in the ticket, and the run that works the ticket next reads it first.

import { isParked } from "./board-view/pull-status-and-notes.ts";
import { WHO_CHARS, withAnswer } from "./answer-decision.ts";
import { SETTLED, find, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { logAnswered, moveBriefing, recordAnswer } from "./queue/queue-answer.ts";
import { HERDR_CALL_MS, herdrRefusal } from "./pool-herdr.ts";
import { type PoolContext } from "./pool-context.ts";
import { runPlace, update } from "./pool-state.ts";
import { agentTargetAsync } from "./pool-resume.ts";
import { type TicketSource } from "./source.ts";
import { RELAY_DECISION } from "./brief-decisions.ts";
import { descriptionHash, ticketReadOf } from "./ticket-read.ts";

/** The most characters of an answer the route takes: a decision, not a document. */
export const ANSWER_CHARS = 4_000;

/** What the route is given: the answer, and the name the entry is headed with when the person gives one. */
export type Answer = Readonly<{ answer: string; who?: string }>;

/** What the route answers: the entry is in the ticket; `delivered` is whether the run was told, and `why` says why not. */
export type Answered = Readonly<{ written: true; delivered: boolean; why?: string }>;

/** The answer is in the ticket, and herdr would not take the message to the run: a repeat of the same answer only sends. */
export class AnswerNotDelivered extends Error {}

/** The board's local date, `YYYY-MM-DD`. */
export function dateOf(at: number): string {
  const day = new Date(at);
  return [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((part, at) => String(part).padStart(at === 0 ? 4 : 2, "0")).join("-");
}

/** Whether a name is not one non-empty line of at most {@link WHO_CHARS} characters. PURE. */
const badName = (who: string): boolean => who.trim() === "" || /[\r\n]/.test(who) || who.trim().length > WHO_CHARS;

/** Why the request itself is refused, or null: the answer is text of at most {@link ANSWER_CHARS}, and a name is one line of at most {@link WHO_CHARS}. PURE. */
function requestRefusal({ answer, who }: Answer): string | null {
  if (answer.trim() === "") return "the answer is empty";
  if (answer.trim().length > ANSWER_CHARS) return `the answer is over ${ANSWER_CHARS} characters`;
  if (who !== undefined && badName(who)) return `who is one line of at most ${WHO_CHARS} characters`;
  return null;
}

/** Why `key`'s run is not waiting on a person, or null when it is: finished on a `needs-human` the board could read, and its ticket not settled in the tracker. PURE. */
function waitingRefusal(key: string, entry: Entry | undefined): string | null {
  if (entry === undefined) return `${key} is not on the board`;
  if (entry.talk === true) return `${key} is a talk session, which a person is talking to in its terminal`;
  if (entry.phase !== "finished") return `${key} is ${entry.phase === "queued" ? "queued" : "still running"}, not waiting on a person`;
  if (SETTLED.has(entry.trackerState ?? "")) return `${key}'s ticket is ${entry.trackerState === "completed" ? "completed" : "closed"} in the tracker, so nothing waits for an answer`;
  if (entry.outcome?.kind !== "needs-human") return `${key} is not waiting on a person: its run ended ${entry.outcome?.kind ?? "with no outcome"}`;
  if (entry.outcome.unreadable === true) return `${key}'s outcome file could not be read, so there is no question to answer`;
  return null;
}

/** The name the entry is headed with: the one given, else the tracker's name for the key's person, else "a person". */
async function nameOf(source: TicketSource, who: string | undefined): Promise<string> {
  if (who !== undefined) return who.trim();
  try {
    return (await source.viewer?.())?.trim() || "a person";
  } catch {
    return "a person";
  }
}

/** The message the run is sent: who answered what, where the ticket records it, and what to do with it. */
function messageOf(entry: Entry, { question, answer, heading }: Told): string {
  const quoted = (text: string): string => text.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  return `A person answered your question through the board.\n\nYour question:\n\n${quoted(question)}\n\nTheir answer:\n\n${quoted(answer)}\n\n`
    + `The board recorded both in the ticket's Decisions, under the heading \`${heading}\`, at ${entry.ticket.url}. Carry on with that answer: it overrides the plan and your own preference where they differ. `
    + `${RELAY_DECISION} Write the outcome file again as the last thing you do.`;
}

/** What the run is told once the answer is in the ticket: the question, the answer as given and the heading the entry stands under. */
type Told = Readonly<{ question: string; answer: string; heading: string }>;

/**
 * Write the answer into the ticket's description, read fresh, unless it is there already, and move the run's copy of the ticket on. Throws, naming why, when the tracker has no such ticket or refuses the write: nothing
 * has been sent to the run then.
 */
async function writeAnswer(ctx: PoolContext, entry: Entry, given: Answer): Promise<Told> {
  const { now, source } = ctx;
  const key = entry.ticket.key;
  const question = entry.outcome?.kind === "needs-human" ? entry.outcome.reason.trim() : "";
  const fresh = await source.read(key);
  if (fresh === null) throw new Error(`the tracker has no ticket ${key}`);
  const at = now();
  const entered = withAnswer(fresh.description, { question, answer: given.answer.trim(), who: await nameOf(source, given.who), date: dateOf(at) });
  if (entered.added) {
    try {
      await source.updateTicketText?.(key, { description: entered.description });
    } catch (err) {
      throw new Error(`${key}'s Decisions could not be written (${String((err as Error)?.message ?? err).split("\n")[0]}): nothing was sent to the run`);
    }
  }
  const briefed = entry.briefedAgainst?.hash === descriptionHash(fresh.description);
  const read = ticketReadOf({ description: entered.description, updatedAt: fresh.updatedAt }, at);
  update(ctx, (queue) => (briefed ? moveBriefing(recordAnswer(queue, key, read), key, read) : recordAnswer(queue, key, read)));
  return { question, answer: given.answer, heading: entered.heading };
}

/**
 * Send the run its answer, if a run is waiting for it: one message to the agent of a parked run, which the pool then sees working again and resumes (`watchParked`). A run whose workspace is gone gets nothing, and
 * the answer says so. Throws {@link AnswerNotDelivered} when herdr refuses the message.
 */
async function deliver(ctx: PoolContext, key: string, told: Told): Promise<Answered> {
  const { herdrCall, now, settings, store } = ctx;
  const current = find(store.get(), key);
  if (current === undefined || !isParked(current) || current.outcome?.kind !== "needs-human") {
    return { written: true, delivered: false, why: `${key}'s run has no workspace open or is no longer waiting, so nothing is waiting for the answer: it is in the ticket, and the run that works the ticket next reads it first` };
  }
  try {
    await herdrCall(["--session", settings.herdrSession, "agent", "prompt", await agentTargetAsync(ctx, runPlace(ctx, current)), messageOf(current, told)], HERDR_CALL_MS);
  } catch (err) {
    throw new AnswerNotDelivered(`${key}'s answer is in the ticket, but herdr would not take it to the run (${herdrRefusal(err)}): answer again to send it, and nothing is written twice`);
  }
  update(ctx, (queue) => logAnswered(queue, key, now()));
  return { written: true, delivered: true };
}

/**
 * A person's answer to the run that is waiting on them for `key`. Refused, naming why, unless the run is finished on a `needs-human` the board could read and the ticket is not settled, the request is well formed,
 * and the tracker can write a ticket's text. Then the answer is written into the ticket ({@link writeAnswer}), and then sent to the run ({@link deliver}). Two answers for one ticket are not taken at once.
 */
export async function answer(ctx: PoolContext, key: string, given: Answer): Promise<Answered> {
  const { answering, source, store } = ctx;
  const entry = find(store.get(), key);
  const refusal = requestRefusal(given) ?? waitingRefusal(key, entry) ?? (source.updateTicketText === undefined ? `this tracker cannot edit ${key}'s text, so the answer cannot be recorded, and nothing is sent to the run` : null);
  if (refusal !== null || entry === undefined) throw new Error(refusal ?? `${key} is not on the board`);
  if (answering.has(key)) throw new Error(`an answer to ${key} is being written: send yours when it has been`);
  answering.add(key);
  try {
    return await deliver(ctx, key, await writeAnswer(ctx, entry, given));
  } finally {
    answering.delete(key);
  }
}
