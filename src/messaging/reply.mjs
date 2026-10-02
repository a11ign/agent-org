// @ts-check
// CONVERSATION OUT: REPLIES ARE CHECKED FACTS (a11ign/a11ign#2910, row 11 of 13; design #2899 decision 2(e)). `createReply({...}).send(text)` is the
// only function that turns an agent's words into a message to the chairman, and it sends nothing it has not checked. The third of the design's three
// layers against what the chairman's chat could be made to carry (the classifier on the way in, `ceo`'s brief, and this).
//
// **A CLAIM ABOUT THE ORGANISATION CAN ONLY ARRIVE AS A PLACEHOLDER** (`placeholders.mjs`), and a placeholder is RE-READ from its source at send time, so
// the chairman reads a fact as of a minute, stamped on the message (`as of 14:05Z`), and never an agent's memory of it. Everything outside a
// placeholder is judged as free text, and is REFUSED when it carries a claim in a form a placeholder exists for:
//   * a `#<number>`: a row or pull request is cited by `#{{pr:N.number}}`, which is also a read that it exists;
//   * a state word (merged, closed, green, red, passing, passed, failed, failing, done, approved): its state is `{{pr:N.state}}` or `{{run:ID.conclusion}}`;
//   * a count: a digit run, or a number word from two up (`{{ready.count}}`, `{{last-merge.age}}`).
// **OPINION GOES UNDER A LINE THAT SAYS SO.** From a line starting `My read:` to the end, the free-text check does not apply, and the chairman sees the
// label in the message. It is the one door left open on purpose, and a reader is told which side of it a sentence is on. Placeholders under it still
// resolve and still refuse on a failed read.
//
// **A READ THAT FAILS REFUSES THE SEND**, naming every placeholder that failed and why; the refusal carries `sendable`, the "I could not check X" form
// built from `{{unchecked:...}}`, which passes this same checker, so the chairman can always be told what could not be checked.
//
// **THE LEDGER LINE HOLDS THE VALUES IT WAS RENDERED WITH** (`values`: each placeholder as written -> what it said), the time of the reads and the final
// text, so "what did ceo tell me, and was it true then" is answerable from the log. Its `direction` is `reply` and its status `replied`, neither of which
// the core's hourly cap or its reminders count: a conversation the chairman started must not push a notification into the digest.
//
// WHAT THIS DOES NOT PROVE: the heuristics are a heuristic, as the classifier is. A claim written as "the second row" or "all of them" carries no digit and
// no state word; the free-text check is a net under the placeholders, and `ceo`'s brief (row 12) states the rule they are the net for. The module is a
// LEAF over its injected `send`, `ledger`, `readers` and `now`: nothing here reaches the network or the clock but through them.

import { describeError } from "./ledger.mjs";
import { MASK, parsePlaceholders, readPlaceholders, renderSegments } from "./placeholders.mjs";

const DEFAULT_MAX_TEXT = 4096;
const OPINION_MARKER = /^My read:/m;
const STAMP_FROM = 11;
const STAMP_TO = 16;
const STATE_WORDS = /\b(?:merged|closed|green|red|passing|passed|failed|failing|done|approved)\b/gi;
/** "one" is left out: it is half of English ("no one", "this one"), and a refusal that fires on it teaches the writer to hide under `My read:`. */
const NUMBER_WORDS = /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozen|hundred|thousand)\b/gi;

/**
 * Checked IN THIS ORDER: a number reference is masked before the digit rule runs, so `#2881` is one problem and not two. A digit run preceded by a letter
 * is part of a name (`a11ign`, `W3C`) and is not a count.
 * @type {{pattern: RegExp, reason: (match: string) => string}[]}
 */
