// @ts-check
// module: `GET /api/outcomes` (A11-430) -- the outcome rollups of a time window, read from the outcome log and priced at the prices the host file names now
//
// READ FRESH ON EACH REQUEST: the outcome log, so a run that just ended is in it, and the host file's `tickets.prices`, so a price changed there is in force at the next read without a restart.
// THE WINDOW is `?from=` and `?to=`, each an ISO date or time or a number of ms; `to` defaults to now and `from` to seven days before `to`.
// AN UNREADABLE LOG OR PRICE TABLE IS AN ERROR, NOT EMPTY (A11-358): the answer is a 500 that names it, never a rollup of nothing.

import { readFileSync } from "node:fs";
import { latestOutcomes, outcomesPath, readOutcomes } from "./outcome-record.ts";
import { PRICED_AT, PRICES_KEY, pricesOf } from "./prices-config.ts";
import { ticketsBlock } from "../settings.ts";
import { type OutcomeWindow, rollupOf } from "./rollup.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** What the route reads: the board's state folder, the host file and the clock. */
export type OutcomesReads = Readonly<{ stateDir: string; hostPath: string; now: number }>;

/** One end of the window from the query, or `fallback` when it is absent. THROWS naming the parameter when it is not a time. PURE. */
function timeOf(query: URLSearchParams, name: string, fallback: number): number {
  const text = query.get(name);
  if (text === null || text === "") return fallback;
  const at = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (Number.isNaN(at)) throw new RangeError(`${name} must be an ISO date or time, or a number of ms, not ${JSON.stringify(text)}`);
  return at;
}

/** The window the query names. THROWS when an end is not a time, or `from` is not before `to`. PURE. */
export function windowOf(query: URLSearchParams, now: number): OutcomeWindow {
  const to = timeOf(query, "to", now);
  const from = timeOf(query, "from", to - WEEK_MS);
  if (from >= to) throw new RangeError(`from (${new Date(from).toISOString()}) must be before to (${new Date(to).toISOString()})`);
  return { from, to };
}

/** The prices the host file at `hostPath` names now. THROWS naming the file or the field when it cannot be read. */
function pricesNow(hostPath: string): ReturnType<typeof pricesOf> {
  let host: unknown;
  try {
    host = JSON.parse(readFileSync(hostPath, "utf8"));
  } catch (err) {
    throw new Error(`the host file ${hostPath}, which ${PRICES_KEY} is read from, could not be read (${(err as Error).message})`);
  }
  return pricesOf(ticketsBlock(host).prices);
}

/** The answer to `GET /api/outcomes`: 200 with the rollups, 400 naming a query that is not a window, or 500 naming the log or the host file that could not be read. */
export function outcomesAnswer({ stateDir, hostPath, now }: OutcomesReads, query: URLSearchParams): [number, unknown] {
  let window: OutcomeWindow;
  try {
    window = windowOf(query, now);
  } catch (err) {
    return [400, { error: (err as Error).message }];
  }
  try {
    return [200, rollupOf(latestOutcomes(readOutcomes(outcomesPath(stateDir))), window, pricesNow(hostPath), PRICED_AT)];
  } catch (err) {
    return [500, { error: (err as Error).message }];
  }
}
