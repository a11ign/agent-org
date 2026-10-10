// @ts-check
// WHAT A PROVIDER IS, AS ONE FUNCTION (decision 1: "`runProviderConformance(provider)` ... is the only definition of 'a provider'").
// A LEAF module. **Every provider's own test calls this**, so "does the Telegram provider honour `silent`" and "does the next one"
// are one question with one answer, and a provider that fails it cannot be wired in.
//
// THE INTERFACE:
//   { id, capabilities: { silent, buttons, replies, conversation, maxText, ratePerSecond?, destinations?, edit?, pin? },
//     send({ text, silent, actions, replyTo, audience }) -> { messageRef, silent, audience },
//     poll?(cursor, signal) -> { updates, cursor },
//     edit?({ messageRef, text, audience? }) -> { messageRef, unchanged },
//     pin?({ messageRef, audience? }) -> { messageRef } }
//
// **EDIT AND PIN ARE OPT-IN (a11ign/a11ign#4744).** The asks list ticks a resolved ask in place (`edit`) and keeps one message of what is open
// pinned (`pin`), and a provider that cannot do either says nothing: `capabilities.edit` and `capabilities.pin` are booleans when declared and
// absent means false, so a provider written before them is still a provider, and its two checks are `skipped` WITH the reason, never a pass.
// `edit` writes new text over a sent message and reports `unchanged: true` when the text already was that (a success: the state asked
// for), `unchanged: false` when it changed it (this suite asks for the second only: the first needs the provider's own wire answer,
// "message is not modified" for Telegram, which is the provider's own test to pin, as `disable_notification` is); it refuses empty text
// and text over `maxText` as `send` does, and a provider that cannot split an edit across messages may refuse sooner. `pin` is silent by contract: bookkeeping must not ring. Both take the `audience` the
// message was sent to (absent means `ask`), because a message ref means something only inside its own chat.
//
// **THE AUDIENCE IS WHICH DESTINATION (a11ign/a11ign#4742).** `ask` is the chairman's conversation: what needs him, one message per ask, and
// the only place a button or a reply belongs. `announcement` is a one-way channel: nothing there may require a reply, so a provider REFUSES
// `actions` on it always, and `replyTo` once the channel is a destination of its own. An absent `audience` is the provider's own business
// and means `ask`, where every send went before the field existed; it is the CORE that refuses a kind with no declared audience, never the
// provider that guesses one. A provider with one chat for both audiences says so (`capabilities.destinations` is 1): `audience` is still
// honoured (echoed) and `actions` are still refused, but an announcement is then in the chairman's chat as it always was, so a reply to
// the message it clears threads there as it always did.
//
// Three things here go beyond the design's sketch, and all exist so that a check CAN FAIL:
//   * `send` returns `audience` -- the destination it APPLIED, for the same reason it returns `silent`: a provider that ignores the field
//     and one that honours it would otherwise be indistinguishable here.
//   * `send` returns `silent` -- what it APPLIED. The design's `{ messageRef }` leaves "dropped `silent`" unobservable: a provider
//     that ignores the flag and one that honours it return the same value. Echoing it makes the claim checkable here; a provider's
//     own test still asserts the wire request (Telegram: `disable_notification`), which this suite cannot see.
//   * `send` REJECTS text longer than `maxText` (and empty text). The core truncates to the limit before it sends; the provider's
//     half is to refuse what it cannot deliver whole rather than cut it silently or send it past the limit.
//
// A check that does not apply (a provider that declares no `replies` is not asked to reply) is reported in `skipped` WITH its reason
// and never as a pass, and a provider's own test asserts what ran, so "the checks all skipped" is not a green result.

const CONTRACT_TEXT = "conformance probe";
const POLL_DEADLINE_MS = 1000;
const BOOLEAN_CAPABILITIES = Object.freeze(["silent", "buttons", "replies", "conversation"]);
/** Declared only by a provider that can do them: absent is false, so these are checked WHEN present and asked for only when `true`. */
const OPTIONAL_BOOLEAN_CAPABILITIES = Object.freeze(["edit", "pin"]);

