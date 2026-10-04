// @ts-check
// CONVERSATION IN (a11ign/a11ign#2909, decision 2(b) as amended by #3416): a free message from the chairman, queued for the `liaison` and for nobody else.
// `createConverse({...}).forward` is what the listener's `onForward` calls with the value `createInbound(...).handle()` minted.
//
// **A CHAT MESSAGE GOES TO THE `liaison`, AND IF THE LIAISON'S QUEUE REFUSES IT, TO `ceo`: THE CHAIRMAN'S MESSAGE IS NEVER DROPPED (his order of 2026-10-04 19:55Z, a11ign/a11ign#3538).**
// This REVERSES the rule a11ign/a11ign#3416 wrote ("no fallback to `ceo`: the chairman is told the truth instead"), which on 2026-10-04 at 19:44Z answered his message
// with the queue's own refusal text and did nothing with it. The two recipients are the constants `RECIPIENT` (the liaison, always first) and `FALLBACK_RECIPIENT` (`ceo`, only
// after the liaison's queue refused for ANY reason: the seat absent from herdr's roster, a full inbox, a queue file that cannot be written), each written once and passed
// as the queue's label at the one call below; no argument, no field of the message and no configuration names another. The test scans every file under `src/messaging/`
// for a caller of the queue and fails on a second one, so a new path to a worker is a red test here and not a review comment. The queue is `prompt:session`'s own
// (`queueOrLose`), so its refusals are the ones every author gets, and they stay in the LEDGER (`refusal`): **the chairman is never shown them.** He is told in plain words what
// became of his message (`passedToFallback`, `notReached`), with no queue text, session label other than the two he knows by name, path or error class in it. Only when `ceo`'s
// queue refuses too is the message lost, and he is told exactly that and asked to send it again.
//
// **THE SENDER IS ONE NOBODY ELSE CAN DERIVE.** `resolveSender` builds every other sender from a herdr workspace id, so a session cannot
// produce `CHAIRMAN_SENDER` by being a workspace; only this module passes it. (A workspace LABELLED with that exact text used to be
// returned by `resolveSender`; a11ign/a11ign#3060 closed it in `prompt-session.mjs`, which now yields null for a label no session name looks like.)
//
// **THE ACKNOWLEDGEMENT IS THE LISTENER'S, AND IT COMES FIRST.** `ACKNOWLEDGEMENT` is sent BEFORE the queue is written, in the same words every time and with
// no model in it, so the chairman hears "Got it" at the speed of a poll and not of the liaison's turn (#3416). What follows it is the liaison's own answer,
// or, when the liaison's queue refused, one more message in plain words saying the message went to `ceo` (or, if his queue refused too, that nothing was delivered). The queue's verdict
// is still read back from the queue file; a queue that said it wrote and did not is treated as a refusal. The handoff id is the ledger's and never the chat's.
//
// **A BUTTON'S ORDER GOES TO THE SAME PLACE (a11ign/a11ign#3423).** `explain` and `stuck` ask the liaison for something, so `orderLiaison` is a second caller of `submit`, and so of
// the one queue call, with the same two constants and the same fallback: the recipient is still never an argument, a field of a message or configuration, and a worker or a reviewer still has
// no path. What it sends is the text the answers path built from a ledger-known request, never the chairman's own words.
//
// **WHAT THIS DOES NOT TAKE:** a button press as CONVERSATION (the answers path, #2908, owns it; `forward` still refuses one), and anything `isAccepted` does not vouch for. A value
// that was not minted by `createInbound` for THIS chairman is not a chairman's message, whatever its fields say.
//
// THE QUEUE IS A PORT, LOADED ON FIRST USE. `prompt-session.mjs` and `wake.mjs` read the project's declaration at import and refuse to
// load outside a project's layout, so a static import would make this leaf module (and its tests, run bare) unimportable here. The
// default port is the real queue; a test passes one only to drive what the real one cannot be asked to do in a bare checkout, and the
// test file says which of its cases ran against which.

import { readAgents } from "../herdr-agents.mjs";
import { isAccepted } from "./inbound.mjs";
import { describeError } from "./ledger.mjs";

