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
// **THE BUTTONS, AND WHAT EACH ONE MEANS (a11ign/a11ign#3423).** The vocabulary is closed and `inbound.mjs`'s (an unknown `callback_data` never reaches
// here); the meaning is this module's, and it is routed by the ledger-known message the press sits under, never by the data:
//   * an option id, `approve` or `done` RESOLVES the request: the three writes above, unchanged. (`done` outside a walk-through is the answers path;
//     the walk-through's step advance is C2's and is not here.)
//   * `later` SNOOZES the request's reminders for 24 hours: one ledger line, the label stays, so it is NOT an answer (`snoozedUntil` is what the watcher reads).
//   * `explain` and `stuck` each send the LIAISON one order, through a port (`orders`): this module queues nothing itself, and the one file that may queue is `converse.mjs`.
//     When the liaison's queue refuses, `converse.mjs` queues it for `ceo` (the chairman's order, a11ign/a11ign#3538) and the press is told so in plain words (`told`); when neither
//     takes it the press is told nothing was sent. **The chairman never reads a queue's refusal or an error's text here:** they go to the ledger (`error`), which is where they are kept.
//   * `forme` is D1's request and is not wired: the chairman is told so, and nothing is written.
// A press on a message whose request is answered (or no longer asking) is told so, and its keyboard is taken off (`clearKeyboard`): a second press cannot happen.
//
// WHAT THIS DOES NOT DO: send anything. It returns what the caller (the listener) must send, as `inbound.handle` does, and it is handed
// a GitHub writer rather than reaching for `gh`. THE REPLY TARGET IS IN THE BRANDED VALUE (`replyToMessageId`, minted by `inbound.mjs`), so
// there is no unbranded input: it can only choose WHICH ledger-known request the chairman's verified text lands on, never widen what a
// verified answer may do.
//
// **THE CHAIRMAN'S TEXT IS QUOTED, NEVER PASTED.** Row comments are read by line-anchored parsers (`Not-before:`, `Acceptance:`) and by a
// regex for the `chairman-options` HTML comment, so a reply is written as a blockquote with its HTML comment markers escaped.

import { FALLBACK_RECIPIENT, RECIPIENT } from "./converse.mjs";
import { actionData, isAccepted, optionData, parseButtonData } from "./inbound.mjs";
import { describeError, STATUS } from "./ledger.mjs";
import { latestBrief, NEEDS_CHAIRMAN, parseChairmanOptions, parseRequestKey } from "./sources/requests.mjs";

/** The three writes, in the order they are made. Pinned by the test: the label steps are last. */
export const STEPS = Object.freeze(["comment", "remove-label", "set-answer"]);

const ANSWER_DIRECTION = "answer";
/** What a press is told when neither the liaison nor the fallback took its order: plain words, nothing of the queue's refusal in them. */
const ORDER_LOST = `I couldn't pass that to the ${RECIPIENT} or to ${FALLBACK_RECIPIENT}, so nothing was sent. Press again to retry.`;
/** How long `later` holds a request's reminders back. */
export const SNOOZE_MS = 24 * 60 * 60 * 1000;
const MAX_ASK_QUOTED = 500;
export const PROVENANCE = "Chairman answered via Telegram, verified id";

/**
 * What a request message's button carries as `callback_data`. Only the option id: the row comes from the ledger, so the 64 bytes
 * Telegram allows are never the limit.
 *
 * @param {string} optionId @returns {string}
 */
export function buttonData(optionId) {
  return optionData(optionId);
}

/** The words a button may say, by the action it carries: the closed set of chairman point 5. */
export const ACTION_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  approve: "Approve", done: "Done", stuck: "Stuck", later: "Later", explain: "Explain more", forme: "Do it for me",
}));
/** Presses that resolve the request, as an option does, and so carry an option of their own. */
const RESOLVING = new Set(["approve", "done"]);
/** Presses that leave the request asking. */
const SIDE_ACTIONS = new Set(["later", "explain", "stuck", "forme"]);
/** The most buttons one message carries (Telegram's own limit is far higher; a phone's screen is the limit): the two fixed buttons leave this many for options. */
const MAX_BUTTONS = 8;
const FIXED_BUTTONS = 2;
const MAX_BUTTON_LABEL = 64;

