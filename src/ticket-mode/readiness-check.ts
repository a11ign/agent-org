// @ts-check
// module: the readiness score's offline test (A11-443, step 2) -- past tickets scored by the live scorer, set against how their runs went in M1's outcome records
//
// THE KEY TURNS ON BY EVIDENCE ONLY. `tickets.readiness` is on by default only when the checked-in result (`evals/readiness/result.json`) shows a clear link between a low score and a harder run: see
// {@link meetsBar}. The default in `settings.ts` is tied to the stored result by a test, so the two cannot drift apart.
//
// HOW A RUN WENT IS READ FROM WHAT THE BOARD RECORDED, never guessed. Rounds and Needs-you come from M1's outcome records (each run's latest line, `latestOutcomes`). Re-plans are not on an outcome
// record, so they come from the queue's run log: each `requeued` event whose `why` is `replan`.
//
// THE SET IS SMALL ON PURPOSE. A11-429's grill (Q4) caps an eval set at {@link MAX_SET} tickets. They are the tickets whose first recorded run is oldest, so they have had the longest to gather rounds,
// and they are picked by when they ran, never by how they went.
//
// THE TICKETS' TEXT STAYS ON THE HOST. agent-org is public: the descriptions and the model's reasons stay in `<stateDir>/evals/readiness/`, and only {@link publicResultOf} (keys, scores and
// the counts read from the board's own logs) is checked in.
import type { OutcomeRecord } from "./outcomes/outcome-record.ts";
import { latestOutcomes } from "./outcomes/outcome-record.ts";
import type { RunEvent } from "./queue/run-log.ts";
import { LOW_READINESS } from "./readiness.ts";

/** The most tickets one set may hold (A11-429, grill Q4: at most 10 tickets per eval set). */
export const MAX_SET = 10;

/** The fewest tickets each side of the comparison needs (scored low, and scored at or above {@link LOW_READINESS}): below it, one ticket decides the means, and no link can be told from chance. */
export const MIN_PER_GROUP = 3;

/** How many times the rest's mean the low tickets' mean must be on a measure for the measure to show a link. */
export const LINK_RATIO = 1.5;

/** How one ticket's runs went: how many runs it had, their rounds, the rounds that ended needing a person, and how often its plan was written again. */
export type TicketHistory = Readonly<{ ticket: string; runs: number; rounds: number; needsYou: number; replans: number }>;

/** A ticket of the set with its score, or null when the scorer could not score it (it is then left out of the comparison and said). */
export type CheckedTicket = TicketHistory & Readonly<{ score: number | null }>;

/** The three measures the bar reads, each a mean per ticket: rounds per run, re-plans, and rounds that ended needing a person. */
export const MEASURES = ["roundsPerRun", "replans", "needsYou"] as const;
export type Measure = (typeof MEASURES)[number];

/** One side of the comparison: how many tickets, and each measure's mean over them (null for no ticket). */
export type GroupMeans = Readonly<{ tickets: number } & Record<Measure, number | null>>;

/** The result's score: how many tickets were checked and scored, both sides' means, the measures that show a link, the ones that go against it, and whether that meets the bar. */
export type LinkScore = Readonly<{ checked: number; scored: number; low: GroupMeans; rest: GroupMeans; linked: readonly Measure[]; against: readonly Measure[]; meetsBar: boolean }>;

/** The time a run started, from its id (`<key>@<ms>`), or null for an id of another shape. PURE. */
const startOf = (run: string): number | null => {
  const found = /@(\d+)$/.exec(run);
  return found === null ? null : Number(found[1]);
};

/** The number of plan re-writes in a ticket's run log. PURE. */
const replansIn = (events: readonly RunEvent[] = []): number => events.filter((event) => event.kind === "requeued" && event.why === "replan").length;

/**
 * Each ticket's history, from the outcome log's lines (`records`, each run's latest line is its record) and the queue's run log (`runLog`, by ticket key). A batch-planned run is its own ticket's
 * run; a ticket with no outcome record is not in the answer, since nothing says how its runs went. PURE.
 */
export function historiesOf(records: readonly OutcomeRecord[], runLog: Readonly<Record<string, readonly RunEvent[]>>): Map<string, TicketHistory> {
  const histories = new Map<string, TicketHistory>();
  for (const record of latestOutcomes(records)) {
    const was = histories.get(record.ticket) ?? { ticket: record.ticket, runs: 0, rounds: 0, needsYou: 0, replans: replansIn(runLog[record.ticket]) };
    histories.set(record.ticket, { ...was, runs: was.runs + 1, rounds: was.rounds + record.rounds.length, needsYou: was.needsYou + record.needsYou });
  }
  return histories;
}

/** The set: the {@link MAX_SET} tickets whose first recorded run started first, oldest first. A run whose id carries no start sorts last. PURE. */
export function pickSet(records: readonly OutcomeRecord[], max: number = MAX_SET): string[] {
  const first = new Map<string, number>();
  for (const { ticket, run } of records) first.set(ticket, Math.min(first.get(ticket) ?? Infinity, startOf(run) ?? Infinity));
  return [...first.entries()].sort(([a, at], [b, bt]) => at - bt || a.localeCompare(b)).slice(0, max).map(([ticket]) => ticket);
}

/** The mean of `values`, or null for none. PURE. */
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length);

/** One side's means. PURE. */
function meansOf(tickets: readonly CheckedTicket[]): GroupMeans {
  return {
    tickets: tickets.length,
    roundsPerRun: mean(tickets.map(({ rounds, runs }) => rounds / runs)),
    replans: mean(tickets.map(({ replans }) => replans)),
    needsYou: mean(tickets.map(({ needsYou }) => needsYou)),
  };
}

