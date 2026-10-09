// CONVERSATION IN (a11ign/a11ign#2909, decision 2(b) as amended by #3416): a free message from the chairman, queued for the `liaison` and for nobody else.
// `createConverse({...}).forward` is what the listener's `onForward` calls with the value `createInbound(...).handle()` minted.
//
// **A CHAT MESSAGE GOES TO THE `liaison`, AND IF THE LIAISON'S QUEUE REFUSES IT, TO `ceo`: THE CHAIRMAN'S MESSAGE IS NEVER DROPPED (his order of 2026-10-04 19:55Z, a11ign/a11ign#3538).**
// This REVERSES the rule a11ign/a11ign#3416 wrote ("no fallback to `ceo`: the chairman is told the truth instead"), which on 2026-10-04 at 19:44Z answered his message
// with the queue's own refusal text and did nothing with it. The two recipients are the constants `RECIPIENT` (the liaison, always first) and `FALLBACK_RECIPIENT` (`ceo`, only
// after the liaison's queue refused for ANY reason: the seat absent from herdr's roster, a full inbox, a queue file that cannot be written), each written once and passed
// as the label at the one call below; no argument, no field of the message and no configuration names another. The test scans every file under `src/messaging/`
// for a caller of the queue and fails on a second one, so a new path to a worker is a red test here and not a review comment. The call is `prompt:session`'s own
// (`promptOrQueue`), so its refusals are the ones every author gets, and they stay in the LEDGER (`refusals`): **the chairman is never shown them.**
//
// **AN IDLE SEAT IS PROMPTED AT ONCE, AND ONLY A BUSY ONE WAITS FOR THE TICK (the chairman's order of 2026-10-04T21:40Z, a11ign/a11ign#3536, done-when 7).** This module used to call `queueOrLose`
// alone, so every message waited for the next `work:tick`, and with the host at load 98 a tick took 6 min 44 s: his question (ref 92) sat undelivered behind it. `promptOrQueue` delivers to
// a seat that is between tasks and queues for one that is not, with the same refusals for a name the roster does not list, so the liaison's absence still falls back to `ceo` as it did. The
// ledger line says `delivered` or `queued` (`delivery`), and `verdict` keeps its words for the cases it already had; a direct delivery leaves no queue entry, so its `handoff` is null and
// there is nothing to read back: `promptOrQueue` returned having typed the order into the seat. He is told in plain words what
// became of his message (`passedToFallback`, `notReached`), with no queue text, session label other than the two he knows by name, path or error class in it. Only when `ceo`'s
// queue refuses too is the message lost, and he is told exactly that and asked to send it again.
//
// **THE SENDER IS ONE NOBODY ELSE CAN DERIVE.** `resolveSender` builds every other sender from a herdr workspace id, so a session cannot
// produce `CHAIRMAN_SENDER` by being a workspace; only this module passes it. (A workspace LABELLED with that exact text used to be
// returned by `resolveSender`; a11ign/a11ign#3060 closed it in `prompt-session.ts`, which now yields null for a label no session name looks like.)
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
// THE QUEUE IS A PORT, LOADED ON FIRST USE. `prompt-session.ts` and `wake.ts` read the project's declaration at import and refuse to
// load outside a project's layout, so a static import would make this leaf module (and its tests, run bare) unimportable here. The
// default port is the real queue; a test passes one only to drive what the real one cannot be asked to do in a bare checkout, and the
// test file says which of its cases ran against which.

import { readAgents } from "../herdr-agents.ts";
import { isAccepted } from "./inbound.ts";
import { describeError } from "./ledger.ts";

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

/**
 * `promptOrQueue` is `prompt:session`'s own: it types the order into a seat that is between tasks (`run` is herdr) and queues it for one that is not. `NOT_QUEUED_PREFIX` starts every refusal of the
 * queue, which is how a refusal is told from an order that WENT and came back with a caution (a refused `/clear`). `delivery` is for a test: the seams `promptOrQueue` takes (`sleep`, `checkout`, `contextRoot`, `clock`).
 */