/**
 * The keyboard a request message carries: its options, or Approve when it offers none, then Explain more and Later. A request with more options than
 * the keyboard has room for carries NO keyboard (all or nothing, as `parseChairmanOptions` is): typing an answer still works, and a row of buttons
 * missing the option the chairman meant is a quieter wrong than none.
 *
 * @param {{id: string, label: string}[]} options @returns {{label: string, data: string}[]}
 */
export function requestActions(options) {
  if (options.length > MAX_BUTTONS - FIXED_BUTTONS) return [];
  const answers = options.length > 0
    ? options.map(({ id, label }) => ({ label: `${id}: ${label}`.slice(0, MAX_BUTTON_LABEL), data: optionData(id) }))
    : [{ label: ACTION_LABELS.approve, data: actionData("approve") }];
  return [...answers, ...["explain", "later"].map((name) => ({ label: ACTION_LABELS[name], data: actionData(name) }))];
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
 * @typedef {{
 *   liaison: (order: {text: string, messageRef: string}) => Promise<{queued: boolean, say: string, handoff: string | null, taker?: string | null, told?: string | null}>,
 * }} Orders  the one thing a press may ask the organisation for: an order to the liaison. `converse.mjs` is the only module that queues, so it builds this.
 *   `say` is the queue's own words, for the LEDGER only; `taker` is who holds the order (the fallback when the liaison's queue refused) and `told` is what the chairman is told when it
 *   went to the fallback.
 *
 * @typedef {{action: "not-an-answer"}
 *   | {action: "reply", reason: string, request: string | null, text: string, chatId: number, callbackQueryId: string | null, clearKeyboard: string | null}} Answered
 *   `clearKeyboard` is the bot message whose keyboard the caller takes off, or null: set when the message can no longer be answered, so a second press cannot happen.
 */

/** @param {Record<string, any>[]} lines @param {string} ref @returns {Record<string, any> | null} the SENT line of message `ref`, when it is a request's */
function sentRequest(lines, ref) {
  return lines.find((line) => line.direction !== "in" && line.direction !== ANSWER_DIRECTION && line.status === STATUS.sent
    && line.providerMessageId === ref && typeof line.key === "string" && parseRequestKey(line.key) !== null) ?? null;
}

/**
 * When `request`'s reminders are held back until, or null when they are not. A snooze ends when the request is ANSWERED or CLEARED after it: that
 * request is then a new ask, and 24 hours of silence earned by the old one must not swallow it.
 *
 * @param {Record<string, any>[]} lines @param {string} request @param {number} nowMs @returns {number | null} epoch milliseconds
 */
export function snoozedUntil(lines, request, nowMs) {
  /** @type {number | null} */
  let until = null;
  for (const line of lines) {
    if (line.direction === ANSWER_DIRECTION && line.request === request) {
      if (line.step === "snooze") until = Date.parse(line.until);
      else if (line.step === STEPS[STEPS.length - 1]) until = null;
    } else if (line.key === request && line.kind === "cleared" && line.status === STATUS.sent) {
      until = null;
    }
  }
  return until !== null && until > nowMs ? until : null;
}

/** @param {Record<string, any>[]} lines @param {string} request @param {string} ref @returns {{done: Set<string>, option: string | null}} */
function progressOn(lines, request, ref) {
  const mine = lines.filter((line) => line.direction === ANSWER_DIRECTION && line.request === request && line.messageRef === ref && STEPS.includes(line.step));
  return { done: new Set(mine.map((line) => line.step)), option: mine.find((line) => line.step === STEPS[0])?.option ?? null };
}

/**
 * @param {{ledger: {append: (entry: Record<string, unknown>) => Record<string, any>, read: () => Record<string, any>[]},
 *          github: GithubWriter, chairman: {userId: number, chatId: number}, answerLabel: string, now: () => number, orders?: Orders}} options
 *   `orders` is what `explain` and `stuck` ask the liaison through; without it those presses are told there is nobody to ask, and nothing is queued.
 *   `answerLabel` is the label that wakes `ceo` with the answer (the vocabulary's answer prefix + `ceo`). It is an INPUT, not a literal here,
 *   because the messaging modules are leaves that do not read the tool's vocabulary and `project-vocabulary.test.ts` refuses a copy in code.
 */
