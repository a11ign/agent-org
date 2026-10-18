// module: the route-outcome pass -- what a closed, routed row came of, written to the decision log on the HOST (a11ign/agent-org#752)
//
// WHY THIS IS THE GATE'S AND NOT THE CLOSE SCRIPT'S (agent-org#687, a11ign#4756): `close-rows-for-merged-pr.ts` runs on a GitHub runner whose filesystem has no decision log, and the push
// path's own close loop never called `recordClosedRow`. Measured on the host 2026-10-10: 417 outcome lines, 0 `merged-first-pass|not-first-pass`. The gate runs on the host that
// owns the log, so the pass is asked once per tick from there; `route-outcome.ts` owns the vocabulary and the once-per-row rule, and this file only finds the rows and their facts.
//
// A ROW IS OWED AN OUTCOME when the log routed it and holds no outcome of the vocabulary for it. That is read from the log each tick, so the pass keeps no cursor of its own: a row that has
// not closed stays owed and costs one entry in a list, and a second tick finds nothing owed and asks GitHub nothing at all (the empty case is the common one).
//
// THE PULL REQUEST'S FACTS ARE THE TRACE STORE'S, NOT A `gh pr view` PER ROW (the row's Change 1 named `gh pr view --json reviews,mergedAt`; this departs from it, and says why). A new file
// outside `src/ticket-port/` may not gain a `gh` call (`gh-call-ratchet.test.ts`, agent-org#826: "go through the ticket port or the code-host port, and do not raise the baseline"), and
// the code-host port has no adapter yet. The store already holds each pull request's `reviewed` and `merged` events, and `pullOutcome` (`haiku-tier-report.ts`) is the ONE definition of
// first pass the stop rule and `route-guard.ts` read: the facts of a row here are the facts those two read. It also spends no GraphQL, which `gh pr view` does (`rules/gh-api-budget.md`).
//
// A STORE THAT LAGS IS NOT A PULL REQUEST THAT DID NOT MERGE. The store's GitHub events are ingested on a timer, minutes behind the merge that closed the row, so "no `merged` event"
// cannot be read as "not merged" on the tick the row closes: that would write `closed-without-merge` once, for ever, for a row that merged. A closing pull request is decided only by its
// own events: a `merged` event is a merge, a `closed` event with no `merged` is a close without one, and neither is HELD (the row stays owed, nothing is written, nothing is said: a pull
// request still open is not a fault). A row with no closing pull request at all is `closed-without-merge`, the report's own reading of `pr: null`.
//
// A READ THAT FAILS WRITES NOTHING AND SAYS SO, and the row stays owed, so the next tick asks again. A guess is never written: the log is tuned from, and a wrong line is worse than none.
// A closed-rows read that was refused, a closing pull request whose repository could not be read (`unresolved`) and a trace store that could not be read are each such a read.
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { decisionLogPathFrom, decisionSwitchesPath, readSwitches } from "../decision-provider.ts";
import { ESCALATION_USE } from "../engineer-escalation.ts";
import { windowReadings } from "../engineer-route.ts";
import { stateEntryPath } from "../host-config.ts";
import { outsideTrunkOnHost } from "../outside-trunk.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { recordClosedRow, ROUTE_OUTCOMES, type ClosedRowDeps, type RouteOutcome } from "../route-outcome.ts";
import { printDiagnostic, processState } from "../triage-provider.ts";
import { type ClosedRow, measuresOf, pullOutcome, readClosedRows } from "../trace/haiku-tier-report.ts";
import { defaultStore } from "../trace/otel-receiver.ts";
import type { TraceEvent } from "../trace/store.ts";

/** How many closed rows one tick writes for. The first run on a host meets every routed row since the log began; the rest are owed still and go on the next tick. */
export const ROWS_PER_TICK = 25;

/** How long after a row closed the store is read for it. The store's GitHub events are minutes behind a merge, so a row is undecided for a few ticks; a row still undecided after this (a pull request left open when the row was closed by hand) stops asking for the store, though it is decided with any read a newer row asks for. */
export const GRACE_MS = 3 * 60 * 60 * 1000;

/** How far back a routing is still looked for a closing. A row routed longer ago and not closed (or closed with a pull request the store never resolved) is left, so the closed-rows read has a floor. */
export const HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

const USE = "model-routing";
const ROUTE_LINE = /^route /;
const ROW_ID = /^row-(\d+)$/;
type Switches = ReturnType<typeof readSwitches>;

