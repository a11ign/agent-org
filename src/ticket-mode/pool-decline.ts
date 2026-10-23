// @ts-check
// module: declining a Claude Code safety prompt on an unattended run -- read the pane, answer No, tell the agent why (A11-174)
//
// Claude Code asks a person before some commands even with permissions bypassed (A11-160: `rm -f $SC/*.done` on a variable that could be empty), and nobody answers on an unattended run.
// The pool does what the chairman did by hand: it answers No with Esc, the key the prompt names for its No choice, never Enter and never a digit, and sends the agent one message saying
// which command was refused and why. A dialog it does not recognise is left for a person, with its first line on the card.
//
// BOUNDED AND NARROW. A run is declined at most MAX_SAFETY_DECLINES times; the next prompt is left for a person. A talk session is never declined: a person is at its terminal. The start dialogs
// are answered first, by `answerStartDialog`, and are never read as safety prompts. Only ticket runs are watched here (`watchRunning`); writer and publish runs are left as they are.

import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { declinedPrompt, toldDeclined } from "./queue/queue-declined.ts";
import { herdrRefusal } from "./pool-herdr.ts";
import { log, runMembers, updateEach } from "./pool-state.ts";
import { type PoolContext } from "./pool-context.ts";
import { type RunPlace } from "./pool-paths.ts";
import { declineMessage, type PanePrompt, readSafetyPrompt } from "./safety-prompt.ts";

/** The safety prompts the pool answers No to on one run. The next is left for a person, who sees its first line. */
export const MAX_SAFETY_DECLINES = 3;

/**
 * How long after a decline the agent is still told why, and an idle agent with no outcome is still not ended as `no-outcome`: herdr refuses a message while the agent reads
 * `blocked`, and the agent is not blocked once it has taken the Esc, so a message that stays refused this long is not coming.
 */
export const TELL_WINDOW_MS = 5 * 60_000;

/** What the pane of the agent named `name` shows, or null when it cannot be read or shows no dialog. */
export function readPrompt(ctx: PoolContext, { name }: RunPlace): PanePrompt | null {
  const { herdr, settings } = ctx;
  try {
    return readSafetyPrompt(herdr(["--session", settings.herdrSession, "agent", "read", name, "--source", "visible"]));
  } catch {
    return null;
  }
}

/** A run is declined for while a person is not at its terminal and it has declines left. PURE. */
const mayDecline = (entry: Entry): boolean => entry.talk !== true && (entry.declined?.count ?? 0) < MAX_SAFETY_DECLINES;

/**
 * Answer a safety prompt No on this run's agent, and record it on every member of the run. True when it did, so the run is not waiting on a person. A prompt the pool does not
 * recognise, one past the bound, one on a talk session, and an Esc herdr refuses, are all left alone (false).
 */
export function declineSafetyPrompt(ctx: PoolContext, entry: Entry, place: RunPlace, prompt: PanePrompt): boolean {
  const { herdr, now, settings } = ctx;
  if (prompt.kind !== "safety" || !mayDecline(entry)) return false;
  try {
    herdr(["--session", settings.herdrSession, "agent", "send-keys", place.name, "esc"]);
  } catch (err) {
    log(`${entry.batch ?? entry.ticket.key}: its safety prompt on \`${prompt.command}\` could not be declined (${herdrRefusal(err)})`);
    return false;
  }
  const { command, warning } = prompt;
  updateEach(ctx, runMembers(ctx, entry), (queue, key) => declinedPrompt(queue, key, { command, warning }, now()));
  log(`${entry.batch ?? entry.ticket.key}: declined a Claude Code safety prompt on \`${command}\`${warning === "" ? "" : ` ("${warning}")`}`);
  tellDeclined(ctx, entry, place);
  return true;
}

/** Whether the agent of this run has a decline it was not yet told about, inside the window it is still told in. */
export const untoldDecline = (ctx: PoolContext, entry: Entry): boolean =>
  entry.declined !== undefined && !entry.declined.told && ctx.now() - entry.declined.at < TELL_WINDOW_MS;

/** Did herdr refuse because the agent still reads `blocked`? It says `agent_blocked`, on stdout or stderr. PURE. */
const refusedAsBlocked = (err: unknown): boolean => ["stdout", "stderr", "message"].some((field) => String((err as Record<string, unknown> | null)?.[field] ?? "").includes("agent_blocked"));

/**
 * Send the agent of a run its decline's message, once: which command was refused and why. A message herdr refuses leaves the decline untold, for the next pass that finds the
 * agent not blocked ({@link retellDeclined}). True when the message was sent.
 */
export function tellDeclined(ctx: PoolContext, entry: Entry, { name }: RunPlace): boolean {
  const { herdr, settings } = ctx;
  const current = ctx.store.get().entries.find((e) => e.ticket.key === entry.ticket.key) ?? entry;
  if (!untoldDecline(ctx, current) || current.declined === undefined) return false;
  try {
    herdr(["--session", settings.herdrSession, "agent", "prompt", name, declineMessage(current.declined)]);
  } catch (err) {
    if (!refusedAsBlocked(err)) log(`${entry.batch ?? entry.ticket.key}: its agent could not be told its safety prompt was declined (${herdrRefusal(err)})`);
    return false;
  }
  updateEach(ctx, runMembers(ctx, current), toldDeclined);
  return true;
}

/**
 * The pass that finds a run's agent not blocked sends the message an earlier pass could not (herdr refuses a message to a blocked agent). True when it sent it: the status read
 * before the message is not the agent's answer to it, so that pass ends nothing.
 */
export function retellDeclined(ctx: PoolContext, entry: Entry, place: RunPlace, seen: string): boolean {
  return seen !== "blocked" && tellDeclined(ctx, entry, place);
}
