// @ts-check
// module: two stored runs of one set side by side (A11-431, step 2 of 2) -- each score of each ticket as `before → after` with its change, and the totals the same way
//
// THE TOTALS COUNT ONLY THE TICKETS BOTH RUNS HAVE, so a run the token cap stopped early is not scored as worse for the tickets it never started. Those tickets are named under the
// table. An unknown (`?`) stays unknown: it is never read as a fail or a 0, and a change from or to it has no number. The similarity and token totals are over the tickets known
// on both sides, and say how many they left out.
import { type StoredRun } from "./store.ts";
import { COLUMNS, layOut } from "./table.ts";
import { type TicketResult } from "../run-eval.ts";

type Scores = TicketResult["scores"];

/** A signed change, `+0.11` or `-2`, with `digits` decimals. PURE. */
const signed = (change: number, digits: number): string => `${change >= 0 ? "+" : ""}${change.toFixed(digits)}`;

/** `before → after (change)` of two numbers, `?` for an unknown and no change when either is unknown. PURE. */
function numberCell(before: number | null, after: number | null, digits = 0, unit = ""): string {
  const shown = (value: number | null) => (value === null ? "?" : `${value.toFixed(digits)}${unit}`);
  const change = before === null || after === null ? "" : ` (${signed(after - before, digits)}${unit})`;
  return `${shown(before)} → ${shown(after)}${change}`;
}

const testsWord = (tests: boolean | null): string => (tests === null ? "?" : tests ? "pass" : "fail");

/** The cells of one ticket both runs have. PURE. */
function ticketCells(ticket: string, before: Scores, after: Scores): string[] {
  return [ticket, `${testsWord(before.tests)} → ${testsWord(after.tests)}`, `${before.verdict ?? "?"} → ${after.verdict ?? "?"}`,
    numberCell(before.similarity, after.similarity, 2), numberCell(before.outside.length, after.outside.length), numberCell(before.tokens, after.tokens),
    numberCell(Math.round(before.wallMs / 1000), Math.round(after.wallMs / 1000), 0, "s")];
}

/** A ticket both runs have: its scores in A and in B. */
type Pair = Readonly<{ ticket: string; a: Scores; b: Scores }>;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : sum(values) / values.length);

/**
 * `before → after (change)` of a score totalled over the pairs where it is known on both sides, so an unknown on one side never reads as a change; how many pairs were left out is
 * said after it. PURE.
 */
function knownCell(pairs: readonly Pair[], score: (scores: Scores) => number | null, total: (values: readonly number[]) => number | null, digits = 0): string {
  const known = pairs.filter(({ a, b }) => score(a) !== null && score(b) !== null);
  const left = pairs.length - known.length;
  const cell = numberCell(total(known.map(({ a }) => score(a) as number)), total(known.map(({ b }) => score(b) as number)), digits);
  return left === 0 ? cell : `${cell} (${left} unknown left out)`;
}

/** The totals row over the shared tickets: passes and convinced verdicts of all, similarity and tokens over the tickets known on both sides, files outside and wall time. PURE. */
function totalCells(pairs: readonly Pair[]): string[] {
  const count = (side: "a" | "b", counted: (scores: Scores) => boolean) => pairs.filter((pair) => counted(pair[side])).length;
  const passed = (scores: Scores) => scores.tests === true;
  const convinced = (scores: Scores) => scores.verdict === "convinced";
  const seconds = (side: "a" | "b") => Math.round(sum(pairs.map((pair) => pair[side].wallMs)) / 1000);
  return ["total", `${numberCell(count("a", passed), count("b", passed))} of ${pairs.length}`, `${numberCell(count("a", convinced), count("b", convinced))} convinced`,
    knownCell(pairs, ({ similarity }) => similarity, mean, 2), numberCell(sum(pairs.map(({ a }) => a.outside.length)), sum(pairs.map(({ b }) => b.outside.length))),
    knownCell(pairs, ({ tokens }) => tokens, sum), numberCell(seconds("a"), seconds("b"), 0, "s")];
}

/** How a run is named in the header: its sha's start, its key, model and effort, and what makes it not a plain run. PURE. */
function runLine(label: string, run: StoredRun): string {
  const key = run.key === null ? "" : ` with ${run.key.name} ${run.key.on ? "on" : "off"}`;
  const marks = [run.dirty ? "uncommitted changes" : null, run.stopped === null ? null : `stopped by the token cap after ${run.stopped.ran} of ${run.stopped.of} tickets`].filter((mark) => mark !== null);
  return `${label}: ${run.sha.slice(0, 7)}${key} (${run.model}, effort ${run.effort}, finished ${new Date(run.at).toISOString()})${marks.length === 0 ? "" : `, ${marks.join(", ")}`}`;
}

/** The comparison of `before` and `after`, two stored runs of one set: who they are, a row per ticket both have and the totals, then the tickets only one has. PURE. */
export function compareTable(before: StoredRun, after: StoredRun): string {
  const afterOf = new Map(after.results.map((result) => [result.entry.ticket, result]));
  const shared = before.results.filter(({ entry }) => afterOf.has(entry.ticket));
  const pairs: Pair[] = shared.map((result) => ({ ticket: result.entry.ticket, a: result.scores, b: (afterOf.get(result.entry.ticket) as TicketResult).scores }));
  const table = layOut([[...COLUMNS], ...pairs.map(({ ticket, a, b }) => ticketCells(ticket, a, b)), totalCells(pairs)]);
  const onlyIn = (run: StoredRun, other: ReadonlyMap<string, unknown>) => run.results.map(({ entry }) => entry.ticket).filter((ticket) => !other.has(ticket));
  const onlyBefore = onlyIn(before, afterOf);
  const onlyAfter = onlyIn(after, new Map(before.results.map((result) => [result.entry.ticket, result])));
  const unshared = [
    ...(onlyBefore.length === 0 ? [] : [`only in A, not in the totals: ${onlyBefore.join(", ")}`]),
    ...(onlyAfter.length === 0 ? [] : [`only in B, not in the totals: ${onlyAfter.join(", ")}`]),
  ];
  return [`worker eval of ${before.set}, A → B`, runLine("A", before), runLine("B", after), "", ...table, ...(unshared.length === 0 ? [] : ["", ...unshared])].join("\n") + "\n";
}