export function createAnswers({ ledger, github, chairman, answerLabel, now, orders }) {
  // Refuses ids that are not integers now, rather than at the first answer: `isAccepted` throws for them.
  isAccepted(null, chairman);
  if (typeof answerLabel !== "string" || answerLabel === "") throw new TypeError("createAnswers needs the answerLabel to set (a non-empty string)");

  /**
   * @param {Readonly<Record<string, any>>} accepted @param {string} reason @param {string | null} request @param {string} text
   * @param {string | null} [clearKeyboard] the message to take the keyboard off
   * @returns {Answered}
   */
  function reply(accepted, reason, request, text, clearKeyboard = null) {
    return { action: "reply", reason, request, text, chatId: accepted.chatId, callbackQueryId: accepted.kind === "button" ? accepted.callbackQueryId : null, clearKeyboard };
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
      "set-answer": () => github.addLabel(row, answerLabel),
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

  /** @param {number | null} id @returns {string | null} */
  const refOf = (id) => (Number.isSafeInteger(id) ? String(id) : null);

  /** @typedef {{accepted: Readonly<Record<string, any>>, request: string, ref: string, name: string, lines: Record<string, any>[], sent: Record<string, any>}} Press */

  /** `later`: one ledger line, and the row is untouched. @param {Press} press @returns {Answered} */
  function snooze({ accepted, request, ref, name, lines }) {
    const held = snoozedUntil(lines, request, now());
    if (held !== null) return reply(accepted, "already-snoozed", request, `Already snoozed until ${new Date(held).toISOString()}. ${name} still needs you.`);
    const until = new Date(now() + SNOOZE_MS).toISOString();
    ledger.append({ direction: ANSWER_DIRECTION, request, messageRef: ref, step: "snooze", via: "button", until });
    return reply(accepted, "snoozed", request, `Snoozed: no reminders about ${name} until ${until}. It still needs you.`);
  }

  /**
   * The order to the liaison, recorded when it is queued and a failure recorded as one: a press that failed is retried by the next, and one that
   * succeeded is not repeated. @param {Press & {step: "explain" | "stuck"}} press @returns {Promise<Answered>}
   */
  async function orderLiaison({ accepted, request, ref, name, lines, sent, step }) {
    const again = lines.some((line) => line.direction === ANSWER_DIRECTION && line.request === request && line.messageRef === ref && line.step === step);
    if (again) return reply(accepted, "already-asked", request, `The liaison already has that for ${name}. Nothing was sent again.`);
    if (orders === undefined) return reply(accepted, "no-liaison", request, "I cannot reach the liaison from here. Nothing was sent.");
    const lead = step === "explain" ? `the chairman asked for more on ${name}` : `the chairman is stuck at ${name}`;
    /** @type {{queued: boolean, say: string, handoff: string | null, taker?: string | null, told?: string | null}} */
    let result;
    try {
      result = await orders.liaison({ text: `${lead}:\n\n${quoted(askOf(sent))}`, messageRef: ref });
    } catch (error) {
      result = { queued: false, say: describeError(error), handoff: null };
    }
    if (!result.queued) {
      ledger.append({ direction: ANSWER_DIRECTION, request, messageRef: ref, step: "failed", failedStep: step, via: "button", error: result.say });
      return reply(accepted, "order-refused", request, ORDER_LOST);
    }
    ledger.append({ direction: ANSWER_DIRECTION, request, messageRef: ref, step, via: "button", handoff: result.handoff, taker: result.taker ?? RECIPIENT });
    if (result.told) return reply(accepted, "asked-fallback", request, result.told);
    return reply(accepted, "asked", request, step === "explain" ? `Asked the liaison for more on ${name}.` : `Told the liaison you are stuck at ${name}.`);
  }

  /** A press that leaves the request asking. @param {Press} press @param {string} action one of SIDE_ACTIONS @returns {Promise<Answered>} */
  async function sideAction(press, action) {
    if (action === "later") return snooze(press);
    if (action === "forme") return reply(press.accepted, "not-available", press.request, "Do it for me is not available yet. Nothing was done.");
    return orderLiaison({ ...press, step: /** @type {"explain" | "stuck"} */ (action) });
  }

  /** @param {Readonly<Record<string, any>>} accepted @returns {Promise<Answered>} */
  async function resolve(accepted) {
    const isButton = accepted.kind === "button";
    const ref = refOf(isButton ? accepted.messageId : accepted.replyToMessageId);
    const lines = ledger.read();
    const sent = ref === null ? null : sentRequest(lines, ref);
    // A reply to something that is not a request is conversation (row 10); a button under something that is not one is the chairman's to be told.
    if (sent === null || ref === null) {
      return isButton ? reply(accepted, "unknown-message", null, "That message is not a request I can resolve. Nothing was written.") : { action: "not-an-answer" };
    }
    const request = sent.key;
    const progress = progressOn(lines, request, ref);
    const parsed = /** @type {RowRef} */ (parseRequestKey(request));
    const name = `${parsed.repo}#${parsed.number}`;
    if (progress.done.size === STEPS.length) {
      return reply(accepted, "already-answered", request, `${name} was already answered${progress.option ? ` (${progress.option})` : ""}. Nothing was written.`, ref);
    }
    const current = await github.readRow(parsed);
    // A started answer is finished whether or not the label is still there: the label is what its second step removed.
    const started = progress.done.size > 0;
    if (!started && !current.labels.includes(NEEDS_CHAIRMAN)) return reply(accepted, "no-longer-asking", request, stateText(name, current), ref);
    const press = isButton ? parseButtonData(accepted.data) : null;
    if (!started && press?.kind === "action" && SIDE_ACTIONS.has(press.name)) return sideAction({ accepted, request, ref, name, lines, sent }, press.name);
    const option = started ? recordedOption(progress) : isButton ? optionFor(press, current.comments) : null;
    if (!started && isButton && option === null) return reply(accepted, "option-not-offered", request, `${name} does not offer that option any more. Nothing was written.`);
    const failed = await carryOut({ row: parsed, request, ref, done: progress.done, option, text: isButton ? null : accepted.text });
    return failed === null
      ? reply(accepted, "answered", request, `Recorded on ${name}: ceo has it.`, ref)
      : reply(accepted, "write-failed", request, `Could not finish writing to ${name} (at ${failed}). Do it again to retry; nothing is written twice.`);
  }

  let queue = Promise.resolve();
  return {
    /**
     * @param {unknown} accepted  what `createInbound(...).handle` minted for THIS chairman; anything else is refused
     * @returns {Promise<Answered>}
     * @throws {TypeError} for a value `inbound.mjs` did not mint for this chairman
     */
    answer(accepted) {
      if (!isAccepted(accepted, chairman)) throw new TypeError("only a value minted by createInbound for this chairman may write to a row");
      const value = /** @type {Readonly<Record<string, any>>} */ (accepted);
      // One at a time: two presses of one button must not both read "nothing done yet".
      const run = queue.then(() => resolve(value));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

/** @param {{body: string, createdAt: string, authorAssociation?: string}[]} comments @param {string} id @returns {{id: string, label: string} | null} the option the brief offers NOW */
function offeredOption(comments, id) {
  const brief = latestBrief(comments);
  return brief === null ? null : parseChairmanOptions(brief.body).options.find((option) => option.id === id) ?? null;
}

/**
 * The option a press resolves the request with: an option the brief offers NOW, or `approve` / `done`, which are answers in their own words. Null for a press
 * that resolves nothing (data outside the vocabulary, or a word that is not an answer).
 *
 * @param {ReturnType<typeof parseButtonData>} press @param {{body: string, createdAt: string, authorAssociation?: string}[]} comments @returns {{id: string, label: string} | null}
 */
function optionFor(press, comments) {
  if (press === null) return null;
  if (press.kind === "option") return offeredOption(comments, press.id);
  return RESOLVING.has(press.name) ? { id: press.name, label: ACTION_LABELS[press.name] } : null;
}

/** @param {Record<string, any>} sent @returns {string} the ask as the chairman was shown it, on one line: what the order is about */
function askOf(sent) {
  const text = typeof sent.text === "string" ? sent.text : "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ASK_QUOTED);
}

/** @param {{option: string | null}} progress @returns {{id: string, label: string} | null} the option the started answer was made with; its comment is already written, so the label is not needed */
function recordedOption({ option }) {
  return option === null ? null : { id: option, label: "" };
}