/** Who a message is for. `ask` needs the chairman; `announcement` is told to him and asks nothing. The only two there are. */
export const AUDIENCE = Object.freeze({ ask: "ask", announcement: "announcement" });
/** Typed as strings on purpose: it is what an UNTRUSTED `audience` is checked against, so `includes` must accept one. */
export const AUDIENCES: readonly string[] = Object.freeze(Object.values(AUDIENCE));
/** How many distinct destinations a provider may route the audiences to: one per audience at most. */
const MAX_DESTINATIONS = AUDIENCES.length;

export class ConformanceError extends Error {
  failures: { check: string; message: string }[];
  passed: string[];
  skipped: { check: string; reason: string }[];
  /** @param {{check: string, message: string}[]} failures @param {string[]} passed @param {{check: string, reason: string}[]} skipped */
  constructor(failures: { check: string; message: string; }[], passed: string[], skipped: { check: string; reason: string; }[]) {
    super(`provider failed conformance: ${failures.map((failure) => `${failure.check} (${failure.message})`).join("; ")}`);
    this.name = "ConformanceError";
    this.failures = failures;
    this.passed = passed;
    this.skipped = skipped;
  }
}

/** @param {boolean} condition @param {string} message */
function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** @param {() => Promise<unknown>} action @returns {Promise<boolean>} whether it rejected */
async function rejects(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

/** @param {any} provider @param {Record<string, unknown>} message @returns {Promise<any>} */
async function sendOk(provider: any, message: Record<string, unknown>): Promise<any> {
  const result = await provider.send(message);
  expect(result !== null && typeof result === "object", "send returned no result object");
  expect(typeof result.messageRef === "string" && result.messageRef !== "", "send returned no messageRef");
  return result;
}

/** @type {Record<string, (provider: any) => Promise<void> | void>} */
const ALWAYS: Record<string, (provider: any) => Promise<void> | void> = {
  identity(provider) {
    expect(typeof provider.id === "string" && provider.id !== "", "id must be a non-empty string");
  },
  "capabilities-shape"(provider) {
    const caps = provider.capabilities;
    expect(caps !== null && typeof caps === "object", "capabilities must be an object");
    for (const name of BOOLEAN_CAPABILITIES) expect(typeof caps[name] === "boolean", `capabilities.${name} must be a boolean`);
    for (const name of OPTIONAL_BOOLEAN_CAPABILITIES) {
      expect(caps[name] === undefined || typeof caps[name] === "boolean", `capabilities.${name}, when declared, must be a boolean`);
    }
    expect(Number.isInteger(caps.maxText) && caps.maxText > 0, "capabilities.maxText must be a positive integer");
    expect(caps.ratePerSecond === undefined || (Number.isFinite(caps.ratePerSecond) && caps.ratePerSecond > 0),
      "capabilities.ratePerSecond, when declared, must be a positive number");
    expect(caps.destinations === undefined || (Number.isInteger(caps.destinations) && caps.destinations >= 1 && caps.destinations <= MAX_DESTINATIONS),
      `capabilities.destinations, when declared, must be an integer from 1 to ${MAX_DESTINATIONS}`);
  },
  async "send-returns-message-ref"(provider) {
    await sendOk(provider, { text: CONTRACT_TEXT });
  },
  async "message-refs-are-distinct"(provider) {
    const first = await sendOk(provider, { text: `${CONTRACT_TEXT} 1` });
    const second = await sendOk(provider, { text: `${CONTRACT_TEXT} 2` });
    expect(first.messageRef !== second.messageRef, "two sends returned the same messageRef");
  },
  async "silent-is-honoured"(provider) {
    const requested = await sendOk(provider, { text: CONTRACT_TEXT, silent: true });
    expect(requested.silent === provider.capabilities.silent,
      `silent was requested and the provider reports applying silent=${requested.silent} while declaring capabilities.silent=${provider.capabilities.silent}`);
    const ordinary = await sendOk(provider, { text: CONTRACT_TEXT, silent: false });
    expect(ordinary.silent === false, "an ordinary send was reported as silent");
  },
  async "audience-is-honoured"(provider) {
    for (const audience of AUDIENCES) {
      const result = await sendOk(provider, { text: CONTRACT_TEXT, audience });
      expect(result.audience === audience, `audience ${audience} was requested and the provider reports applying audience=${JSON.stringify(result.audience)}`);
    }
    const unspecified = await sendOk(provider, { text: CONTRACT_TEXT });
    expect(unspecified.audience === AUDIENCE.ask, `a send with no audience must land where every send did (ask), not ${JSON.stringify(unspecified.audience)}`);
  },
  async "unknown-audience-is-refused"(provider) {
    expect(await rejects(() => provider.send({ text: CONTRACT_TEXT, audience: "everyone" })), "an audience that is neither ask nor announcement was accepted");
  },
  async "max-text-is-accepted-at-the-limit"(provider) {
    await sendOk(provider, { text: "x".repeat(provider.capabilities.maxText) });
  },
  async "max-text-is-enforced"(provider) {
    const overlong = "x".repeat(provider.capabilities.maxText + 1);
    expect(await rejects(() => provider.send({ text: overlong })), `a text of maxText+1 (${overlong.length}) characters was accepted`);
  },
  async "empty-text-is-refused"(provider) {
    expect(await rejects(() => provider.send({ text: "" })), "an empty text was accepted");
  },
};

/** @type {Record<string, {applies: (provider: any) => boolean, reason: string, run: (provider: any) => Promise<void>}>} */
const CONDITIONAL: Record<string, { applies: (provider: any) => boolean; reason: string; run: (provider: any) => Promise<void>; }> = {
  "reply-to-is-accepted": {
    applies: (provider) => provider.capabilities.replies === true,
    reason: "capabilities.replies is not declared",
    async run(provider) {
      const original = await sendOk(provider, { text: CONTRACT_TEXT });
      await sendOk(provider, { text: `${CONTRACT_TEXT} reply`, replyTo: original.messageRef });
    },
  },
  "actions-are-accepted": {
    applies: (provider) => provider.capabilities.buttons === true,
    reason: "capabilities.buttons is not declared",
    async run(provider) {
      await sendOk(provider, { text: CONTRACT_TEXT, actions: [{ label: "Yes", data: "yes" }] });
    },
  },
  // The announcement is sent plain FIRST, so a refusal below is the one-way rule and not some other defect in the message.
  "announcement-refuses-actions": {
    applies: (provider) => provider.capabilities.buttons === true,
    reason: "capabilities.buttons is not declared, so no provider-drawn action can be asked of an announcement",
    async run(provider) {
      await sendOk(provider, { text: CONTRACT_TEXT, audience: AUDIENCE.announcement });
      const refused = await rejects(() => provider.send({ text: CONTRACT_TEXT, audience: AUDIENCE.announcement, actions: [{ label: "Yes", data: "yes" }] }));
      expect(refused, "an announcement carrying actions was accepted: the channel is one-way, so a button under it asks for an answer nobody reads");
    },
  },
  // Both directions, so the rule cannot be met by refusing always (which would fail every incident's "cleared" in a single chat).
  "announcement-reply-to-follows-its-destination": {
    applies: (provider) => provider.capabilities.replies === true,
    reason: "capabilities.replies is not declared, so a reply cannot be asked of an announcement",
    async run(provider) {
      const original = await sendOk(provider, { text: CONTRACT_TEXT });
      const reply = { text: CONTRACT_TEXT, audience: AUDIENCE.announcement, replyTo: original.messageRef };
      if ((provider.capabilities.destinations ?? 1) >= MAX_DESTINATIONS) {
        expect(await rejects(() => provider.send(reply)), "an announcement carrying replyTo into its own channel was accepted: the channel is one-way");
      } else {
        await sendOk(provider, reply);
      }
    },
  },
  "edit-changes-a-sent-message": {
    applies: (provider) => provider.capabilities.edit === true,
    reason: "capabilities.edit is not declared",
    async run(provider) {
      expect(typeof provider.edit === "function", "capabilities.edit is declared and edit is not a function");
      const original = await sendOk(provider, { text: CONTRACT_TEXT });
      const changed = await provider.edit({ messageRef: original.messageRef, text: `${CONTRACT_TEXT} edited` });
      expect(changed?.messageRef === original.messageRef, `edit reported messageRef ${JSON.stringify(changed?.messageRef)} for ${original.messageRef}`);
      expect(changed.unchanged === false, `an edit that changed the text reported unchanged=${JSON.stringify(changed.unchanged)}`);
    },
  },
  "edit-refuses-empty-and-overlong-text": {
    applies: (provider) => provider.capabilities.edit === true,
    reason: "capabilities.edit is not declared",
    async run(provider) {
      const original = await sendOk(provider, { text: CONTRACT_TEXT });
      expect(await rejects(() => provider.edit({ messageRef: original.messageRef, text: "" })), "an edit to empty text was accepted");
      const overlong = "x".repeat(provider.capabilities.maxText + 1);
      expect(await rejects(() => provider.edit({ messageRef: original.messageRef, text: overlong })), `an edit to a text of maxText+1 (${overlong.length}) characters was accepted`);
    },
  },
  "pin-is-accepted": {
    applies: (provider) => provider.capabilities.pin === true,
    reason: "capabilities.pin is not declared",
    async run(provider) {
      expect(typeof provider.pin === "function", "capabilities.pin is declared and pin is not a function");
      const original = await sendOk(provider, { text: CONTRACT_TEXT });
      const pinned = await provider.pin({ messageRef: original.messageRef });
      expect(pinned?.messageRef === original.messageRef, `pin reported messageRef ${JSON.stringify(pinned?.messageRef)} for ${original.messageRef}`);
    },
  },
  "poll-returns-updates-and-honours-abort": {
    applies: (provider) => provider.capabilities.conversation === true,
    reason: "capabilities.conversation is not declared",
    run: checkPoll,
  },
};

/** @param {any} provider */
async function checkPoll(provider: any) {
  expect(typeof provider.poll === "function", "capabilities.conversation is declared and poll is not a function");
  // One call, with a signal that is ALREADY aborted: a real long poll would otherwise block this check for its whole timeout, and
  // "returns promptly once told to stop" is the property the listener's shutdown depends on.
  const aborted = new AbortController();
  aborted.abort();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), POLL_DEADLINE_MS); });
  const settled = provider.poll(undefined, aborted.signal).then((/** @type {{updates?: unknown}} */ value: { updates?: unknown; }) => ({ value }), () => ({ rejected: true }));
  const outcome = await Promise.race([settled, deadline]);
  clearTimeout(timer);
  expect(!outcome.timedOut, `poll with an already-aborted signal did not settle within ${POLL_DEADLINE_MS} ms`);
  if ("value" in outcome) expect(Array.isArray(outcome.value?.updates), "poll must resolve { updates: [...], cursor }");
}

