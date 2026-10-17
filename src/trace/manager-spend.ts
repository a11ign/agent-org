// a11ign/a11ign#4505 (manager redesign, Move 0/4 measure), agent-org#903: a day's manager spend, wakes and wakes served by a run, READ FROM THE TRACE.
// The raw ndjson is NOT summable (superseded copies of an id), so this reads through `readStore` and de-duplicates again by id for a caller that hands it events some other way.
// no-token: gh -- a pure function over the store's events; nothing here calls `gh` or a model.
import { CLIENT_CACHE_READ_RATE, costBy, readStore } from "./store.ts";
import type { TraceEvent } from "./store.ts";
import { defaultStore } from "./otel-receiver.ts";
import { MANAGERS } from "./triage-sample.ts";

/** The target a day's manager spend is steered to, in dollars (the chairman on a11ign/a11ign#4505). */
export const TARGET_BAND = { low: 60, high: 80 };
/** What the managers cost a day before the redesign, in dollars (the same issue). */
export const BASELINE_USD = 109;

const DAY_MS = 24 * 60 * 60 * 1000;
const USD_DECIMALS = 2;
const MANAGER_SPEND_WORD = "manager-spend";

/** A wake event as the cutover-seam row will write it: `servedBy` is ABSENT on one stored before it, and absent says nothing, so it is neither `seat` nor `run`. */
type Wake = TraceEvent & { servedBy?: "run" | "seat" | null };

export type SpendRow = {
  session: string;
  turns: number; unpriced: number; usd: number; usdAtClientRate: number;
  wakes: number; wrote: number; noOp: number; escalated: number;
  /** a wake whose outcome is `null` or ABSENT: not told, which is not `no-op` */
  outcomeUnknown: number;
  servedByRun: number;
  /** wakes with no `servedBy` at all: not counted as `run`, and not as seat either */
  lackingServedBy: number;
};

/** One wake cause of the day: its wakes, the ones a run served, and its share of the day's wakes. A null `cause` is a wake the trace holds with no cause. */
export type CauseRow = { cause: string | null; wakes: number; servedByRun: number; share: number };

export type ManagerSpendReading = {
  day: string; from: number; to: number; sessions: string[];
  rows: SpendRow[]; total: SpendRow;
  /** the day's wakes by `cause`, largest first; their `wakes` add up to `total.wakes` */
  causes: CauseRow[];
  band: typeof TARGET_BAND; baseline: number;
};

export function parseDay(day: string): { from: number; to: number } {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(from) || new Date(from).toISOString().slice(0, "YYYY-MM-DD".length) !== day) throw new Error(`--day must be a real UTC date, YYYY-MM-DD (got ${day})`);
  return { from, to: from + DAY_MS };
}

const emptyRow = (session: string): SpendRow => ({ session, turns: 0, unpriced: 0, usd: 0, usdAtClientRate: 0, wakes: 0, wrote: 0, noOp: 0, escalated: 0, outcomeUnknown: 0, servedByRun: 0, lackingServedBy: 0 });

/**
 * The reading for one UTC day: the turns and wakes of `sessions` with `from <= at < to`, each id once. Spend is `costBy`'s (priced from PRICES, never the stored `costUsd`).
 * Every session asked for has a row, zeros included, so a silent seat is shown as silent.
 */
export function managerSpendReading(events: TraceEvent[], { day, sessions = MANAGERS }: { day: string; sessions?: string[]; }): ManagerSpendReading {
  const { from, to } = parseDay(day);
  const once = [...new Map(events.map((event) => [event.id, event])).values()];
  const inDay = once.filter((event) => sessions.includes(event.session) && event.at >= from && event.at < to);
  const spent = costBy(inDay, "session");
  const rows = new Map<string, SpendRow>(sessions.map((session) => [session, emptyRow(session)]));
  for (const row of spent.rows) Object.assign(rows.get(row.key) as SpendRow, { turns: row.turns, unpriced: row.unpriced, usd: row.usd, usdAtClientRate: row.usdAtClientRate });
  for (const event of inDay) {
    if (event.kind !== "wake") continue;
    const row = rows.get(event.session) as SpendRow;
    row.wakes += 1;
    if (event.outcome === "wrote") row.wrote += 1;
    else if (event.outcome === "no-op") row.noOp += 1;
    else if (event.outcome === "escalated") row.escalated += 1;
    else row.outcomeUnknown += 1;
    const served = (event as Wake).servedBy;
    if (served === "run") row.servedByRun += 1;
    else if (served === undefined || served === null) row.lackingServedBy += 1;
  }
  const total = emptyRow("total");
  for (const row of rows.values()) for (const key of Object.keys(total) as (keyof SpendRow)[]) if (key !== "session") total[key] = (total[key] as number) + (row[key] as number) as never;
  total.usd = round(total.usd);
  total.usdAtClientRate = round(total.usdAtClientRate);
  const byCause = new Map<string | null, { wakes: number; servedByRun: number }>();
  for (const event of inDay) {
    if (event.kind !== "wake") continue;
    const group = byCause.get(event.cause) ?? { wakes: 0, servedByRun: 0 };
    group.wakes += 1;
    if ((event as Wake).servedBy === "run") group.servedByRun += 1;
    byCause.set(event.cause, group);
  }
  const causes = [...byCause].map(([cause, group]) => ({ cause, ...group, share: total.wakes === 0 ? 0 : group.wakes / total.wakes }))
    .sort((a, b) => b.wakes - a.wakes || causeName(a.cause).localeCompare(causeName(b.cause)));
  return { day, from, to, sessions, rows: [...rows.values()], total, causes, band: TARGET_BAND, baseline: BASELINE_USD };
}

