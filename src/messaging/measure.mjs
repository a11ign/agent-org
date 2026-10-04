// @ts-check
// `messaging:measure` (a11ign/a11ign#3411, chairman point 6): HOW FAST THE ORG ACKNOWLEDGES AND ANSWERS THE CHAIRMAN, AND HOW MANY ASKS WERE SENT, ANSWERED AND WITHDRAWN,
// read from the delivery ledger for a window. READ-ONLY: it writes nothing, and it READS ONLY: no threshold, no target, no verdict on whether a number is good.
//
//   pnpm run messaging:measure -- --window=24h        (the default)
//
// **TIME TO ACKNOWLEDGE** is two lines of one update: the receipt line `inbound.mjs` writes (`direction: "in"`, no `origin`) and the `converse` line, whose `ackAt` is when the
// acknowledgement went out (`ackRef` names it). `ackAt` is read when the line has it; a line written before a11ign/a11ign#3416 has none, and its `ts` stands in for it (`ts` is
// written AFTER the queue write and any refusal message, so it overstates the time to acknowledge). **TIME TO ANSWER** is the receipt to the first `replied` line whose `replyTo` is the message's ref, which is why
// `chairman:reply --to` exists: a reply that names nothing (`replyTo: null`) answers no message here, and is not guessed at.
//
// **AN ASK IS A CYCLE, NOT A KEY.** A row asks (`first`), may be answered, and is `cleared`; it may ask again later. So an answer counts for the ask it was made under and
// never for a later one. **WITHDRAWN is a `cleared` line whose ask saw no answer before it**: the label went without the chairman. An `answer` line with `step: "failed"` is
// an answer that did not happen, so it answers nothing.
//
// **AN EVENT IS COUNTED IN THE WINDOW ITS OWN LINE FALLS IN.** An ask sent before the window and cleared inside it is a withdrawal of this window and not a send of it, so a short
// window can hold more withdrawn than sent.
//
// **NO RATES.** A window with no lines prints "no messages in the window" and nothing else: a zero rate over nothing reads as a measurement.

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { describeError, readLedgerLines } from "./ledger.mjs";
import { defaultLedgerPath } from "./state.mjs";

export const EXIT = Object.freeze({ ok: 0, refused: 2 });
const DEFAULT_WINDOW_HOURS = 24;
const MS_PER_HOUR = 3_600_000;
const MS_PER_SECOND = 1000;
const REQUEST_KEY = "request:";
const NOT_SENT = "alert not sent:";

/** @param {string} ts @returns {number} */
const at = (ts) => Date.parse(ts);

/** @param {number} fromMs @param {number} toMs @returns {number} seconds between two instants to a tenth, because an acknowledgement is usually under one and "0 s" would read as no time at all */
const secondsBetween = (fromMs, toMs) => Number(((toMs - fromMs) / MS_PER_SECOND).toFixed(1));

/**
 * @param {Record<string, any>[]} lines every ledger line, in file order (the order they were written)
 * @returns {{messageRef: string, receivedAt: number, acknowledgedAfter: number | null, answeredAfter: number | null}[]} one entry per message `converse` took, whatever the window
 */
function conversations(lines) {
  const receipts = new Map(lines.filter((line) => line.direction === "in" && line.origin === undefined && line.kind === "message").map((line) => [line.updateId, line]));
  return lines.filter((line) => line.direction === "in" && line.origin === "converse" && typeof line.messageRef === "string").map((converse) => {
    const receivedAt = at((receipts.get(converse.updateId) ?? converse).ts);
    const reply = lines.find((line) => line.direction === "reply" && line.status === "replied" && line.replyTo === converse.messageRef && at(line.ts) >= receivedAt);
    return {
      messageRef: converse.messageRef,
      receivedAt,
      // A converse line with no `ackRef` did not tell the chairman anything, so there was no acknowledgement to time.
      acknowledgedAfter: converse.ackRef === null || converse.ackRef === undefined ? null : secondsBetween(receivedAt, at(converse.ackAt ?? converse.ts)),
      answeredAfter: reply === undefined ? null : secondsBetween(receivedAt, at(reply.ts)),
    };
  });
}

/**
 * @param {Record<string, any>[]} lines @returns {{sent: number[], answered: number[], withdrawn: number[]}} the instants of each event, over every ask cycle in the ledger
 */