/** @param {string} check @param {() => unknown} run @param {{check: string, message: string}[]} failures @returns {Promise<boolean>} */
async function attempt(check: string, run: () => unknown, failures: { check: string; message: string; }[]): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    failures.push({ check, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Runs every check, so one run reports EVERY way a provider is wrong rather than the first.
 *
 * @param {any} provider
 * @returns {Promise<{passed: string[], skipped: {check: string, reason: string}[]}>} resolves only when nothing failed
 * @throws {ConformanceError} listing each failed check
 */
export async function runProviderConformance(provider: any): Promise<{ passed: string[]; skipped: { check: string; reason: string; }[]; }> {
  /** @type {{check: string, message: string}[]} */
  const failures: { check: string; message: string; }[] = [];
  /** @type {string[]} */
  const passed: string[] = [];
  /** @type {{check: string, reason: string}[]} */
  const skipped: { check: string; reason: string; }[] = [];
  const shapeOk = await attempt("provider-object", () => expect(provider !== null && typeof provider === "object" && typeof provider.send === "function", "a provider is an object with a send function"), failures);
  if (!shapeOk) throw new ConformanceError(failures, passed, skipped);
  for (const [check, run] of Object.entries(ALWAYS)) {
    if (await attempt(check, () => run(provider), failures)) passed.push(check);
  }
  for (const [check, { applies, reason, run }] of Object.entries(CONDITIONAL)) {
    if (!(await attempt(`${check}:applicability`, () => applies(provider), failures))) continue;
    if (!applies(provider)) skipped.push({ check, reason });
    else if (await attempt(check, () => run(provider), failures)) passed.push(check);
  }
  if (failures.length > 0) throw new ConformanceError(failures, passed, skipped);
  return { passed, skipped };
}
