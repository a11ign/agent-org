// THE IN-MEMORY PROVIDER: the reference that passes `runProviderConformance`, and what every core test sends through. It records what
// it was given in `sent`, so a test asserts what the CHAIRMAN would have received rather than what the core believes it did.
//
// It can fail on demand (`failNext`) because the core's handling of a provider that throws, with a token in the message, is the
// behaviour most worth testing and the one a real provider makes hard to provoke.
//
// TypeScript since a11ign/a11ign#3556: only tests import it, and node strips the types itself (README, "Source is TypeScript").

import { AUDIENCE, AUDIENCES } from "./provider-contract.ts";

const DEFAULT_MAX_TEXT = 4096;

// `destinations: 1` is the fake's default: one chat for both audiences, as a deployment with no announcements channel has. A test that
// routes asks and announcements to different places declares `destinations: 2` and reads `destination` off what was `sent`.
export const FULL_CAPABILITIES = Object.freeze({ silent: true, buttons: true, replies: true, conversation: true, maxText: DEFAULT_MAX_TEXT, destinations: 1 });

/** Widened to `boolean` and `number` on purpose: `Partial<typeof FULL_CAPABILITIES>` would pin each to the literal it is frozen with, so a test could not declare `silent: false` (#3571). */
type Capabilities = { silent?: boolean; buttons?: boolean; replies?: boolean; conversation?: boolean; maxText?: number; ratePerSecond?: number; destinations?: number };
type Record_ = Record<string, any>;

export function createFakeProvider({ id = "fake", capabilities = {} }: { id?: string; capabilities?: Capabilities } = {}) {
  const declared = { ...FULL_CAPABILITIES, ...capabilities };
  const sent: Record_[] = [];
  const inbox: Record_[] = [];
  const failures: unknown[] = [];

  return {
    id,
    capabilities: declared,
    sent,
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
    async poll(cursor: number | undefined, signal?: AbortSignal) {
      const after = typeof cursor === "number" ? cursor : 0;
      const updates = signal?.aborted ? [] : inbox.filter((update) => update.updateId > after);
      return { updates, cursor: updates.reduce((highest, update) => Math.max(highest, update.updateId), after) };
    },
  };
}
