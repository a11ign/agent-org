// @ts-check
// THE IN-MEMORY PROVIDER: the reference that passes `runProviderConformance`, and what every core test sends through. It records what
// it was given in `sent`, so a test asserts what the CHAIRMAN would have received rather than what the core believes it did.
//
// It can fail on demand (`failNext`) because the core's handling of a provider that throws, with a token in the message, is the
// behaviour most worth testing and the one a real provider makes hard to provoke.

const DEFAULT_MAX_TEXT = 4096;

export const FULL_CAPABILITIES = Object.freeze({ silent: true, buttons: true, replies: true, conversation: true, maxText: DEFAULT_MAX_TEXT });

/**
 * @param {{id?: string, capabilities?: Partial<typeof FULL_CAPABILITIES> & {ratePerSecond?: number}}} [options]
 */
export function createFakeProvider({ id = "fake", capabilities = {} } = {}) {
  const declared = { ...FULL_CAPABILITIES, ...capabilities };
  /** @type {Record<string, any>[]} */
  const sent = [];
  /** @type {Record<string, any>[]} */
  const inbox = [];
  /** @type {unknown[]} */
  const failures = [];

  return {
    id,
    capabilities: declared,
    sent,
    /** @param {unknown} error the next `send` rejects with it, once */
    failNext(error) {
      failures.push(error);
    },
    /** @param {Record<string, any>} update an inbound update, with an increasing `updateId` */
    receive(update) {
      inbox.push(update);
    },
    /** @param {{text: string, silent?: boolean, actions?: unknown[], replyTo?: string}} message */
    async send(message) {
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
    /** @param {number | undefined} cursor @param {AbortSignal} [signal] */
    async poll(cursor, signal) {
      const after = typeof cursor === "number" ? cursor : 0;
      const updates = signal?.aborted ? [] : inbox.filter((update) => update.updateId > after);
      return { updates, cursor: updates.reduce((highest, update) => Math.max(highest, update.updateId), after) };
    },
  };
}
