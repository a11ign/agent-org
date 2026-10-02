// @ts-check
// ANSWERS (a11ign/a11ign#2908, decision 2(c)): A BUTTON PRESS OR A REPLY RESOLVES A REQUEST ON ITS OWN ROW. The function that writes a
// chairman-attributed row comment, so it is the one `isAccepted` (./inbound.mjs) exists for.
//
// WHAT ONE ANSWER WRITES, IN THIS ORDER, and the order is the design: (1) a row comment carrying the provenance line, (2) `needs:chairman`
// removed (taking the label off IS the act of answering), (3) `answer:ceo` set so `ceo` is woken with the answer as data. **The label
// steps are last so a failed comment leaves the row still asking**, never answered-and-silent.
//
// **THE LEDGER IS THE MEMORY, AS IN THE CORE AND THE INBOUND.** Each completed step is a ledger line (`direction: "answer"`), so:
//   * the same press twice writes once, and a button pressed after the row was answered gets "already answered", not a second comment;
//   * a failure BETWEEN steps is resumed by the next press, which does only the steps the ledger lacks. Without that, a failure after (2)
//     leaves a row with neither label, and the next press would see "label gone" and write nothing: answered, silent, and nobody woken.
// The lines carry NO `key` field, so the fold in ledger.mjs (which skips lines without a string `key`) never mistakes one for a
// notification, and no text of the chairman's: ids, a step, the option id.
//
// **WHICH ROW: THE LEDGER, NEVER THE MESSAGE.** The bot message the press sits under (or the reply points at) is looked up among the
// ledger's SENT lines, and only a `request:` key is an answerable thing. A chat message cannot name a row of its own choosing, and a
// button's data is only an option id, checked against the options the row's brief offers NOW.
//
// **A PRESS ANSWERS THE MESSAGE IT SITS UNDER.** If a row is re-asked, a press on the OLD message is "already answered" (its steps are
// done), not an answer to the new ask. A reply to the CLEARED or a reminder message of a request that is asking again does answer the
// new ask: those messages name the row, and the row is what is asking.
//
// WHAT THIS DOES NOT DO: send anything. It returns what the caller (the listener) must send, as `inbound.handle` does, and it is handed
// a GitHub writer rather than reaching for `gh`. THE REPLY TARGET IS NOT IN THE BRANDED VALUE: `inbound.mjs` does not carry
// `reply_to_message`, so the caller passes `replyToMessageId` from the raw update. That is the one unbranded input, and it can only
// choose WHICH ledger-known request the chairman's verified text lands on, never widen what a verified answer may do.
//
// **THE CHAIRMAN'S TEXT IS QUOTED, NEVER PASTED.** Row comments are read by line-anchored parsers (`Not-before:`, `Acceptance:`) and by a
// regex for the `chairman-options` HTML comment, so a reply is written as a blockquote with its HTML comment markers escaped.

import { isAccepted } from "./inbound.mjs";
import { describeError, STATUS } from "./ledger.mjs";
import { latestBrief, NEEDS_CHAIRMAN, parseChairmanOptions, parseRequestKey } from "./sources/requests.mjs";

export const ANSWER_LABEL = "answer:ceo";
/** The three writes, in the order they are made. Pinned by the test: the label steps are last. */
export const STEPS = Object.freeze(["comment", "remove-label", "set-answer"]);

const BUTTON_PREFIX = "ans:";
const ANSWER_DIRECTION = "answer";
const PROVENANCE = "Chairman answered via Telegram, verified id";

/**
 * What a request message's button carries as `callback_data`. Only the option id: the row comes from the ledger, so the 64 bytes
 * Telegram allows are never the limit.
 *
 * @param {string} optionId @returns {string}
 */
export function buttonData(optionId) {
  return `${BUTTON_PREFIX}${optionId}`;
}

/** @param {unknown} data @returns {string | null} the option id, or null for data that is not one of ours */
function optionIdFrom(data) {
  return typeof data === "string" && data.startsWith(BUTTON_PREFIX) ? data.slice(BUTTON_PREFIX.length) : null;
}