/** The session a chat message is queued for. Changing it is changing decision 2(b). */
export const RECIPIENT = "liaison";
/** The only other session a chat message can reach, and only when the liaison's queue refused it (the chairman's order, a11ign/a11ign#3538). */
export const FALLBACK_RECIPIENT = "ceo";
/** What the chairman is told the moment a message is accepted: the same words each time, sent before the queue write, with no model in it. */
export const ACKNOWLEDGEMENT = "Got it, looking.";
/** The sender line the liaison reads. Not derivable by `resolveSender`, which only ever yields a herdr workspace's label. */
export const CHAIRMAN_SENDER = "chairman via Telegram";
/** Provenance the listener, and only the listener, can vouch for: `isAccepted` proved the ids match the paired chairman. */
export const SOURCE_LINE = "Source: Telegram, verified (sender and chat matched the paired chairman)";
const ORIGIN = "converse";
/** The ledger's verdict for a message the liaison's queue refused and `FALLBACK_RECIPIENT`'s took: spelled out so that nobody reads it as refused or as queued for the liaison. */
const REROUTED = `rerouted-to-${FALLBACK_RECIPIENT}`;
const REFUSAL_LINE_LIMIT = 200;
/** What the queue is told an order is for, which is what it says back when it refuses one. */
const WHY_MESSAGE = "the chairman wrote to the liaison";
const WHY_BUTTON = "the chairman pressed a button for the liaison";

/**
 * @typedef {{ queueOrLose: typeof import("../prompt-session.mjs").queueOrLose, attributed: (text: string, sender: string | null) => string,
 *   handoffId: (session: string, prompt: string) => string, readHandoffs: (path: string) => {id: string, session: string, prompt: string}[],
 *   EXIT: {OK: number, REFUSED: number, QUEUED: number}, STANCE: typeof import("../prompt-session.mjs").STANCE, defaultQueuePath?: () => string }} QueuePort
 */

/** @returns {Promise<QueuePort>} the real queue: `prompt:session`'s and the gate's own, imported only when a message arrives */
async function realQueue() {
  const [session, wake] = await Promise.all([import("../prompt-session.mjs"), import("../wake.mjs")]);
  const { queueOrLose, attributed, EXIT, STANCE } = session;
  // The queue file `prompt:session` and the gate resolve from no `--ledger`: asked of `wake.mjs`, so the file's name is defined once, there.
  return { queueOrLose, attributed, EXIT, STANCE, handoffId: wake.handoffId, readHandoffs: wake.readHandoffs, defaultQueuePath: () => wake.handoffQueuePath(wake.ledgerPathFrom([])) };
}

/**
 * The order the liaison reads for a button: the same provenance as a message, but the words are the organisation's own (what the press asked for).
 *
 * @param {{ text: string, messageRef: string }} order @param {number} receivedAt @param {string | null} [note] why it came to the fallback and not to the liaison, when it did
 * @returns {string}
 */
export function buttonOrderText({ text, messageRef }, receivedAt, note = null) {
  return [
    "This is the chairman pressing a button, not a session: do not answer it with `prompt:session`.",
    SOURCE_LINE,
    `Telegram message: ${messageRef} (a button press)`,
    `Received: ${new Date(receivedAt).toISOString()}`,
    ...(note === null ? [] : [note]),
    "",
    text,
  ].join("\n");
}

/**
 * What the queue printed while `run` ran. `queueOrLose` reports by writing to stderr and returning an exit code, and its refusal text
 * is the thing the chairman is owed, so it is read there rather than rebuilt here. Synchronous on purpose: nothing else writes during it.
 *
 * @template T @param {() => T} run @returns {{ value: T, stderr: string }}
 */