export type QueuePort = {
  promptOrQueue: typeof import("../prompt-session.ts").promptOrQueue; run: (args: string[]) => string; delivery?: Partial<Parameters<typeof import("../prompt-session.ts").promptOrQueue>[0]>;
  NOT_QUEUED_PREFIX: string; attributed: (text: string, sender: string | null) => string;
  handoffId: (session: string, prompt: string) => string; readHandoffs: (path: string) => { id: string; session: string; prompt: string }[];
  EXIT: { OK: number; REFUSED: number; QUEUED: number }; STANCE: typeof import("../prompt-session.ts").STANCE; defaultQueuePath?: () => string;
};

/** The real queue: `prompt:session`'s and the gate's own, imported only when a message arrives */
export async function realQueue(): Promise<QueuePort> {
  const [session, wake] = await Promise.all([import("../prompt-session.ts"), import("../wake.ts")]);
  const { promptOrQueue, defaultRun, attributed, EXIT, STANCE, NOT_QUEUED_PREFIX } = session;
  // The queue file `prompt:session` and the gate resolve from no `--ledger`: asked of `wake.ts`, so the file's name is defined once, there.
  return { promptOrQueue, run: defaultRun, NOT_QUEUED_PREFIX, attributed, EXIT, STANCE, handoffId: wake.handoffId, readHandoffs: wake.readHandoffs, defaultQueuePath: () => wake.handoffQueuePath(wake.ledgerPathFrom([])) };
}

/**
 * The order the liaison reads for a button: the same provenance as a message, but the words are the organisation's own (what the press asked for).
 *
 * `note` is why it came to the fallback and not to the liaison, when it did.
 */
