// @ts-check
// WHAT A PROVIDER IS, AS ONE FUNCTION (decision 1: "`runProviderConformance(provider)` ... is the only definition of 'a provider'").
// A LEAF module. **Every provider's own test calls this**, so "does the Telegram provider honour `silent`" and "does the next one"
// are one question with one answer, and a provider that fails it cannot be wired in.
//
// THE INTERFACE:
//   { id, capabilities: { silent, buttons, replies, conversation, maxText, ratePerSecond? },
//     send({ text, silent, actions, replyTo }) -> { messageRef, silent },
//     poll?(cursor, signal) -> { updates, cursor } }
//
// Two things here go beyond the design's sketch, and both exist so that a check CAN FAIL:
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

export class ConformanceError extends Error {
  /** @param {{check: string, message: string}[]} failures @param {string[]} passed @param {{check: string, reason: string}[]} skipped */
  constructor(failures, passed, skipped) {
    super(`provider failed conformance: ${failures.map((failure) => `${failure.check} (${failure.message})`).join("; ")}`);
    this.name = "ConformanceError";
    this.failures = failures;
    this.passed = passed;
    this.skipped = skipped;
  }
}

/** @param {boolean} condition @param {string} message */
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {() => Promise<unknown>} action @returns {Promise<boolean>} whether it rejected */
async function rejects(action) {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

/** @param {any} provider @param {Record<string, unknown>} message @returns {Promise<any>} */
async function sendOk(provider, message) {
  const result = await provider.send(message);
  expect(result !== null && typeof result === "object", "send returned no result object");
  expect(typeof result.messageRef === "string" && result.messageRef !== "", "send returned no messageRef");
  return result;
}

/** @type {Record<string, (provider: any) => Promise<void> | void>} */
const ALWAYS = {
  identity(provider) {
    expect(typeof provider.id === "string" && provider.id !== "", "id must be a non-empty string");
  },
  "capabilities-shape"(provider) {
    const caps = provider.capabilities;
    expect(caps !== null && typeof caps === "object", "capabilities must be an object");
    for (const name of BOOLEAN_CAPABILITIES) expect(typeof caps[name] === "boolean", `capabilities.${name} must be a boolean`);
    expect(Number.isInteger(caps.maxText) && caps.maxText > 0, "capabilities.maxText must be a positive integer");
    expect(caps.ratePerSecond === undefined || (Number.isFinite(caps.ratePerSecond) && caps.ratePerSecond > 0),
      "capabilities.ratePerSecond, when declared, must be a positive number");
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
const CONDITIONAL = {
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
  "poll-returns-updates-and-honours-abort": {
    applies: (provider) => provider.capabilities.conversation === true,
    reason: "capabilities.conversation is not declared",
    run: checkPoll,
  },
};

/** @param {any} provider */
async function checkPoll(provider) {
  expect(typeof provider.poll === "function", "capabilities.conversation is declared and poll is not a function");
  // One call, with a signal that is ALREADY aborted: a real long poll would otherwise block this check for its whole timeout, and
  // "returns promptly once told to stop" is the property the listener's shutdown depends on.
  const aborted = new AbortController();
  aborted.abort();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), POLL_DEADLINE_MS); });
  const settled = provider.poll(undefined, aborted.signal).then((/** @type {{updates?: unknown}} */ value) => ({ value }), () => ({ rejected: true }));
  const outcome = await Promise.race([settled, deadline]);
  clearTimeout(timer);
  expect(!outcome.timedOut, `poll with an already-aborted signal did not settle within ${POLL_DEADLINE_MS} ms`);
  if ("value" in outcome) expect(Array.isArray(outcome.value?.updates), "poll must resolve { updates: [...], cursor }");
}

/** @param {string} check @param {() => unknown} run @param {{check: string, message: string}[]} failures @returns {Promise<boolean>} */
async function attempt(check, run, failures) {
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
export async function runProviderConformance(provider) {
  /** @type {{check: string, message: string}[]} */
  const failures = [];
  /** @type {string[]} */
  const passed = [];
  /** @type {{check: string, reason: string}[]} */
  const skipped = [];
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
