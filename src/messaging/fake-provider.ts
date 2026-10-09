// THE IN-MEMORY PROVIDER: the reference that passes `runProviderConformance`, and what every core test sends through. It records what
// it was given in `sent`, so a test asserts what the CHAIRMAN would have received rather than what the core believes it did.
//
// It can fail on demand (`failNext`) because the core's handling of a provider that throws, with a token in the message, is the
// behaviour most worth testing and the one a real provider makes hard to provoke.
//
// TypeScript since a11ign/a11ign#3556: only tests import it, and node strips the types itself (README, "Source is TypeScript").

const DEFAULT_MAX_TEXT = 4096;

export const FULL_CAPABILITIES = Object.freeze({ silent: true, buttons: true, replies: true, conversation: true, maxText: DEFAULT_MAX_TEXT });

/** Widened to `boolean` and `number` on purpose: `Partial<typeof FULL_CAPABILITIES>` would pin each to the literal it is frozen with, so a test could not declare `silent: false` (#3571). */
type Capabilities = { silent?: boolean; buttons?: boolean; replies?: boolean; conversation?: boolean; maxText?: number; ratePerSecond?: number };
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
    async send(message: { text: string; silent?: boolean; actions?: unknown[]; replyTo?: string }) {
      if (failures.length > 0) throw failures.shift();
      if (typeof message?.text !== "string" || message.text === "") throw new RangeError("fake provider: text is empty");
      if (message.text.length > declared.maxText) {
        throw new RangeError(`fake provider: ${message.text.length} characters exceeds maxText ${declared.maxText}`);
      }
      const silent = declared.silent && message.silent === true;
      const messageRef = `fake-${sent.length + 1}`;
      sent.push({ messageRef, text: message.text, silent, actions: message.actions, replyTo: message.replyTo });
      return { messageRef, silent };
    },
    async poll(cursor: number | undefined, signal?: AbortSignal) {
      const after = typeof cursor === "number" ? cursor : 0;
      const updates = signal?.aborted ? [] : inbox.filter((update) => update.updateId > after);
      return { updates, cursor: updates.reduce((highest, update) => Math.max(highest, update.updateId), after) };
    },
  };
}