/** @param {string} text @returns {string} the text as a blockquote that no parser reads as a line of its own or as an HTML comment */
function quoted(text) {
  const inert = text.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
  return inert.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

/**
 * The comment body. The first line is the provenance line the design specifies; a reply's text follows it quoted.
 *
 * @param {{ref: string, at: string, option: {id: string, label: string} | null, text: string | null}} parts @returns {string}
 */
export function answerComment({ ref, at, option, text }) {
  const head = `${PROVENANCE}, message ${ref}, ${at}:`;
  return option ? `${head} ${option.id} (${option.label})` : `${head} reply\n\n${quoted(text ?? "")}`;
}

/**
 * @typedef {{repo: string, number: number}} RowRef
 * @typedef {{
 *   readRow: (row: RowRef) => Promise<{state: string, labels: string[], comments: {body: string, createdAt: string, authorAssociation?: string}[]}>,
 *   comment: (row: RowRef, body: string) => Promise<void>,
 *   removeLabel: (row: RowRef, label: string) => Promise<void>,
 *   addLabel: (row: RowRef, label: string) => Promise<void>,
 * }} GithubWriter  what answers need of GitHub. `readRow` is read fresh for every answer (never remembered); `removeLabel` must resolve
 *   when the label is already absent, because a resumed answer may repeat it.
 *
 * @typedef {{action: "not-an-answer"}
 *   | {action: "reply", reason: string, request: string | null, text: string, chatId: number, callbackQueryId: string | null}} Answered
 */

/** @param {Record<string, any>[]} lines @param {string} ref @returns {string | null} the request key of the SENT message `ref`, if it is one */
function requestOf(lines, ref) {
  const sent = lines.find((line) => line.direction !== "in" && line.direction !== ANSWER_DIRECTION && line.status === STATUS.sent
    && line.providerMessageId === ref && typeof line.key === "string" && parseRequestKey(line.key) !== null);
  return sent ? sent.key : null;
}

/** @param {Record<string, any>[]} lines @param {string} request @param {string} ref @returns {{done: Set<string>, option: string | null}} */
function progressOn(lines, request, ref) {
  const mine = lines.filter((line) => line.direction === ANSWER_DIRECTION && line.request === request && line.messageRef === ref && STEPS.includes(line.step));
  return { done: new Set(mine.map((line) => line.step)), option: mine.find((line) => line.step === STEPS[0])?.option ?? null };
}

/**
 * @param {{ledger: {append: (entry: Record<string, unknown>) => Record<string, any>, read: () => Record<string, any>[]},
 *          github: GithubWriter, chairman: {userId: number, chatId: number}, now: () => number}} options
 */
export function createAnswers({ ledger, github, chairman, now }) {
  // Refuses ids that are not integers now, rather than at the first answer: `isAccepted` throws for them.
  isAccepted(null, chairman);

  /** @param {Readonly<Record<string, any>>} accepted @param {string} reason @param {string | null} request @param {string} text @returns {Answered} */
  function reply(accepted, reason, request, text) {
    return { action: "reply", reason, request, text, chatId: accepted.chatId, callbackQueryId: accepted.kind === "button" ? accepted.callbackQueryId : null };
  }

  /** @param {{request: string, ref: string, step: string, via: string, option: string | null}} fields */
  function stepLine({ request, ref, step, via, option }) {
    ledger.append({ direction: ANSWER_DIRECTION, request, messageRef: ref, step, via, option });
  }

  /** The row as it is NOW: the answer to "what is asking" is read, never remembered. @param {string} name @param {{state: string, labels: string[]}} read */
  function stateText(name, read) {
    const labels = read.labels.length === 0 ? "no labels" : read.labels.join(", ");
    return `${name} is not asking you anything now (${read.state.toLowerCase()}; ${labels}). Nothing was written.`;
  }

  /**
   * Does the steps `done` lacks, each recorded the moment it succeeds. A GitHub failure is recorded and returned, never thrown: the update
   * is already in the ledger (at-most-once), so the chairman is told and the next press resumes from the last recorded step.
   *
   * @param {{row: RowRef, request: string, ref: string, done: Set<string>, option: {id: string, label: string} | null, text: string | null}} job
   * @returns {Promise<string | null>} the step that failed, or null
   */
  async function carryOut({ row, request, ref, done, option, text }) {
    const via = option ? "button" : "reply";
    const writes = {
      comment: () => github.comment(row, answerComment({ ref, at: new Date(now()).toISOString(), option, text })),
      "remove-label": () => github.removeLabel(row, NEEDS_CHAIRMAN),
      "set-answer": () => github.addLabel(row, ANSWER_LABEL),
    };
    for (const step of STEPS.filter((candidate) => !done.has(candidate))) {
      try {
        await writes[/** @type {keyof typeof writes} */ (step)]();
      } catch (error) {
        ledger.append({ direction: ANSWER_DIRECTION, request, messageRef: ref, step: "failed", failedStep: step, via, error: describeError(error) });
        return step;
      }
      stepLine({ request, ref, step, via, option: option?.id ?? null });
    }
    return null;
  }

  /** @param {Readonly<Record<string, any>>} accepted @param {string | null} replyToMessageId @returns {Promise<Answered>} */
  async function resolve(accepted, replyToMessageId) {
    const isButton = accepted.kind === "button";
    const ref = isButton ? (accepted.messageId === null ? null : String(accepted.messageId)) : replyToMessageId;
    const lines = ledger.read();
    const request = ref === null ? null : requestOf(lines, ref);
    // A reply to something that is not a request is conversation (row 10); a button under something that is not one is the chairman's to be told.
    if (request === null || ref === null) {
      return isButton ? reply(accepted, "unknown-message", null, "That message is not a request I can resolve. Nothing was written.") : { action: "not-an-answer" };
    }
    const progress = progressOn(lines, request, ref);
    const parsed = /** @type {RowRef} */ (parseRequestKey(request));
    const name = `${parsed.repo}#${parsed.number}`;
    if (progress.done.size === STEPS.length) {
      return reply(accepted, "already-answered", request, `${name} was already answered${progress.option ? ` (${progress.option})` : ""}. Nothing was written.`);
    }
    const current = await github.readRow(parsed);
    // A started answer is finished whether or not the label is still there: the label is what its second step removed.
    const started = progress.done.size > 0;
    if (!started && !current.labels.includes(NEEDS_CHAIRMAN)) return reply(accepted, "no-longer-asking", request, stateText(name, current));
    const option = started ? recordedOption(progress) : isButton ? offeredOption(current.comments, accepted.data) : null;
    if (!started && isButton && option === null) return reply(accepted, "option-not-offered", request, `${name} does not offer that option any more. Nothing was written.`);
    const failed = await carryOut({ row: parsed, request, ref, done: progress.done, option, text: isButton ? null : accepted.text });
    return failed === null
      ? reply(accepted, "answered", request, `Recorded on ${name}: ceo has it.`)
      : reply(accepted, "write-failed", request, `Could not finish writing to ${name} (at ${failed}). Do it again to retry; nothing is written twice.`);
  }

  let queue = Promise.resolve();
  return {
    /**
     * @param {unknown} accepted  what `createInbound(...).handle` minted for THIS chairman; anything else is refused
     * @param {{replyToMessageId?: number | null}} [source]  for a message: the id of the message it replies to, from the raw update
     * @returns {Promise<Answered>}
     * @throws {TypeError} for a value `inbound.mjs` did not mint for this chairman
     */
    answer(accepted, { replyToMessageId = null } = {}) {
      if (!isAccepted(accepted, chairman)) throw new TypeError("answer: only a value minted by createInbound for this chairman may write to a row");
      const value = /** @type {Readonly<Record<string, any>>} */ (accepted);
      // One at a time: two presses of one button must not both read "nothing done yet".
      const run = queue.then(() => resolve(value, Number.isSafeInteger(replyToMessageId) ? String(replyToMessageId) : null));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

/** @param {{body: string, createdAt: string, authorAssociation?: string}[]} comments @param {unknown} data @returns {{id: string, label: string} | null} */
function offeredOption(comments, data) {
  const id = optionIdFrom(data);
  const brief = latestBrief(comments);
  return id === null || brief === null ? null : parseChairmanOptions(brief.body).options.find((option) => option.id === id) ?? null;
}

/** @param {{option: string | null}} progress @returns {{id: string, label: string} | null} the option the started answer was made with; its comment is already written, so the label is not needed */
function recordedOption({ option }) {
  return option === null ? null : { id: option, label: "" };
}