/** What the pass is handed. Each read is injected, so a test needs no network and no store. */
export type RouteOutcomePassInput = {
  /** The gate's own condition for the closed-row pass: herdr's listing is complete. `false` is not asked, and says nothing (the claim-label pass has said it). */
  listed: boolean;
  /** The decision log's path and the clock, as `recordClosedRow` takes them; `switches` is resolved by the caller, once, so a host with the use off asks GitHub nothing. */
  record: ClosedRowDeps & { switches: Switches };
  /** The rows closed in `[from, to]`, each with its closing pull request. Throws when the read was refused. */
  closedRows: (from: number, to: number) => ClosedRow[];
  /** The trace store's events about these pull requests (their `gh:<repo>#<n>:` id prefixes) and every compaction, asked only when a row closed within {@link GRACE_MS} is owed an outcome; `null` when it could not be read. */
  events: (prefixes: readonly string[]) => TraceEvent[] | null;
};

export type RouteOutcomePassResult = { written: { row: number; outcome: RouteOutcome }[]; owed: number };

/** The log's lines as values; a line that is not JSON (a half-written tail) is skipped, as `route-outcome.ts` skips it. `null` when the log could not be read. */
function logLines(logPath: string, say: (line: string) => void): unknown[] | null {
  try {
    return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "").flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") say("agent-org: route-outcome pass: the decision log could not be read, so no outcome was written");
    return null;
  }
}

type PullReading = { state: "merged"; rejections: number } | { state: "closed" } | { state: "undecided" };

/** What the store says of a closing pull request: a merge with its rejections, a close with no merge, or nothing it can be decided from (not reached yet, or still open). */
function pullReading(events: readonly TraceEvent[], pr: { repo: string; number: number }): PullReading {
  const prefix = `gh:${pr.repo}#${pr.number}:`;
  const own = events.filter((event) => event.source === "github" && event.id.startsWith(prefix));
  const { merged, rejections } = pullOutcome(own, pr);
  if (merged) return { state: "merged", rejections };
  return own.some((event) => event.kind === "closed") ? { state: "closed" } : { state: "undecided" };
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/**
 * ONE PASS: write the outcome of every routed row that has closed and has none yet. Returns what it wrote. Never throws.
 *
 * `escalated` is the log's own `model-escalation` line for the row (`wake.ts` writes it when it restarts a Haiku start on Sonnet); the merge and the rejections are the store's, and
 * so are the compactions (`measuresOf`, the figure the window report reads).
 */
export function routeOutcomePass({ listed, record, closedRows, events }: RouteOutcomePassInput): RouteOutcomePassResult {
  const nothing: RouteOutcomePassResult = { written: [], owed: 0 };
  const say = record.diagnostic ?? printDiagnostic;
  if (!listed || record.logPath === undefined || record.switches[USE] !== true) return nothing;
  const lines = logLines(record.logPath, say);
  if (lines === null) return nothing;
  const now = (record.now ?? Date.now)();
  const outstanding = new Set(windowReadings(lines).filter((reading) => !(ROUTE_OUTCOMES as readonly unknown[]).includes(reading.outcome)).map((reading) => reading.row));
  const routedAt = new Map<number, number>();
  for (const line of lines) {
    const entry = line as { use?: unknown; id?: unknown; outcome?: unknown; at?: unknown } | null;
    const row = typeof entry?.id === "string" ? Number(ROW_ID.exec(entry.id)?.[1]) : Number.NaN;
    if (entry?.use !== USE || !outstanding.has(row) || typeof entry.outcome !== "string" || !ROUTE_LINE.test(entry.outcome) || typeof entry.at !== "number") continue;
    routedAt.set(row, Math.min(entry.at, routedAt.get(row) ?? entry.at));
  }
  const owed = new Set([...routedAt].filter(([, at]) => at >= now - HORIZON_MS).map(([row]) => row));
  if (owed.size === 0) return nothing;
  let closed: ClosedRow[];
  try {
    closed = closedRows(Math.min(...[...owed].map((row) => routedAt.get(row) as number)), now);
  } catch (err) {
    say(`agent-org: route-outcome pass: the closed rows could not be read (${firstLine(err)}), so no outcome was written this tick`);
    return { written: [], owed: owed.size };
  }
  const due = closed.filter((row) => owed.has(row.number)).sort((a, b) => a.number - b.number);
  if (!due.some((row) => row.closedAt >= now - GRACE_MS)) return { written: [], owed: owed.size };
  const store = events(due.flatMap((row) => (row.pr === null ? [] : [`gh:${row.pr.repo}#${row.pr.number}:`])));
  if (store === null) {
    say(`agent-org: route-outcome pass: the trace store could not be read, so the ${due.length} closed row(s) owed an outcome got none this tick`);
    return { written: [], owed: owed.size };
  }
  const escalated = new Set(lines.flatMap((line) => {
    const entry = line as { use?: unknown; id?: unknown } | null;
    return entry?.use === ESCALATION_USE && typeof entry.id === "string" ? [entry.id] : [];
  }));
  const written: RouteOutcomePassResult["written"] = [];
  for (const row of due) {
    if (written.length >= ROWS_PER_TICK) break;
    if (row.unresolved === true) {
      say(`agent-org: route-outcome pass: row ${row.number} has no outcome written this tick: its closing pull request names no repository the pass can read`);
      continue;
    }
    const reading: PullReading = row.pr === null ? { state: "closed" } : pullReading(store, row.pr);
    if (reading.state === "undecided") continue;
    const facts = { mergedPr: reading.state === "merged", rejectedReviews: reading.state === "merged" ? reading.rejections : 0, escalated: escalated.has(`row-${row.number}`),
      compactions: measuresOf({ number: row.number, haiku: false, closedAt: 0, pr: null }, store).compactions };
    const outcome = recordClosedRow(row.number, facts, record);
    if (outcome !== null) written.push({ row: row.number, outcome });
  }
  return { written, owed: owed.size };
}

const COMPACTION = Buffer.from('"kind":"compaction"');
const CHUNK = 8 * 1024 * 1024;
const NEWLINE = 10;

/**
 * THE STORE'S EVENTS FOR THESE PULL REQUESTS AND EVERY COMPACTION, without holding the store. The store is 1.1 million events and 460 MB (measured 2026-10-11: `readStore` 6 s, 715 MB resident),
 * which is too much for a gate tick that runs every two minutes, so a line is parsed only when it names one of `prefixes` or is a compaction (a line is JSON written compact, so the
 * substring is the field). The rules are `readStore`'s: the LAST copy of an id is the event, and a relevant line that does not parse THROWS (a damaged store is reported, never read around).
 * An absent store is no events.
 * @param chunkBytes a parameter so a test can make a line span chunks
 */
export function readStoreFor(path: string, prefixes: readonly string[], chunkBytes: number = CHUNK): TraceEvent[] {
  if (!existsSync(path)) return [];
  const needles = [COMPACTION, ...prefixes.map((prefix) => Buffer.from(`"id":"${prefix}`))];
  const last = new Map<string, TraceEvent>();
  const take = (line: Buffer): void => {
    if (line.length === 0 || !needles.some((needle) => line.includes(needle))) return;
    const event = JSON.parse(line.toString("utf8")) as TraceEvent;
    last.delete(event.id);
    last.set(event.id, event);
  };
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer = Buffer.alloc(0);
    for (let read = readSync(fd, chunk, 0, chunkBytes, null); read > 0; read = readSync(fd, chunk, 0, chunkBytes, null)) {
      let rest: Buffer = carry.length === 0 ? chunk.subarray(0, read) : Buffer.concat([carry, chunk.subarray(0, read)]);
      for (let end = rest.indexOf(NEWLINE); end >= 0; end = rest.indexOf(NEWLINE)) {
        take(rest.subarray(0, end));
        rest = rest.subarray(end + 1);
      }
      carry = Buffer.from(rest);
    }
    take(carry);
  } finally {
    closeSync(fd);
  }
  return [...last.values()];
}

