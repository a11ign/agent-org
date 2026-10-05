// @ts-check
// THE WALK-THROUGH (a11ign/a11ign#3425, chairman point 3): A PHYSICAL OR ACCOUNT ASK IS WALKED, ONE STEP AT A TIME. A brief with a `Steps:` list (`sources/requests.mjs` reads it) is sent as the first step with
// Done / Stuck / Explain more under it; on Done the step's `Verify:` is READ through the checked-facts vocabulary, and only a read that shows it moves the walk on. After the last verified step the
// request is answered on its row, through the answers path, and the closing message says what it unblocked. This module is the walk's rules and its memory; `answers.mjs` routes the presses to it.
//
// **VERIFICATION IS A READ AND NEVER AN ECHO OF DONE.** `judge` re-reads the step's placeholder at the moment of the press (`prepareReply`, so the words carry the `as of` stamp the replies carry) and
// compares what it says with what the brief said it should. A read that fails, or that says something else, does NOT advance the walk: the chairman is told plainly that it is not seen, with Done
// again, Stuck and Later under it. A step with no `Verify:` is confirmed on Done alone, and the message says "I can't check that one from here": the chairman is never told a thing was checked that was not.
//
// **STATE IS THE LEDGER.** One line per step transition, `direction: "walk"`, carrying `walk: "walk:<request key>"` and NO `key` (the fold in ledger.mjs would take a line with one for a notification):
//   * `confirmed` (step n): Done was pressed and the step was shown to be so (or cannot be checked). The walk's position is the highest confirmed step plus one.
//   * `unseen` (step n): Done was pressed and the read did not show it. The walk stays where it is.
//   * `shown` (step n, message ref, the step's text): a step message that was sent, so a press under it is known to be about that step, and a restart finds the walk where it was.
// A repeated Done on a confirmed step writes nothing, a restart reads the same lines, and a send that failed leaves the walk on the step it was: the next Done on the old message re-sends the new one.
// **THE LAST STEP'S `confirmed` LINE IS WRITTEN AFTER THE ROW IS ANSWERED**, so a failed label write leaves the walk on its last step and the next Done finishes it (the answers path's own resume).
//
// WHAT THIS DOES NOT DO: send anything or touch the row. It returns what the listener must send (`text`, `buttons`, and `recordSent`, which writes the `shown` line once the message has a ref), and
// it is handed the row-answering step (`finish`) as a function. Stuck, Explain more and Later are not here: they are the liaison orders and the snooze `answers.mjs` already has.

import { prepareReply } from "./reply.mjs";
import { stepLine } from "./sources/requests.mjs";

export const WALK_DIRECTION = "walk";
const CANNOT_CHECK = "Thanks. I can't check that one from here, so I'm taking your word for it.";
const SEEN = "That shows, thanks.";
const NOT_SEEN = "I can't see it yet.";
const NOT_READ = "I can't see it: I couldn't read it just now.";

/** The buttons a step message carries, by word (`answers.mjs` draws them): the first time, and after a read that did not show it. */
export const STEP_BUTTONS = Object.freeze(["done", "stuck", "explain"]);
export const RETRY_BUTTONS = Object.freeze(["done", "stuck", "later"]);

/** @param {string} request `request:<repo>#<n>` @returns {string} the key every line of one request's walk carries */
export function walkKey(request) {
  return `walk:${request}`;
}

/**
 * @typedef {{ position: number, shown: Map<string, {step: number, text: string, request: string}>, shownSteps: Set<number> }} Progress
 *   `position` is the step awaiting Done (1-based; one past the last once every step is confirmed). `shown` is by message ref.
 */

/** @param {Record<string, any>[]} lines @param {string} request @returns {Progress} where one request's walk is, read from the ledger and nowhere else */
export function walkProgress(lines, request) {
  const mine = lines.filter((line) => line.direction === WALK_DIRECTION && line.walk === walkKey(request));
  const confirmed = mine.filter((line) => line.event === "confirmed").map((line) => Number(line.step));
  const shownLines = mine.filter((line) => line.event === "shown");
  return {
    position: Math.max(0, ...confirmed) + 1,
    shown: new Map(shownLines.map((line) => [String(line.messageRef), { step: Number(line.step), text: String(line.text ?? ""), request }])),
    shownSteps: new Set(shownLines.map((line) => Number(line.step))),
  };
}