const round = (value: number) => Math.round(value * 10 ** USD_DECIMALS) / 10 ** USD_DECIMALS;
const usd = (value: number) => `$${value.toFixed(USD_DECIMALS)}`;
const causeName = (cause: string | null) => cause ?? "(no cause)";

/** A markdown table: the head, a separator with the first column left and the rest right, then the body. */
function markdownTable(head: string[], body: (string | number)[][]): string[] {
  const table = [head, ...body].map((cells) => `| ${cells.join(" | ")} |`);
  table.splice(1, 0, `|${head.map((_, column) => (column === 0 ? " --- " : " ---: ")).join("|")}|`);
  return table;
}

/** The markdown table posted on the record issue. An empty day says so in words: a table of zeros alone could be a table that failed to load. */
export function renderReading(reading: ManagerSpendReading): string {
  const { total, band, baseline } = reading;
  const head = ["session", "turns", "unpriced", "usd (PRICES)", `usd (cache reads at $${CLIENT_CACHE_READ_RATE.toFixed(2)}/M)`, "wakes", "wrote", "no-op", "escalated", "outcome unknown", "served by run", "servedBy absent"];
  const line = (row: SpendRow) => [row.session, row.turns, row.unpriced, usd(row.usd), usd(row.usdAtClientRate), row.wakes, row.wrote, row.noOp, row.escalated, row.outcomeUnknown, row.servedByRun, row.lackingServedBy];
  const table = markdownTable(head, [...reading.rows, total].map(line));
  const causeTable = markdownTable(["cause", "wakes", "served by run", "share of wakes"], reading.causes.map((row) => [causeName(row.cause), row.wakes, row.servedByRun, `${(row.share * 100).toFixed(1)}%`]));
  const band$ = `$${band.low} to $${band.high}`;
  const where = total.usd > band.high ? "above" : total.usd < band.low ? "below" : "inside";
  return [
    `### Manager spend, ${reading.day} (UTC)`,
    "",
    ...(total.wakes === 0 ? [`**0 manager wakes** by ${reading.sessions.join(", ")} on ${reading.day}${total.turns === 0 ? ", and no turns" : ""}: the store holds none for the day.`, ""] : []),
    ...table,
    "",
    `Total at the primary price: ${usd(total.usd)} (${where} the target band of ${band$} a day; baseline ${usd(baseline)}, difference ${usd(round(total.usd - baseline))}).`,
    `Wakes served by a run: ${total.servedByRun} of ${total.wakes}. ${total.lackingServedBy} wake${total.lackingServedBy === 1 ? "" : "s"} carried no \`servedBy\`: they are counted in neither \`served by run\` nor as seat.`,
    "",
    ...(reading.causes.length === 0 ? [] : [`Wakes by cause, largest first (the rows add up to the ${total.wakes} wakes):`, "", ...causeTable, ""]),
    "Read through `readStore` (one event per id), repriced from PRICES at the call; the stored `costUsd` is not summed. `unpriced` turns add no dollars, which is not free. `outcome unknown` is a wake whose outcome is `null` or not yet derived, never `no-op`.",
  ].join("\n");
}

export const isManagerSpend = (argv: string[]) => argv.find((word) => word !== "--") === MANAGER_SPEND_WORD;

const USAGE = "usage: trace manager-spend --day <YYYY-MM-DD> [--sessions a,b,c] [--store <path>]";

export function parseManagerSpendArgs(argv: string[]) {
  const [, ...given] = argv.filter((word) => word !== "--");
  const flags: Record<string, string> = {};
  for (let index = 0; index < given.length; index += 2) {
    const name = given[index];
    if (!["--day", "--sessions", "--store"].includes(name) || given[index + 1] === undefined) throw new Error(`unknown argument ${given.slice(index).join(" ")}: ${USAGE}`);
    flags[name.slice(2)] = given[index + 1];
  }
  if (flags.day === undefined) throw new Error(`--day is required: ${USAGE}`);
  parseDay(flags.day);
  return { day: flags.day, sessions: flags.sessions === undefined ? MANAGERS : flags.sessions.split(",").filter((name) => name.length > 0), store: flags.store ?? defaultStore() };
}

export function mainManagerSpend(argv: string[]) {
  const { day, sessions, store } = parseManagerSpendArgs(argv);
  console.log(renderReading(managerSpendReading(readStore(store), { day, sessions })));
}