export function buttonOrderText({ text, messageRef }: { text: string; messageRef: string; }, receivedAt: number, note: string | null = null): string {
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
 */
function capturingStderr<T>(run: () => T): { value: T; stderr: string; } {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    (rest.find((part) => typeof part === "function") as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stderr.write;
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
 * `note` is why it came to the fallback and not to the liaison, when it did.
 */
export function provenanceText(accepted: Readonly<Record<string, any>>, receivedAt: number, note: string | null = null): string {
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

/** The chairman's message when NEITHER queue took it: the one case where it is lost, said so in plain words, with the queue's text left in the ledger */
export function notReached(): string {
  return `I couldn't pass your message to the ${RECIPIENT} or to ${FALLBACK_RECIPIENT}, so nothing was delivered. Please send it again.`;
}

/** The line the fallback's reader gets saying why this came to them and not to the liaison */
const reroutedNote = (reason: string): string => `It came to you, ${FALLBACK_RECIPIENT}, and not to the ${RECIPIENT}, because the ${RECIPIENT}'s queue refused it: ${reason}`;

/** The first line of the queue's refusal, cut short: the rest of it can repeat the message, which the ledger never holds */
const firstLine = (reason: string): string => reason.split("\n")[0].slice(0, REFUSAL_LINE_LIMIT);

/** `text`, cut to what the provider will carry and SAYING so when it had to be */
function withinLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = " [cut to fit]";
  return `${text.slice(0, limit - note.length)}${note}`;
}

/**
 * `queuePath` is left out by the listener, so the port names it (the real queue's own file); a test gives one. `send` is the provider's; `agents` is herdr's roster (the queue refuses a session herdr does not know); `queue` is the port, real by default.
 */
export function createConverse({ chairman, queuePath, ledger, send, maxText = 4096, agents = readAgents, now = Date.now, queue }: {
        chairman: { userId: number; chatId: number; }; queuePath?: string;
        ledger: { append: (entry: Record<string, unknown>) => Record<string, any>; };
        send: (message: { text: string; replyTo?: string; }) => Promise<{ messageRef: string; }>; maxText?: number;
        agents?: () => { label: string; status: string; }[] | null; now?: () => number; queue?: QueuePort;
    }) {
  let loaded: Promise<QueuePort> | undefined;
  const port = () => (queue ? Promise.resolve(queue) : (loaded ??= realQueue()));

  function pathOf(q: QueuePort): string {
    const path = queuePath ?? q.defaultQueuePath?.();
    if (path === undefined) throw new Error("converse: no queue path was given and the queue port names none");
    return path;
  }

  /** What `promptOrQueue` decided, and what it said: it delivers to an idle seat and queues for a busy one */
  function dispatch(q: QueuePort, recipient: string, text: string): { code: number; stderr: string; } {
    // The path and the roster are read OUTSIDE the try, as they always were: a queue path that cannot be had and a roster that cannot be read are the listener's to report, and only the call that touches herdr is a refusal.
    const path = pathOf(q);
    const roster = agents();
    const { value, stderr } = capturingStderr(() => {
      try {
        // A REAL ORDER, NOT THE CLI DEFAULT (#3562): an undeclared order to a lead seat reads as an FYI and is HELD for the seat's next real order, and the chairman's message is the one order that must wake it. `ORDER` and not `DECISION`, because a decision is exempt from the deep-queue refusal this module's reroute depends on.
        return q.promptOrQueue({ run: q.run, label: recipient, text, agents: roster, path, stance: q.STANCE.ORDER, sender: CHAIRMAN_SENDER, ...q.delivery });
      } catch (error) {
        // herdr missing or hung is a refusal like any other, and the next recipient is tried: this must not end the listener's turn with the message unrecorded.
        process.stderr.write(`${q.NOT_QUEUED_PREFIX}${describeError(error)}\n`);
        return q.EXIT.REFUSED;
      }
    });
    return { code: value, stderr };
  }

  /** The id of the entry, read back from the queue file; null when it is not there */
  function verifiedEntry(q: QueuePort, recipient: string, text: string): string | null {
    const id = q.handoffId(recipient, q.attributed(text, CHAIRMAN_SENDER));
    return q.readHandoffs(pathOf(q)).some((entry) => entry.id === id && entry.session === recipient) ? id : null;
  }

  /**
   * One recipient, asked once. `reason` is null when the message was taken, and otherwise the queue's own words for why it was not: they go to the ledger and to the
   * fallback's reader, and never to the chairman. `delivered` is an order typed into an idle seat (nothing to read back: `promptOrQueue` returned having sent it, and a second send
   * to `ceo` on a doubt would be the duplicate its own rule forbids), `queued` is an entry read back from the queue file.
   *
   * A REFUSED code with no queue prefix on its words is the order that WENT and came back with a caution (`prompt:session`: the text landed, a `/clear` was refused), so it is delivered.
   */
  function attempt(q: QueuePort, recipient: string, text: string): { verdict: "delivered" | "queued" | "refused" | "unverified"; reason: string | null; handoff: string | null; } {
    const { code, stderr } = dispatch(q, recipient, text);
    const wentAnyway = code === q.EXIT.REFUSED && !stderr.includes(q.NOT_QUEUED_PREFIX);
    if (code === q.EXIT.OK || wentAnyway) return { verdict: "delivered", reason: null, handoff: null };
    if (code !== q.EXIT.QUEUED) return { verdict: "refused", reason: stderr.trim() || "the queue refused the message and said nothing", handoff: null };
    const handoff = verifiedEntry(q, recipient, text);
    return handoff === null
      ? { verdict: "unverified", reason: "the queue said it held the message, but its entry is not in the queue file", handoff }
      : { verdict: "queued", reason: null, handoff };
  }

  /**
   * The liaison first; `ceo` only when the liaison's seat did not take it, for any reason, and told why. A message is lost only when both refuse.
   * `refusals` is the first line of each queue's refusal, in the order asked: the ledger's, and never the chat's. `delivery` is how the taker got it.
   * `words` is the order's text, with the note saying why it came to the fallback when it did.
   */
  function submit(q: QueuePort, words: (note: string | null) => string): { verdict: "delivered" | "queued" | typeof REROUTED | "refused" | "unverified"; delivery: "delivered" | "queued" | null; taker: string | null; handoff: string | null; refusals: string[]; } {
    const first = attempt(q, RECIPIENT, words(null));
    if (first.reason === null) return { verdict: first.verdict as "delivered" | "queued", delivery: first.verdict as "delivered" | "queued", taker: RECIPIENT, handoff: first.handoff, refusals: [] };
    const refusal = firstLine(first.reason);
    const second = attempt(q, FALLBACK_RECIPIENT, words(reroutedNote(refusal)));
    if (second.reason === null) return { verdict: REROUTED, delivery: second.verdict as "delivered" | "queued", taker: FALLBACK_RECIPIENT, handoff: second.handoff, refusals: [refusal] };
    return { verdict: second.verdict, delivery: null, taker: null, handoff: null, refusals: [refusal, firstLine(second.reason)] };
  }

  /** What the chairman is told about where his message went: nothing when the liaison took it */
  function toldOf({ taker }: { taker: string | null; }): string | null {
    if (taker === RECIPIENT) return null;
    if (taker === null) return notReached();
    const roster = agents();
    return Array.isArray(roster) && !roster.some((agent) => agent.label === RECIPIENT) ? PASSED_SEAT_ABSENT : PASSED_REFUSED;
  }

  async function tell(text: string, replyTo: string): Promise<{ ref: string | null; error: unknown; }> {
    try {
      return { ref: (await send({ text: withinLimit(text, maxText), replyTo })).messageRef, error: null };
    } catch (error) {
      return { ref: null, error };
    }
  }

  return {
    /**
     * An order for the liaison, from a button the answers path vetted; if the liaison's seat refuses it, it goes to `ceo` the same way a message does. `queued` is "somebody took it" (typed into an idle seat, or queued for a busy one), the answers path's own word for it. Nothing is sent to the chairman and
     * nothing is written to the ledger here: the caller (`answers.ts`) records the outcome and tells the chairman. `say` is for the ledger (the queue's words, never the chairman's); `told`
     * is what the chairman may be told when the order went to `ceo`, and null otherwise.
     */
    async orderLiaison(order: { text: string; messageRef: string; }): Promise<{ queued: boolean; say: string; handoff: string | null; taker: string | null; told: string | null; }> {
      const verdict = submit(await port(), (note) => buttonOrderText(order, now(), note));
      const queued = verdict.taker !== null;
      const say = !queued ? `not delivered: ${verdict.refusals.join(" | ")}`
        : verdict.delivery === "delivered" ? `delivered to ${verdict.taker}` : `queued for ${verdict.taker}, handoff ${verdict.handoff}`;
      return { queued, say, handoff: verdict.handoff, taker: verdict.taker, told: verdict.taker === FALLBACK_RECIPIENT ? toldOf(verdict) : null };
    },
    /** `accepted` is what `createInbound(...).handle()` returned with `action: "forward"`. */
    async forward(accepted: Readonly<Record<string, any>>): Promise<{ outcome: "delivered" | "queued" | typeof REROUTED | "refused" | "unverified" | "not-conversation" | "not-accepted"; handoff?: string | null; }> {
      if (!isAccepted(accepted, chairman)) return { outcome: "not-accepted" };
      if (accepted.kind !== "message") return { outcome: "not-conversation" };
      // The acknowledgement goes first, before the queue is even loaded, so a slow or absent liaison cannot delay it and a queue that throws still leaves the chairman told.
      const ack = await tell(ACKNOWLEDGEMENT, String(accepted.messageId));
      const ackAt = new Date(now()).toISOString();
      const verdict = submit(await port(), (note) => provenanceText(accepted, now(), note));
      const told = toldOf(verdict);
      const failure = told === null ? { ref: null, error: null } : await tell(told, String(accepted.messageId));
      const error = ack.error ?? failure.error;
      // The line holds refs and a verdict, never the words (as `inbound.ts`'s do not): the chain is message -> handoff -> acknowledgement (no handoff when it was delivered). `delivery` is `delivered` or `queued`. `ackAt` is when
      // the acknowledgement was sent, so the time to acknowledge is `ackAt` less the inbound line's `ts`. `taker` is who holds the message (null when nobody does) and `refusals` is what each
      // queue that refused said, first line only: the one place the queue's own words are kept now that the chairman is not shown them.
      ledger.append({
        direction: "in", origin: ORIGIN, updateId: accepted.updateId, messageRef: String(accepted.messageId), verdict: verdict.verdict, delivery: verdict.delivery,
        handoff: verdict.handoff, taker: verdict.taker, refusals: verdict.refusals, ackRef: ack.ref, ackAt, error: error === null ? null : describeError(error),
      });
      if (error !== null) throw new Error(`converse: the message was ${verdict.verdict} but the acknowledgement could not be sent`, { cause: error });
      return { outcome: verdict.verdict, handoff: verdict.handoff };
    },
  };
}
