// @ts-check
// CONVERSATION IN (a11ign/a11ign#2909, decision 2(b)): a free message from the chairman, queued for `ceo` and for nobody else.
// `createConverse({...}).forward` is what the listener's `onForward` calls with the value `createInbound(...).handle()` minted.
//
// **THERE IS NO CODE PATH FROM A CHAT MESSAGE TO ANY SESSION BUT `ceo`.** The recipient is the constant `RECIPIENT`, written once and
// passed as the queue's label at the one call below; no argument, no field of the message and no configuration names another. The test
// scans every file under `src/messaging/` for a caller of the queue and fails on a second one, so a new path to a worker is a red test
// here and not a review comment. The queue is `prompt:session`'s own (`queueOrLose`), so its refusals (an unknown session, a full inbox)
// are the ones every author gets, and they are sent back to the chairman WORD FOR WORD: a paraphrase of a refusal is a claim the
// queue did not make.
//
// **THE SENDER IS ONE NOBODY ELSE CAN DERIVE.** `resolveSender` builds every other sender from a herdr workspace id, so a session cannot
// produce `CHAIRMAN_SENDER` by being a workspace; only this module passes it. (A workspace LABELLED with that exact text used to be
// returned by `resolveSender`; a11ign/a11ign#3060 closed it in `prompt-session.mjs`, which now yields null for a label no session name looks like.)
//
// **THE ACKNOWLEDGEMENT IS A FACT THE CORE VERIFIED.** "queued for ceo, handoff <id>" is sent only after reading the entry back from the
// queue file; a queue that said it wrote and did not is reported as that, never as success.
//
// **THE LIAISON IS THE ONE OTHER RECIPIENT (a11ign/a11ign#3423), AND ONLY FOR A BUTTON.** `explain` and `stuck` ask the liaison for something, so `orderLiaison` is
// the second caller of the one queue call, with the second constant `LIAISON`: the recipient is still never an argument, a field of a message or configuration,
// and a worker or a reviewer still has no path. What it sends is the text the answers path built from a ledger-known request, never the chairman's own words.
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

/** The only session a chat message is ever queued for. Changing it is changing decision 2(b). */
export const RECIPIENT = "ceo";
/** The only other session this module queues for, and only through `orderLiaison`. Changing it is changing the button decision (a11ign/a11ign#3423). */
export const LIAISON = "liaison";
/** The sender line `ceo` reads. Not derivable by `resolveSender`, which only ever yields a herdr workspace's label. */
export const CHAIRMAN_SENDER = "chairman via Telegram";
/** Provenance the listener, and only the listener, can vouch for: `isAccepted` proved the ids match the paired chairman. */
export const SOURCE_LINE = "Source: Telegram, verified (sender and chat matched the paired chairman)";
const ORIGIN = "converse";
/** What the queue is told the order is for, which is what it says back when it refuses one. */
const WHY = Object.freeze({ [RECIPIENT]: "the chairman wrote to ceo", [LIAISON]: "the chairman pressed a button for the liaison" });

/**
 * @typedef {{ queueOrLose: (order: Record<string, any>) => number, attributed: (text: string, sender: string | null) => string,
 *   handoffId: (session: string, prompt: string) => string, readHandoffs: (path: string) => {id: string, session: string, prompt: string}[],
 *   EXIT: {OK: number, REFUSED: number, QUEUED: number}, STANCE: Record<string, string>, defaultQueuePath?: () => string }} QueuePort
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
 * @param {{ text: string, messageRef: string }} order @param {number} receivedAt @returns {string}
 */
