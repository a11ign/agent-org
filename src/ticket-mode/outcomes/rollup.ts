// @ts-check
// module: the outcome rollups (A11-430) -- the runs of a time window added up by model and effort, by repository and by label, each figure with the runs behind it
//
// THE FIGURES, each over the runs of its group whose record ends in the window (a run's record is its latest line, `latestOutcomes`, and `at` is when its latest round ended):
//   COST: every round's and every review's tokens priced at the configured prices (`prices-config.ts`), by the model that spent them. A run with a round or review whose tokens could not be
//         read, or a model with no price, makes the dollars a FLOOR (`floor: true`), never a figure that looks whole.
//   ROUNDS PER PULL REQUEST: the rounds of the runs that opened a pull request, over their pull requests. Null when no run of the group opened one.
//   FIRST-PASS APPROVAL RATE: of the runs the reviewer reviewed, those whose every pull request was approved at its first review. Null when the reviewer reviewed none.
//   NEEDS-YOU RATE: of the group's runs, those with a round that handed the run to a person.
// A RUN IS IN EACH OF ITS LABELS' AND REPOSITORIES' GROUPS, so those groups' figures are not to be added up; the model and effort groups split the runs. Every rate says its runs: `runs` is
// the numerator's, `of` the denominator's, so a figure links to the runs behind it.

import { costAt, type PriceRow } from "../../trace/prices.ts";
import type { ModelTokens } from "./round-tokens.ts";
import type { OutcomeRecord } from "./outcome-record.ts";

/** The window the rollups read: runs whose record ends at or after `from` and before `to`, in ms. */
export type OutcomeWindow = Readonly<{ from: number; to: number }>;

/** Dollars at the configured prices, and whether they are a floor: some tokens behind them are unpriced or unread. */
export type Dollars = Readonly<{ usd: number; floor: boolean }>;

/** A rate, the runs that make it (`runs`) and the runs it is out of (`of`); `value` is null when `of` is empty. */
export type Rate = Readonly<{ value: number | null; runs: readonly string[]; of: readonly string[] }>;

/** One group's figures. `runs` are every run of the group, by run id (`<ticket>@<first start>`). */
export type OutcomeGroup = Readonly<{
  key: string;
  runs: readonly string[];
  cost: Dollars;
  /** The reviewer's share of `cost`. */
  reviewerCost: Dollars;
  roundsPerPr: Readonly<{ value: number | null; rounds: number; prs: number; runs: readonly string[] }>;
  firstPass: Rate;
  needsYou: Rate;
}>;

/** One run as the rollups read it, for the runs a figure links to. */
export type OutcomeRunView = Readonly<{
  run: string; ticket: string; at: number; model: string; effort: string; repos: readonly string[]; labels: readonly string[]; prs: readonly string[];
  rounds: number; needsYou: number; final: string; cost: Dollars; reviewerCost: Dollars; firstPass: boolean | null;
}>;

/** What `/api/outcomes` answers. */
export type OutcomesView = Readonly<{
  window: OutcomeWindow;
  /** What every dollar figure is priced at. */
  pricedAt: string;
  byModel: readonly OutcomeGroup[];
  byRepo: readonly OutcomeGroup[];
  byLabel: readonly OutcomeGroup[];
  runs: readonly OutcomeRunView[];
}>;

/** The group of a run with no label, or no repository. */
export const NONE = "(none)";

/** `tokens` priced at `prices`, model by model. A model with no price there makes the dollars a floor. PURE. */
function priced(prices: readonly PriceRow[], tokens: ModelTokens): Dollars {
  let usd = 0;
  let floor = false;
  for (const [model, each] of Object.entries(tokens)) {
    const cost = costAt(prices, model, each);
    if (cost === null) floor = true;
    else usd += cost;
  }
  return { usd, floor };
}

const plus = (a: Dollars, b: Dollars): Dollars => ({ usd: a.usd + b.usd, floor: a.floor || b.floor });

const NO_DOLLARS: Dollars = { usd: 0, floor: false };