/**
 * The step a message shows. A step message the listener sent says so itself (`shown`); a message the CORE sent (the ask, an update, a reminder) showed the step the walk was on WHEN IT WENT, which the
 * ledger's order answers: one past the highest step confirmed before its line. Null for a message that is neither, which the caller takes to be the step the walk is on now.
 *
 * @param {Record<string, any>[]} lines @param {string} request @param {string} ref @returns {number | null}
 */
export function stepOf(lines, request, ref) {
  const shown = lines.find((line) => line.direction === WALK_DIRECTION && line.event === "shown" && String(line.messageRef) === ref);
  if (shown !== undefined) return Number(shown.step);
  const at = lines.findIndex((line) => line.key === request && line.status === "sent" && String(line.providerMessageId) === ref);
  return at === -1 ? null : walkProgress(lines.slice(0, at), request).position;
}

/** @param {Record<string, any>[]} lines @param {string} request @returns {number} the step the walk is on, for the watcher's first message and its reminders */
export function walkPosition(lines, request) {
  return walkProgress(lines, request).position;
}

/**
 * The request a step message belongs to, for a message the core did not send: the walk's later steps are sent by the listener, so `answers.mjs` finds them here.
 * @param {Record<string, any>[]} lines @param {string} ref @returns {{ key: string, text: string } | null} shaped like the core's sent line, as far as a press needs it
 */
export function stepMessageOf(lines, ref) {
  const shown = lines.find((line) => line.direction === WALK_DIRECTION && line.event === "shown" && String(line.messageRef) === ref);
  return shown === undefined ? null : { key: String(shown.request), text: String(shown.text ?? "") };
}

/** @param {import("./sources/requests.mjs").Verify} verify @param {string} value @returns {boolean} whether what was read is what the brief said it should be (case is not a difference) */
function matches({ compare, expected }, value) {
  const [read, wanted] = [value.trim().toLowerCase(), expected.toLowerCase()];
  return compare === "is" ? read === wanted : read.includes(wanted);
}

/**
 * @param {import("./reply.mjs").Prepared} prepared @param {{ readers: import("./placeholders.mjs").Readers, now: () => number }} deps
 * @returns {Promise<string>} why a read could not be made, as the chairman may be told it: the "could not check" form is passed through the checker that refused, as it was written to be, and states nothing
 */
async function unreadable(prepared, deps) {
  if (prepared.outcome === "checked") return "";
  if (prepared.sendable === undefined) return prepared.problems.map((problem) => problem.reason).join("; ");
  const told = await prepareReply(prepared.sendable, deps);
  return told.outcome === "checked" ? told.text : prepared.sendable;
}

/**
 * @typedef {{ advance: boolean, words: string, checked: string | null, verified: boolean }} Verdict
 *   `verified` is whether a read decided it (false for a step with no `Verify:`); `checked` is what the read said.
 */

/**
 * @param {import("./sources/requests.mjs").Step} step
 * @param {{ readers: import("./placeholders.mjs").Readers, now: () => number }} deps
 * @returns {Promise<Verdict>}
 */
async function judge({ verify }, { readers, now }) {
  if (verify === null) return { advance: true, words: CANNOT_CHECK, checked: null, verified: false };
  // ONE read, and the words are built from it: the value that was compared is the value that is shown. The text around the placeholder holds no claim for the checker to refuse.
  const prepared = await prepareReply(`I read: ${verify.read}`, { readers, now });
  if (prepared.outcome !== "checked") return { advance: false, words: `${NOT_READ}\n${await unreadable(prepared, { readers, now })}`, checked: null, verified: true };
  const value = prepared.values[verify.read];
  const shows = matches(verify, value);
  return { advance: shows, words: `${shows ? SEEN : NOT_SEEN}\n${prepared.text}`, checked: value, verified: true };
}

/**
 * @typedef {{ reason: string, text: string, buttons?: readonly string[], recordSent?: (messageRef: string) => void, clearKeyboard?: string | null }} WalkReply
 *   what the listener sends. `recordSent` is called with the sent message's ref, and writes the `shown` line that makes a press under it known.
 */

/**
 * @param {{ ledger: { append: (entry: Record<string, unknown>) => Record<string, any>, read: () => Record<string, any>[] },
 *          readers: import("./placeholders.mjs").Readers, now: () => number }} deps
 */