export function buttonOrderText({ text, messageRef }, receivedAt) {
  return [
    "This is the chairman pressing a button, not a session: do not answer it with `prompt:session`.",
    SOURCE_LINE,
    `Telegram message: ${messageRef} (a button press)`,
    `Received: ${new Date(receivedAt).toISOString()}`,
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
 * The order `ceo` reads: who it is from, how it is known to be, which message, when, and then the chairman's words. The message ref and
 * the time are what make two identical messages two orders (the queue's id is a hash of the text, and one hash is one order).
 *
 * @param {Readonly<Record<string, any>>} accepted @param {number} receivedAt @returns {string}
 */
export function provenanceText(accepted, receivedAt) {
  return [
    "This is the chairman speaking, not a session: do not answer it with `prompt:session`.",
    SOURCE_LINE,
    `Telegram message: ${accepted.messageId} (update ${accepted.updateId})`,
    `Received: ${new Date(receivedAt).toISOString()}`,
    "",
    accepted.text,
  ].join("\n");
}

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

  /** @param {QueuePort} q @param {string} recipient one of the two constants above @param {string} text @returns {{ code: number, stderr: string }} the queue's verdict, and what it said */
  function enqueue(q, recipient, text) {
    const { value, stderr } = capturingStderr(() => q.queueOrLose({
      label: recipient, text, why: WHY[recipient], agents: agents(), path: pathOf(q), stance: q.STANCE.UNDECLARED, sender: CHAIRMAN_SENDER,
    }));
    return { code: value, stderr };
  }

  /** @param {QueuePort} q @param {string} recipient @param {string} text @returns {string | null} the id of the entry, read back from the queue file; null when it is not there */
  function verifiedEntry(q, recipient, text) {
    const id = q.handoffId(recipient, q.attributed(text, CHAIRMAN_SENDER));
    return q.readHandoffs(pathOf(q)).some((entry) => entry.id === id && entry.session === recipient) ? id : null;
  }

  /** @param {QueuePort} q @param {string} recipient @param {string} text @returns {{ verdict: string, say: string, handoff: string | null }} */
  function submit(q, recipient, text) {
    const { code, stderr } = enqueue(q, recipient, text);
    if (code !== q.EXIT.QUEUED) return { verdict: "refused", say: stderr.trim() || "the queue refused the message and said nothing", handoff: null };
    const handoff = verifiedEntry(q, recipient, text);
    return handoff === null
      ? { verdict: "unverified", say: "the queue said it held the message, but its entry is not in the queue file: treat it as NOT delivered", handoff }
      : { verdict: "queued", say: `queued for ${recipient}, handoff ${handoff}`, handoff };
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
     * An order for the liaison, from a button the answers path vetted. Nothing is sent to the chairman and nothing is written to the ledger here: the caller
     * (`answers.mjs`) records the outcome and tells the chairman, and a refusal is returned in the queue's own words.
     *
     * @param {{ text: string, messageRef: string }} order @returns {Promise<{ queued: boolean, say: string, handoff: string | null }>}
     */
    async orderLiaison(order) {
      const verdict = submit(await port(), LIAISON, buttonOrderText(order, now()));
      return { queued: verdict.verdict === "queued", say: verdict.say, handoff: verdict.handoff };
    },
    /**
     * @param {Readonly<Record<string, any>>} accepted what `createInbound(...).handle()` returned with `action: "forward"`
     * @returns {Promise<{ outcome: "queued" | "refused" | "unverified" | "not-conversation" | "not-accepted", handoff?: string | null }>}
     */
    async forward(accepted) {
      if (!isAccepted(accepted, chairman)) return { outcome: "not-accepted" };
      if (accepted.kind !== "message") return { outcome: "not-conversation" };
      const verdict = submit(await port(), RECIPIENT, provenanceText(accepted, now()));
      const ack = await tell(verdict.say, String(accepted.messageId));
      // The line holds refs and a verdict, never the words (as `inbound.mjs`'s do not): the chain is message -> handoff -> acknowledgement.
      ledger.append({
        direction: "in", origin: ORIGIN, updateId: accepted.updateId, messageRef: String(accepted.messageId), verdict: verdict.verdict,
        handoff: verdict.handoff, ackRef: ack.ref, error: ack.error === null ? null : describeError(ack.error),
      });
      if (ack.error !== null) throw new Error(`converse: the message was ${verdict.verdict} but the acknowledgement could not be sent`, { cause: ack.error });
      return { outcome: /** @type {any} */ (verdict.verdict), handoff: verdict.handoff };
    },
  };
}
