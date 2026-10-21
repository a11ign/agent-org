// THE IN-MEMORY PROVIDER: the reference that passes `runProviderConformance`, and what every core test sends through. It records what
// it was given in `sent`, so a test asserts what the CHAIRMAN would have received rather than what the core believes it did.
//
// It can fail on demand (`failNext`) because the core's handling of a provider that throws, with a token in the message, is the
// behaviour most worth testing and the one a real provider makes hard to provoke.
//
// TypeScript since a11ign/a11ign#3556: only tests import it, and node strips the types itself (README, "Source is TypeScript").

import { AUDIENCE, AUDIENCES, type ListenOptions, type MessagingCapabilities } from "./provider-contract.ts";

const DEFAULT_MAX_TEXT = 4096;

// `destinations: 1` is the fake's default: one chat for both audiences, as a deployment with no announcements channel has. A test that
// routes asks and announcements to different places declares `destinations: 2` and reads `destination` off what was `sent`.
// It edits and pins (a11ign/a11ign#4744), so the asks row can be tested against it: an edit rewrites the `text` of the record in `sent`, and
// is kept in `edits`; `pinned` is the refs pinned, in order, as a chat's pinned list is (a pin adds to it, and pinning twice is one pin).
export const FULL_CAPABILITIES = Object.freeze({ silent: true, buttons: true, replies: true, conversation: true, maxText: DEFAULT_MAX_TEXT, destinations: 1, edit: true, pin: true });

type Record_ = Record<string, any>;

export function createFakeProvider({ id = "fake", capabilities = {} }: { id?: string; capabilities?: MessagingCapabilities } = {}) {
  const declared = { ...FULL_CAPABILITIES, ...capabilities };
  const sent: Record_[] = [];
  const inbox: Record_[] = [];
  const failures: unknown[] = [];
  const edits: { messageRef: string; from: string; to: string }[] = [];
  const pinned: string[] = [];
  const deleted: Record_[] = [];

  /** The record of a message this provider sent; one it never sent is what Telegram's "message to edit not found" is. */
  function sentRecord(messageRef: string): Record_ {
    const record = sent.find((entry) => entry.messageRef === messageRef);
    if (record === undefined) throw new RangeError(`fake provider: no message ${JSON.stringify(messageRef)} was sent`);
    return record;
  }

  return {
    id,
    capabilities: declared,
    sent,
    edits,
    pinned,
    /** what the inbound loop was told to delete from the chat (a message that held a credential), in order */
    deleted,
    /** the next `send` rejects with `error`, once */
    failNext(error: unknown) {
      failures.push(error);
    },
    /** an inbound update, with an increasing `updateId` */
    receive(update: Record_) {
      inbox.push(update);
    },
    async send(message: { text: string; silent?: boolean; actions?: unknown[]; replyTo?: string; audience?: string }) {
      if (failures.length > 0) throw failures.shift();
      if (typeof message?.text !== "string" || message.text === "") throw new RangeError("fake provider: text is empty");
      const audience = message.audience ?? AUDIENCE.ask;
      if (!AUDIENCES.includes(audience)) throw new RangeError(`fake provider: audience ${JSON.stringify(audience)} is not one of ${AUDIENCES.join(", ")}`);
      // The one-way channel, as the real provider enforces it: no actions ever, and no replyTo once the channel is a destination of its own.
      const toChannel = audience === AUDIENCE.announcement && declared.destinations >= AUDIENCES.length;
      if (audience === AUDIENCE.announcement && (message.actions?.length ?? 0) > 0) throw new RangeError("fake provider: an announcement is one-way and carries no actions");
      if (toChannel && message.replyTo !== undefined) throw new RangeError("fake provider: an announcement in the channel is one-way and carries no replyTo");
      if (message.text.length > declared.maxText) {
        throw new RangeError(`fake provider: ${message.text.length} characters exceeds maxText ${declared.maxText}`);
      }
      const silent = declared.silent && message.silent === true;
      const messageRef = `fake-${sent.length + 1}`;
      // `destination` is where it WENT: the audience's own place with two destinations, the one chat with one.
      const destination = declared.destinations >= AUDIENCES.length ? audience : AUDIENCE.ask;
      sent.push({ messageRef, text: message.text, silent, actions: message.actions, replyTo: message.replyTo, audience, destination });
      return { messageRef, silent, audience };
    },
    async edit({ messageRef, text }: { messageRef: string; text: string; audience?: string }) {
      if (failures.length > 0) throw failures.shift();
      const record = sentRecord(messageRef);
      if (typeof text !== "string" || text === "") throw new RangeError("fake provider: text is empty");
      if (text.length > declared.maxText) throw new RangeError(`fake provider: ${text.length} characters exceeds maxText ${declared.maxText}`);
      if (record.text === text) return { messageRef, unchanged: true };
      edits.push({ messageRef, from: record.text, to: text });
      record.text = text;
      return { messageRef, unchanged: false };
    },
    async pin({ messageRef }: { messageRef: string; audience?: string }) {
      if (failures.length > 0) throw failures.shift();
      sentRecord(messageRef);
      if (!pinned.includes(messageRef)) pinned.push(messageRef);
      return { messageRef };
    },
    async poll(cursor: number | undefined, signal?: AbortSignal) {
      const after = typeof cursor === "number" ? cursor : 0;
      const updates = signal?.aborted ? [] : inbox.filter((update) => idOf(update) > after);
      return { updates, cursor: updates.reduce((highest, update) => Math.max(highest, idOf(update)), after) };
    },
    /** The inbound loop (messaging contract 1.1), generic: see {@link listenOver}. */
    listen(options: ListenOptions): Promise<void> {
      return listenOver(this, deleted, options);
    },
  };
}

/**
 * Polls `provider`, hands each update to the core, and does what the core says (delete the message that held a credential, send the reply, forward what is accepted). It returns when the signal aborts
 * or when `poll` has nothing more: an in-memory inbox has no long poll to wait on, so a test that receives its updates first runs to the end.
 */
async function listenOver(provider: { poll: (cursor: number | undefined, signal?: AbortSignal) => Promise<{ updates: Record_[]; cursor: number | undefined }>; send: (message: { text: string }) => Promise<unknown> }, deleted: Record_[], { inbound, offsets, onForward = () => {}, signal }: ListenOptions): Promise<void> {
  let cursor = offsets.read();
  while (signal?.aborted !== true) {
    const batch = await provider.poll(cursor, signal);
    if (batch.updates.length === 0) return;
    for (const update of batch.updates) {
      const action = inbound.handle(update);
      if (action.action === "reply") {
        if (action.deleteMessage !== null) deleted.push(action.deleteMessage);
        await provider.send({ text: action.text });
      }
      if (action.action === "forward") await onForward(action.accepted);
    }
    if (batch.cursor !== undefined && batch.cursor !== cursor) offsets.write(batch.cursor);
    cursor = batch.cursor;
  }
}

/** An update's id: `updateId` as a test writes it, or `update_id` as the wire's updates carry it, which is what the core's inbound reads. */
const idOf = (update: Record_): number => update.updateId ?? update.update_id;