const FREE_TEXT_RULES = [
  { pattern: /#\d+/g, reason: (match) => `"${match}" is a row or pull request number outside a placeholder (write #{{pr:N.number}} or #{{issue:N.number}})` },
  { pattern: /(?<![A-Za-z\d])\d+/g, reason: (match) => `"${match}" is a number outside a placeholder (a count is {{ready.count}}, an age is {{last-merge.age}}); under \`My read:\` it is an opinion` },
  { pattern: NUMBER_WORDS, reason: (match) => `"${match}" is a count in words outside a placeholder` },
  { pattern: STATE_WORDS, reason: (match) => `"${match}" is a state word outside a placeholder (a state is {{pr:N.state}}, {{issue:N.state}}, {{run:ID.conclusion}} or {{unit:NAME.state}})` },
];

/** @typedef {{placeholder: string | null, reason: string}} Problem  `placeholder` is the one as written; null for a problem in the free text */

/** @param {string} masked the free text, each placeholder already replaced by `MASK` @returns {Problem[]} each claim-shaped word, once */
function freeTextProblems(masked) {
  /** @type {Problem[]} */
  const problems = [];
  let rest = masked;
  for (const { pattern, reason } of FREE_TEXT_RULES) {
    rest = rest.replace(pattern, (match) => {
      const problem = { placeholder: null, reason: reason(match) };
      if (!problems.some((seen) => seen.reason === problem.reason)) problems.push(problem);
      return MASK;
    });
  }
  return problems;
}

/** @param {string} text @returns {{facts: string, opinion: string}} the text before the first `My read:` line, and from it to the end */
function splitOpinion(text) {
  const at = text.search(OPINION_MARKER);
  return at === -1 ? { facts: text, opinion: "" } : { facts: text.slice(0, at), opinion: text.slice(at) };
}

/** @param {number} at @returns {string} "14:05Z" */
function clockOf(at) {
  return `${new Date(at).toISOString().slice(STAMP_FROM, STAMP_TO)}Z`;
}

/**
 * The refusal for a failed read, in words the chairman can be sent: it names what could not be checked and states nothing about it.
 * @param {string[]} placeholders as written, `{{pr:2881.state}}` @returns {string}
 */
function couldNotCheck(placeholders) {
  return `Could not check, so not stated: ${placeholders.map((raw) => `{{unchecked:${raw.slice(2, -2)}}}`).join(", ")}.`;
}

/**
 * @typedef {{outcome: "refused", problems: Problem[], sendable?: string}
 *   | {outcome: "ready", text: string, values: Record<string, string>, at: number}} Prepared
 */

/**
 * Checks `text` and reads its placeholders; sends nothing. A refusal is a value, never a throw: it is an ordinary result of an agent writing a reply.
 *
 * @param {string} text
 * @param {{readers: import("./placeholders.mjs").Readers, now: () => number, maxText?: number}} deps
 * @returns {Promise<Prepared>}
 */
export async function prepareReply(text, { readers, now, maxText = DEFAULT_MAX_TEXT }) {
  if (typeof text !== "string" || text.trim() === "") return { outcome: "refused", problems: [{ placeholder: null, reason: "the reply is empty" }] };
  const { facts, opinion } = splitOpinion(text);
  const [spoken, opined] = [parsePlaceholders(facts), parsePlaceholders(opinion)];
  const problems = [...spoken.problems, ...opined.problems, ...freeTextProblems(spoken.masked)];
  if (problems.length > 0) return { outcome: "refused", problems };

  const { values, failures, at } = await readPlaceholders([...spoken.placeholders, ...opined.placeholders], { readers, now });
  if (failures.length > 0) return { outcome: "refused", problems: failures, sendable: couldNotCheck(failures.map((failure) => failure.placeholder)) };

  const body = `${renderSegments(spoken.segments, values)}${renderSegments(opined.segments, values)}`.trimEnd();
  const stamped = `${body}\n\nas of ${clockOf(at)}`;
  if (stamped.length > maxText) {
    return { outcome: "refused", problems: [{ placeholder: null, reason: `the reply is ${stamped.length} characters once the facts are in, over the ${maxText} the provider carries` }] };
  }
  return { outcome: "ready", text: stamped, values: Object.fromEntries(values), at };
}

/**
 * @param {{send: (message: {text: string, replyTo?: string}) => Promise<{messageRef: string}>,
 *   ledger: {append: (entry: Record<string, unknown>) => Record<string, any>},
 *   readers: import("./placeholders.mjs").Readers, now?: () => number, maxText?: number}} options
 *   `send` is the provider's, the ONE way out; `readers` re-read every fact (`createGhReaders` is the real set).
 */
export function createReply({ send, ledger, readers, now = Date.now, maxText = DEFAULT_MAX_TEXT }) {
  return {
    /**
     * @param {string} text @param {{replyTo?: string}} [options] `replyTo` is the chairman's message this answers
     * @returns {Promise<{outcome: "sent", messageRef: string, text: string, values: Record<string, string>}
     *   | {outcome: "refused", problems: Problem[], sendable?: string} | {outcome: "failed", error: string}>}
     */
    async send(text, { replyTo } = {}) {
      const prepared = await prepareReply(text, { readers, now, maxText });
      if (prepared.outcome === "refused") return prepared;
      const line = { direction: "reply", replyTo: replyTo ?? null, asOf: new Date(prepared.at).toISOString(), values: prepared.values, text: prepared.text };
      /** @type {{messageRef: string} | {error: string}} */
      let delivery;
      try {
        const { messageRef } = await send({ text: prepared.text, replyTo });
        if (typeof messageRef !== "string" || messageRef === "") throw new Error("provider returned no messageRef");
        delivery = { messageRef };
      } catch (error) {
        delivery = { error: describeError(error) };
      }
      // Outside the try on purpose: a ledger that cannot be written throws to the caller, and must not be recorded as a send that failed.
      if ("error" in delivery) {
        ledger.append({ ...line, status: "failed", providerMessageId: null, error: delivery.error });
        return { outcome: "failed", error: delivery.error };
      }
      ledger.append({ ...line, status: "replied", providerMessageId: delivery.messageRef, error: null });
      return { outcome: "sent", messageRef: delivery.messageRef, text: prepared.text, values: prepared.values };
    },
  };
}