/**
 * THE LIVE PASS, for the gate's tick: the host's own log and switches, the closed rows through the report's own reader, and the trace store read at most once and only when a row closed lately
 * is owed an outcome. It is the ONE call the gate makes (beside `stripClosedClaims`, #3883), behind that pass's own complete-listing condition. Never throws: a tick that failed here
 * would hold every other order.
 * @param gh `gh` as the gate holds it, for the closed rows' one list
 * @param readSwitchesOf the host's switches, and @param outside the outside trunk's call: the live ones by default, and a test's own so that the call is read from what it does
 */
export function recordRouteOutcomesOnHost({ listed, gh, readSwitchesOf = () => readSwitches(decisionSwitchesPath(HOME_CHECKOUT), { diagnostic: printDiagnostic, state: processState, read: readFileSync }), outside = outsideTrunkOnHost }: { listed: boolean; gh: (args: string[]) => string; readSwitchesOf?: () => Readonly<Record<string, boolean | undefined>>; outside?: typeof outsideTrunkOnHost }): RouteOutcomePassResult {
  try {
    const say = printDiagnostic;
    const switches = readSwitchesOf();
    outside(switches); // agent-org#1576: the project's trunk jobs from this side, behind `outside.trunk` (off: nothing runs). The switches are the ones read above, so off costs no read.
    return routeOutcomePass({ listed, closedRows: (from, to) => readClosedRows(from, to, gh),
      events: (prefixes) => {
        try {
          return readStoreFor(defaultStore(), prefixes);
        } catch {
          return null;
        }
      },
      record: { logPath: decisionLogPathFrom(stateEntryPath("wake-ledger")), switches, diagnostic: say } });
  } catch (err) {
    printDiagnostic(`agent-org: route-outcome pass: not run (${firstLine(err)})`);
    return { written: [], owed: 0 };
  }
}