export function createWalk({ ledger, readers, now }) {
  /** @param {string} request @param {string} event @param {Record<string, unknown>} fields */
  function record(request, event, fields) {
    ledger.append({ direction: WALK_DIRECTION, walk: walkKey(request), request, event, ...fields });
  }

  /** @param {{ request: string, step: number, text: string }} shown @returns {(messageRef: string) => void} */
  function shownWhenSent({ request, step, text }) {
    return (messageRef) => record(request, "shown", { step, messageRef, text });
  }

  /** @param {{ request: string, total: number, step: number, text: string, words: string }} next @returns {WalkReply} the next step, with what was just confirmed above it */
  function advanced({ request, total, step, text, words }) {
    return {
      reason: "advanced", text: `${words}\n\n${stepLine({ position: step, total, text })}`, buttons: STEP_BUTTONS, recordSent: shownWhenSent({ request, step, text }),
    };
  }

  return {
    /**
     * A Done press on the message `ref`, which shows a step of `walk`. `finish` answers the request on its row and resolves to the step that failed, or null.
     *
     * @param {{ request: string, ref: string, walk: import("./sources/requests.mjs").Walk, finish: () => Promise<string | null> }} press
     * @returns {Promise<WalkReply>}
     */
    async done({ request, ref, walk, finish }) {
      const progress = walkProgress(ledger.read(), request);
      const step = stepOf(ledger.read(), request, ref) ?? progress.position;
      const total = walk.steps.length;
      if (step < progress.position) return staleStep({ request, ref, walk, progress, total, shownWhenSent });
      const verdict = await judge(walk.steps[step - 1], { readers, now });
      const fields = { step, messageRef: ref, checked: verdict.checked, verified: verdict.verified };
      if (!verdict.advance) {
        record(request, "unseen", fields);
        return { reason: "not-seen", text: verdict.words, buttons: RETRY_BUTTONS, recordSent: shownWhenSent({ request, step, text: walk.steps[step - 1].text }), clearKeyboard: ref };
      }
      if (step === total) return finishWalk({ request, ref, walk, verdict, finish, confirm: () => record(request, "confirmed", fields) });
      record(request, "confirmed", fields);
      return { ...advanced({ request, total, step: step + 1, text: walk.steps[step].text, words: verdict.words }), clearKeyboard: ref };
    },
  };
}

/**
 * A Done on a message whose step is already confirmed: nothing is written, and the chairman is told where the walk is. When the step the walk is on never reached him (its send failed, or the
 * process stopped between the line and the message), it is sent again, which is how a walk resumes from the ledger without a second Done.
 *
 * @param {{ request: string, ref: string, walk: import("./sources/requests.mjs").Walk, progress: Progress, total: number,
 *          shownWhenSent: (shown: { request: string, step: number, text: string }) => (messageRef: string) => void }} job
 * @returns {WalkReply}
 */
function staleStep({ request, ref, walk, progress, total, shownWhenSent }) {
  const { position } = progress;
  const told = "That step was already confirmed. Nothing was written again.";
  // Step 1 is the request's own message (the core sent it), and a position past the last has no step left to send.
  if (position > total || position === 1 || progress.shownSteps.has(position)) return { reason: "already-confirmed", text: told, clearKeyboard: ref };
  const text = walk.steps[position - 1].text;
  return {
    reason: "resent", text: `${told}\n\n${stepLine({ position, total, text })}`, buttons: STEP_BUTTONS, recordSent: shownWhenSent({ request, step: position, text }), clearKeyboard: ref,
  };
}

/**
 * @param {{ request: string, ref: string, walk: import("./sources/requests.mjs").Walk, verdict: Verdict, finish: () => Promise<string | null>, confirm: () => void }} job
 * @returns {Promise<WalkReply>}
 */
async function finishWalk({ request, ref, walk, verdict, finish, confirm }) {
  const failed = await finish();
  if (failed !== null) return { reason: "write-failed", text: `${verdict.words}\n\nCould not finish writing to ${request.slice("request:".length)} (at ${failed}). Press Done again to retry; nothing is written twice.` };
  confirm();
  const unblocks = walk.unblocks === "" ? "" : ` This unblocks: ${walk.unblocks}`;
  return { reason: "answered", text: `${verdict.words}\n\nThat was the last step.${unblocks}\nRecorded on the row: ceo has it.`, clearKeyboard: ref };
}
