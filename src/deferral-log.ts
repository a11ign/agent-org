// @ts-check
// a11ign/a11ign#3510 (slice 3 of #3494): THE GATE'S ENDED DEFERRALS, KEPT. `wake-deferred` holds only what is deferred NOW (`<causeKey>\t<first deferred, ms>`): a key that was delivered is
// removed, and its start with it, so nothing could say what a WAIT was after the fact. This leaf turns the tick's two readings of that file (before and after) and the ledger's
// deliveries into the lines of ONE append-only log beside it, one per deferral that ENDED:
//
//     <causeKey>\t<startMs>\t<endMs>\t<delivered|gone>
//
// `delivered` means the ledger holds that key at or after the start; `gone` means the key left `wake-deferred` with no delivery (the order stopped being true). `endMs` is the tick that
// NOTICED the end, which is at most one tick late: the gate has no clock between ticks. A SPAN IS WRITTEN ONCE, BY THE TICK THAT ENDS IT: a key still deferred yields nothing, and the
// next tick finds the key in neither reading, so running a tick twice appends nothing twice. Spans that ended before the first tick to run this are not here and cannot be.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The log's file name, beside `wake-deferred`. */
export const DEFERRAL_LOG_FILE = "wake-deferral-log";

/** @typedef {{ key: string, startMs: number, endMs: number, how: "delivered" | "gone" }} EndedDeferral */

/**
 * The deferrals that ended between two readings of `wake-deferred`. PURE. `deliveries` is a thunk because the ledger is read only when something ended, which the quiet tick's common case never does.
 * @param {{ previous: Map<string, number>, current: Map<string, number>, deliveries: () => { at: number, key: string }[], now: number }} readings `previous` and `current` are each key's first-deferred ms
 * @returns {EndedDeferral[]}
 */
export function endedDeferrals({ previous, current, deliveries, now }: { previous: Map<string, number>; current: Map<string, number>; deliveries: () => { at: number; key: string; }[]; now: number; }): EndedDeferral[] {
  const ended = [...previous].filter(([key]) => !current.has(key));
  if (ended.length === 0) return [];
  const delivered = deliveries();
  return ended.map(([key, startMs]) => ({ key, startMs, endMs: now, how: delivered.some((delivery) => delivery.key === key && delivery.at >= startMs) ? /** @type {const} */ ("delivered") : /** @type {const} */ ("gone") }));
}

/** @param {EndedDeferral[]} ended @returns {string} */
export const deferralLogText = (ended: EndedDeferral[]): string => ended.map(({ key, startMs, endMs, how }) => `${key}\t${startMs}\t${endMs}\t${how}\n`).join("");

/**
 * Append the spans that ended this tick. Called BEFORE `wake-deferred` is rewritten: a run killed between the two leaves the old file, so the next tick finds the same ending and appends it again (the store keys a span by
 * its key and start, so a repeated line is one event), where the other order would lose the span for good.
 * @param {{ logPath: string, previous: Map<string, number>, current: Map<string, number>, deliveries: () => { at: number, key: string }[], now: number, append?: typeof appendFileSync }} tick
 * @returns {EndedDeferral[]}
 */
export function recordEndedDeferrals({ logPath, previous, current, deliveries, now, append = appendFileSync }: { logPath: string; previous: Map<string, number>; current: Map<string, number>; deliveries: () => { at: number; key: string; }[]; now: number; append?: typeof appendFileSync; }): EndedDeferral[] {
  const ended = endedDeferrals({ previous, current, deliveries, now });
  if (ended.length === 0) return ended;
  mkdirSync(dirname(logPath), { recursive: true });
  append(logPath, deferralLogText(ended));
  return ended;
}

/**
 * The log's lines. A line that does not parse THROWS, as `readDeferralHistory` does: a span read wrong is a wait drawn wrong, and a skipped line would be a wait that never happened.
 * @param {string} text @param {string} [source] the file, for the message
 * @returns {EndedDeferral[]}
 */
export function parseDeferralLog(text: string, source: string = DEFERRAL_LOG_FILE): EndedDeferral[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [key, start, end, how, ...extra] = line.split("\t");
    if (!key || !/^\d+$/.test(start ?? "") || !/^\d+$/.test(end ?? "") || (how !== "delivered" && how !== "gone") || extra.length > 0 || Number(end) < Number(start)) {
      throw new Error(`${source} has a line that is not "<causeKey>\\t<startMs>\\t<endMs>\\t<delivered|gone>": ${line.slice(0, 120)}`);
    }
    return { key, startMs: Number(start), endMs: Number(end), how };
  });
}