function askCycles(lines) {
  const events = { sent: /** @type {number[]} */ ([]), answered: /** @type {number[]} */ ([]), withdrawn: /** @type {number[]} */ ([]) };
  /** @type {Map<string, boolean>} request key -> whether its open ask has been answered */
  const open = new Map();
  for (const line of lines) {
    const key = line.key ?? line.request;
    if (typeof key !== "string" || !key.startsWith(REQUEST_KEY)) continue;
    if (line.direction === "answer" && line.step !== "failed" && open.get(key) === false) {
      open.set(key, true);
      events.answered.push(at(line.ts));
    } else if (line.status === "sent" && line.kind === "first") {
      open.set(key, false);
      events.sent.push(at(line.ts));
    } else if (line.status === "sent" && line.kind === "cleared") {
      if (open.get(key) === false) events.withdrawn.push(at(line.ts));
      open.delete(key);
    }
  }
  return events;
}

/** @param {Record<string, any>[]} lines @returns {Record<string, any>[]} the asks the brief rule refused to send, a line each */
const refusedAsks = (lines) => lines.filter((line) => line.status === "invalid" && typeof line.key === "string" && line.key.startsWith(REQUEST_KEY) && String(line.error).startsWith(NOT_SENT));

/**
 * @param {Record<string, any>[]} lines the whole ledger @param {{since: number, until: number}} window
 * @returns {{empty: true} | {empty: false, messages: ReturnType<typeof conversations>, asks: {sent: number, answered: number, withdrawn: number, refused: Record<string, number>}}}
 */
export function measure(lines, { since, until }) {
  const inWindow = (/** @type {number} */ instant) => instant >= since && instant <= until;
  if (!lines.some((line) => inWindow(at(line.ts)))) return { empty: true };
  const cycles = askCycles(lines);
  /** @type {Record<string, number>} */
  const refused = {};
  for (const line of refusedAsks(lines).filter((candidate) => inWindow(at(candidate.ts)))) refused[line.error] = (refused[line.error] ?? 0) + 1;
  return {
    empty: false,
    messages: conversations(lines).filter((message) => inWindow(message.receivedAt)),
    asks: { sent: cycles.sent.filter(inWindow).length, answered: cycles.answered.filter(inWindow).length, withdrawn: cycles.withdrawn.filter(inWindow).length, refused },
  };
}

/** @param {number | null} seconds @param {string} verb @param {string} none @returns {string} */
const after = (seconds, verb, none) => (seconds === null ? none : `${verb} after ${seconds} s`);

/** @param {ReturnType<typeof measure>} report @param {{since: number, until: number}} window @returns {string[]} */
export function formatReport(report, { since, until }) {
  if (report.empty) return ["no messages in the window"];
  const { messages, asks } = report;
  const refusedTotal = Object.values(asks.refused).reduce((sum, count) => sum + count, 0);
  return [
    `window ${new Date(since).toISOString()} .. ${new Date(until).toISOString()}`,
    `messages from the chairman: ${messages.length}`,
    ...messages.map(({ messageRef, receivedAt, acknowledgedAfter, answeredAfter }) =>
      `  message ${messageRef} received ${new Date(receivedAt).toISOString()}: ${after(acknowledgedAfter, "acknowledged", "not acknowledged")}; ${after(answeredAfter, "answered", "unanswered")}`),
    `asks sent: ${asks.sent}`,
    `asks answered by the chairman: ${asks.answered}`,
    `asks withdrawn (cleared with no answer before it): ${asks.withdrawn}`,
    `asks refused by the brief rule: ${refusedTotal}`,
    ...Object.entries(asks.refused).map(([reason, count]) => `  ${count} x ${reason}`),
  ];
}

/** @param {string | undefined} text @returns {number | null} hours, or null for anything but a whole number and `h` */
function parseWindowHours(text) {
  if (text === undefined) return DEFAULT_WINDOW_HOURS;
  const match = /^(\d+)h$/.exec(text);
  return match === null || Number(match[1]) === 0 ? null : Number(match[1]);
}

/**
 * @param {string[]} argv the arguments after the script: `--window=<n>h`
 * @param {{home?: string, now?: () => number, out?: (line: string) => void, err?: (line: string) => void}} [deps]
 * @returns {number} the exit code: 0 a reading was printed (an empty window is one), 2 for an argument it cannot read
 */
export function main(argv, { home = homedir(), now = Date.now, out = console.log, err = console.error } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { window: { type: "string" } } });
    const hours = parseWindowHours(values.window);
    if (hours === null) {
      err(`messaging:measure: --window is a whole number of hours and an "h", such as --window=24h, not "${values.window}"`);
      return EXIT.refused;
    }
    const until = now();
    const window = { since: until - hours * MS_PER_HOUR, until };
    for (const line of formatReport(measure(readLedgerLines(defaultLedgerPath(home)), window), window)) out(line);
    return EXIT.ok;
  } catch (error) {
    err(`messaging:measure: ${describeError(error)}`);
    return EXIT.refused;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