/** `dollars`, made a floor when one of the rounds or reviews behind them could not be read. PURE. */
const flooredByUnread = (dollars: Dollars, spends: readonly Readonly<{ unread?: string }>[]): Dollars =>
  ({ ...dollars, floor: dollars.floor || spends.some(({ unread }) => unread !== undefined) });

/** Whether the reviewer approved each of the run's reviewed pull requests at its first review; null when it reviewed none. PURE. */
function firstPassOf(record: OutcomeRecord): boolean | null {
  const reviews = record.reviews ?? [];
  if (reviews.length === 0) return null;
  const first = new Map<string, string>();
  for (const { pr, verdict } of reviews) if (!first.has(pr)) first.set(pr, verdict);
  return [...first.values()].every((verdict) => verdict === "convinced");
}

/** One run's figures, at `prices`. PURE. */
export function runViewOf(record: OutcomeRecord, prices: readonly PriceRow[]): OutcomeRunView {
  const reviewerCost = flooredByUnread(priced(prices, record.reviewerTokens ?? {}), record.reviews ?? []);
  const cost = plus(flooredByUnread(priced(prices, record.tokens), record.rounds), reviewerCost);
  const { run, ticket, at, model, effort, repos, labels, needsYou, final } = record;
  return { run, ticket, at, model, effort, repos, labels, prs: record.prs ?? [], rounds: record.rounds.length, needsYou, final, cost, reviewerCost, firstPass: firstPassOf(record) };
}

const ids = (runs: readonly OutcomeRunView[]): string[] => runs.map(({ run }) => run);

/** A rate over `of`, made by the runs `holds` accepts. PURE. */
function rateOf(of: readonly OutcomeRunView[], holds: (run: OutcomeRunView) => boolean): Rate {
  const made = of.filter(holds);
  return { value: of.length === 0 ? null : made.length / of.length, runs: ids(made), of: ids(of) };
}

/** One group's figures over its runs. PURE. */
function groupOf(key: string, runs: readonly OutcomeRunView[]): OutcomeGroup {
  const opened = runs.filter(({ prs }) => prs.length > 0);
  const rounds = opened.reduce((sum, { rounds: each }) => sum + each, 0);
  const prs = opened.reduce((sum, { prs: each }) => sum + each.length, 0);
  return {
    key, runs: ids(runs),
    cost: runs.reduce((sum, { cost }) => plus(sum, cost), NO_DOLLARS),
    reviewerCost: runs.reduce((sum, { reviewerCost }) => plus(sum, reviewerCost), NO_DOLLARS),
    roundsPerPr: { value: prs === 0 ? null : rounds / prs, rounds, prs, runs: ids(opened) },
    firstPass: rateOf(runs.filter(({ firstPass }) => firstPass !== null), ({ firstPass }) => firstPass === true),
    needsYou: rateOf(runs, ({ needsYou }) => needsYou > 0),
  };
}

/** The groups `keysOf` puts each run in, by key in order of first appearance. PURE. */
function groupsBy(runs: readonly OutcomeRunView[], keysOf: (run: OutcomeRunView) => readonly string[]): OutcomeGroup[] {
  const groups = new Map<string, OutcomeRunView[]>();
  for (const run of runs) {
    const keys = keysOf(run);
    for (const key of keys.length === 0 ? [NONE] : keys) groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups].map(([key, members]) => groupOf(key, members));
}

/** The rollups of `records`, each run's latest, over `window`, at `prices`, labelled with what they are priced at. PURE. */
export function rollupOf(records: readonly OutcomeRecord[], window: OutcomeWindow, prices: readonly PriceRow[], pricedAt: string): OutcomesView {
  const runs = records.filter(({ at }) => at >= window.from && at < window.to).map((record) => runViewOf(record, prices));
  return {
    window, pricedAt,
    byModel: groupsBy(runs, ({ model, effort }) => [`${model}/${effort}`]),
    byRepo: groupsBy(runs, ({ repos }) => repos),
    byLabel: groupsBy(runs, ({ labels }) => labels),
    runs,
  };
}