function capturingStderr(run) {
  const original = process.stderr.write;
  /** @type {string[]} */
  const chunks = [];
  process.stderr.write = /** @type {any} */ ((/** @type {any} */ chunk, /** @type {any[]} */ ...rest) => {
    chunks.push(String(chunk));
    rest.find((part) => typeof part === "function")?.();
    return true;
  });
  try {
    return { value: run(), stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * The order the liaison reads: who it is from, how it is known to be, which message, when, and then the chairman's words. The message ref and
 * the time are what make two identical messages two orders (the queue's id is a hash of the text, and one hash is one order).
 *
 * @param {Readonly<Record<string, any>>} accepted @param {number} receivedAt @param {string | null} [note] why it came to the fallback and not to the liaison, when it did
 * @returns {string}
 */
export function provenanceText(accepted, receivedAt, note = null) {
  return [
    "This is the chairman speaking, not a session.",
    SOURCE_LINE,
    `Telegram message: ${accepted.messageId} (update ${accepted.updateId})`,
    `Received: ${new Date(receivedAt).toISOString()}`,
    ...(note === null ? [] : [note]),
    "",
    accepted.text,
  ].join("\n");
}

/** What the chairman is told when the liaison's queue refused but `ceo`'s took the message, and the seat is not on herdr's roster. Plain words: no queue text. */
export const PASSED_SEAT_ABSENT = `The ${RECIPIENT} isn't running; I've passed this to ${FALLBACK_RECIPIENT}.`;
/** The same, for every other refusal (a full inbox, a queue file that would not take it). */
export const PASSED_REFUSED = `The ${RECIPIENT} couldn't take this just now; I've passed it to ${FALLBACK_RECIPIENT}.`;

/** @returns {string} the chairman's message when NEITHER queue took it: the one case where it is lost, said so in plain words, with the queue's text left in the ledger */
export function notReached() {
  return `I couldn't pass your message to the ${RECIPIENT} or to ${FALLBACK_RECIPIENT}, so nothing was delivered. Please send it again.`;
}

/** @param {string} reason @returns {string} the line the fallback's reader gets saying why this came to them and not to the liaison */
const reroutedNote = (reason) => `It came to you, ${FALLBACK_RECIPIENT}, and not to the ${RECIPIENT}, because the ${RECIPIENT}'s queue refused it: ${reason}`;

/** @param {string} reason @returns {string} the first line of the queue's refusal, cut short: the rest of it can repeat the message, which the ledger never holds */
const firstLine = (reason) => reason.split("\n")[0].slice(0, REFUSAL_LINE_LIMIT);

/** @param {string} text @param {number} limit @returns {string} `text`, cut to what the provider will carry and SAYING so when it had to be */
function withinLimit(text, limit) {
  if (text.length <= limit) return text;
  const note = " [cut to fit]";
  return `${text.slice(0, limit - note.length)}${note}`;
}

/**
 * @param {{ chairman: {userId: number, chatId: number}, queuePath?: string,
 *   ledger: {append: (entry: Record<string, unknown>) => Record<string, any>},
 *   send: (message: {text: string, replyTo?: string}) => Promise<{messageRef: string}>, maxText?: number,
 *   agents?: () => {label: string, status: string}[] | null, now?: () => number, queue?: QueuePort }} options
 *   `queuePath` is left out by the listener, so the port names it (the real queue's own file); a test gives one. `send` is the provider's; `agents` is herdr's roster (the queue refuses a session herdr does not know); `queue` is the port, real by default.
 */
export function createConverse({ chairman, queuePath, ledger, send, maxText = 4096, agents = readAgents, now = Date.now, queue }) {
  /** @type {Promise<QueuePort> | undefined} */
  let loaded;
  const port = () => (queue ? Promise.resolve(queue) : (loaded ??= realQueue()));

  /** @param {QueuePort} q @returns {string} */
  function pathOf(q) {
    const path = queuePath ?? q.defaultQueuePath?.();
    if (path === undefined) throw new Error("converse: no queue path was given and the queue port names none");
    return path;
  }

  /** @param {QueuePort} q @param {string} recipient @param {string} text @param {string} why @returns {{ code: number, stderr: string }} the queue's verdict, and what it said */
  function enqueue(q, recipient, text, why) {
    const { value, stderr } = capturingStderr(() => q.queueOrLose({
      label: recipient, text, why, agents: agents(), path: pathOf(q), stance: q.STANCE.UNDECLARED, sender: CHAIRMAN_SENDER,
    }));
    return { code: value, stderr };
  }

  /** @param {QueuePort} q @param {string} recipient @param {string} text @returns {string | null} the id of the entry, read back from the queue file; null when it is not there */
  function verifiedEntry(q, recipient, text) {
    const id = q.handoffId(recipient, q.attributed(text, CHAIRMAN_SENDER));
    return q.readHandoffs(pathOf(q)).some((entry) => entry.id === id && entry.session === recipient) ? id : null;
  }

  /**
   * One recipient's queue, asked once. `reason` is null when the message was queued, and otherwise the queue's own words for why it was not: they go to the ledger and to the
   * fallback's reader, and never to the chairman.
   * @param {QueuePort} q @param {string} recipient @param {string} text @param {string} why @returns {{ verdict: "queued" | "refused" | "unverified", reason: string | null, handoff: string | null }}
   */
  function attempt(q, recipient, text, why) {
    const { code, stderr } = enqueue(q, recipient, text, why);
    if (code !== q.EXIT.QUEUED) return { verdict: "refused", reason: stderr.trim() || "the queue refused the message and said nothing", handoff: null };
    const handoff = verifiedEntry(q, recipient, text);
    return handoff === null
      ? { verdict: "unverified", reason: "the queue said it held the message, but its entry is not in the queue file", handoff }
      : { verdict: "queued", reason: null, handoff };
  }

  /**
   * The liaison first; `ceo` only when the liaison's queue did not take it, for any reason, and told why. A message is lost only when both refuse.
   * `refusals` is the first line of each queue's refusal, in the order asked: the ledger's, and never the chat's.
   *
   * @param {QueuePort} q @param {(note: string | null) => string} words the order's text, with the note saying why it came to the fallback when it did @param {string} why
   * @returns {{ verdict: "queued" | typeof REROUTED | "refused" | "unverified", taker: string | null, handoff: string | null, refusals: string[] }}
   */
  function submit(q, words, why) {
    const first = attempt(q, RECIPIENT, words(null), why);
    if (first.reason === null) return { verdict: "queued", taker: RECIPIENT, handoff: first.handoff, refusals: [] };
    const refusal = firstLine(first.reason);
    const second = attempt(q, FALLBACK_RECIPIENT, words(reroutedNote(refusal)), why);
    if (second.reason === null) return { verdict: REROUTED, taker: FALLBACK_RECIPIENT, handoff: second.handoff, refusals: [refusal] };
    return { verdict: second.verdict, taker: null, handoff: null, refusals: [refusal, firstLine(second.reason)] };
  }

  /** @param {{ taker: string | null }} verdict @returns {string | null} what the chairman is told about where his message went: nothing when the liaison took it */
  function toldOf({ taker }) {
    if (taker === RECIPIENT) return null;
    if (taker === null) return notReached();
    const roster = agents();
    return Array.isArray(roster) && !roster.some((agent) => agent.label === RECIPIENT) ? PASSED_SEAT_ABSENT : PASSED_REFUSED;
  }

  /** @param {string} text @param {string} replyTo @returns {Promise<{ ref: string | null, error: unknown }>} */
  async function tell(text, replyTo) {
    try {
      return { ref: (await send({ text: withinLimit(text, maxText), replyTo })).messageRef, error: null };
    } catch (error) {
      return { ref: null, error };
    }
  }

  return {
    /**
     * An order for the liaison, from a button the answers path vetted; if the liaison's queue refuses it, it goes to `ceo` the same way a message does. Nothing is sent to the chairman and
     * nothing is written to the ledger here: the caller (`answers.mjs`) records the outcome and tells the chairman. `say` is for the ledger (the queue's words, never the chairman's); `told`
     * is what the chairman may be told when the order went to `ceo`, and null otherwise.
     *
     * @param {{ text: string, messageRef: string }} order
     * @returns {Promise<{ queued: boolean, say: string, handoff: string | null, taker: string | null, told: string | null }>}
     */
    async orderLiaison(order) {
      const verdict = submit(await port(), (note) => buttonOrderText(order, now(), note), WHY_BUTTON);
      const queued = verdict.taker !== null;
      const say = queued ? `queued for ${verdict.taker}, handoff ${verdict.handoff}` : `not delivered: ${verdict.refusals.join(" | ")}`;
      return { queued, say, handoff: verdict.handoff, taker: verdict.taker, told: verdict.taker === FALLBACK_RECIPIENT ? toldOf(verdict) : null };
    },
    /**
     * @param {Readonly<Record<string, any>>} accepted what `createInbound(...).handle()` returned with `action: "forward"`
     * @returns {Promise<{ outcome: "queued" | typeof REROUTED | "refused" | "unverified" | "not-conversation" | "not-accepted", handoff?: string | null }>}
     */
    async forward(accepted) {
      if (!isAccepted(accepted, chairman)) return { outcome: "not-accepted" };
      if (accepted.kind !== "message") return { outcome: "not-conversation" };
      // The acknowledgement goes first, before the queue is even loaded, so a slow or absent liaison cannot delay it and a queue that throws still leaves the chairman told.
      const ack = await tell(ACKNOWLEDGEMENT, String(accepted.messageId));
      const ackAt = new Date(now()).toISOString();
      const verdict = submit(await port(), (note) => provenanceText(accepted, now(), note), WHY_MESSAGE);
      const told = toldOf(verdict);
      const failure = told === null ? { ref: null, error: null } : await tell(told, String(accepted.messageId));
      const error = ack.error ?? failure.error;
      // The line holds refs and a verdict, never the words (as `inbound.mjs`'s do not): the chain is message -> handoff -> acknowledgement. `ackAt` is when
      // the acknowledgement was sent, so the time to acknowledge is `ackAt` less the inbound line's `ts`. `taker` is who holds the message (null when nobody does) and `refusals` is what each
      // queue that refused said, first line only: the one place the queue's own words are kept now that the chairman is not shown them.
      ledger.append({
        direction: "in", origin: ORIGIN, updateId: accepted.updateId, messageRef: String(accepted.messageId), verdict: verdict.verdict,
        handoff: verdict.handoff, taker: verdict.taker, refusals: verdict.refusals, ackRef: ack.ref, ackAt, error: error === null ? null : describeError(error),
      });
      if (error !== null) throw new Error(`converse: the message was ${verdict.verdict} but the acknowledgement could not be sent`, { cause: error });
      return { outcome: verdict.verdict, handoff: verdict.handoff };
    },
  };
}