/** Whether the low side's mean on `measure` is at least {@link LINK_RATIO} times the rest's, and above 0. PURE. */
const showsLink = (low: GroupMeans, rest: GroupMeans, measure: Measure): boolean => {
  const [lowMean, restMean] = [low[measure], rest[measure]];
  return lowMean !== null && restMean !== null && lowMean > 0 && lowMean >= restMean * LINK_RATIO;
};

/** Whether the low side did better than the rest on `measure`: a measure that goes against the link. PURE. */
const goesAgainst = (low: GroupMeans, rest: GroupMeans, measure: Measure): boolean => {
  const [lowMean, restMean] = [low[measure], rest[measure]];
  return lowMean !== null && restMean !== null && lowMean < restMean;
};

/**
 * Whether the comparison shows a clear link (A11-429's bar for F4: "a shown link between low scores and more rounds, re-plans or Needs-you, with the sample size"): at least {@link MIN_PER_GROUP}
 * tickets on each side, at least one measure where the low tickets' mean is {@link LINK_RATIO} times the rest's, and no measure where the low tickets did better. PURE.
 */
export const meetsBar = (low: GroupMeans, rest: GroupMeans, linked: readonly Measure[], against: readonly Measure[]): boolean =>
  low.tickets >= MIN_PER_GROUP && rest.tickets >= MIN_PER_GROUP && linked.length > 0 && against.length === 0;

/** The score of a checked set: the scored tickets split at {@link LOW_READINESS}, each side's means, and the bar. PURE. */
export function linkOf(checked: readonly CheckedTicket[]): LinkScore {
  const scored = checked.filter((each) => each.score !== null);
  const low = meansOf(scored.filter(({ score }) => score! < LOW_READINESS));
  const rest = meansOf(scored.filter(({ score }) => score! >= LOW_READINESS));
  const linked = MEASURES.filter((measure) => showsLink(low, rest, measure));
  const against = MEASURES.filter((measure) => goesAgainst(low, rest, measure));
  return { checked: checked.length, scored: scored.length, low, rest, linked, against, meetsBar: meetsBar(low, rest, linked, against) };
}

/** What each measure is called in the verdict. */
const MEASURE_NAMES: Readonly<Record<Measure, string>> = { roundsPerRun: "rounds per run", replans: "re-plans", needsYou: "Needs-you rounds" };

/** A mean to two decimals, without trailing zeros, or "none". PURE. */
const shown = (value: number | null): string => (value === null ? "none" : String(Number(value.toFixed(2))));

/** Both sides' means on every measure, in one clause. PURE. */
const meansText = ({ low, rest }: LinkScore): string => MEASURES.map((measure) => `${MEASURE_NAMES[measure]} ${shown(low[measure])} against ${shown(rest[measure])}`).join(", ");

/** Why a score misses the bar, each reason a clause. PURE. */
function missesOf(score: LinkScore): string[] {
  const { low, rest, linked, against } = score;
  return [
    ...(low.tickets < MIN_PER_GROUP ? [`${low.tickets} scored under ${LOW_READINESS}, short of the ${MIN_PER_GROUP} the bar needs`] : []),
    ...(rest.tickets < MIN_PER_GROUP ? [`${rest.tickets} scored ${LOW_READINESS} or more, short of the ${MIN_PER_GROUP} the bar needs`] : []),
    ...(linked.length === 0 ? [`no measure is ${LINK_RATIO} times as high for the low tickets`] : []),
    ...(against.length > 0 ? [`the low tickets did better on ${against.map((measure) => MEASURE_NAMES[measure]).join(" and ")}`] : []),
  ];
}

/** The score in one line, for the pull request and the docs: the sample, both sides' means, and why the key is on or stays off. PURE. */
export function verdictOf(score: LinkScore): string {
  const sample = `${score.scored} scored of ${score.checked} past tickets: ${score.low.tickets} under ${LOW_READINESS}, ${score.rest.tickets} at ${LOW_READINESS} or more.`;
  const means = score.low.tickets > 0 && score.rest.tickets > 0 ? ` Low against the rest, per ticket: ${meansText(score)}.` : "";
  if (score.meetsBar) return `${sample}${means} A clear link on ${score.linked.map((measure) => MEASURE_NAMES[measure]).join(" and ")}, so the key is on by default.`;
  return `${sample}${means} No clear link, so the key stays off: ${missesOf(score).join("; ")}.`;
}

/** One ticket as the full result keeps it, on the host: its history, its score or why it has none, and the model's reasons. */
export type CheckedResult = CheckedTicket & Readonly<{ reasons: readonly string[]; failed?: string }>;

/** The result the check stores beside its set: when and how it ran, every ticket, the score and its verdict. */
export type CheckResult = Readonly<{ ranAt: string; sha: string; model: string; capped: boolean; score: LinkScore; verdict: string; tickets: readonly CheckedResult[] }>;

/** The result as it is checked in to the public repository: keys, scores and the board's counts, with no reason and no text from the tickets. */
export type PublicResult = Omit<CheckResult, "tickets"> & Readonly<{ tickets: readonly CheckedTicket[] }>;

/** `result` with every reason and failure text taken out. PURE. */
export function publicResultOf(result: CheckResult): PublicResult {
  const tickets = result.tickets.map(({ ticket, runs, rounds, needsYou, replans, score }): CheckedTicket => ({ ticket, runs, rounds, needsYou, replans, score }));
  return { ...result, tickets };
}
