// module: what the Outcomes page draws from `/api/outcomes` (A11-430) -- its words, its windows, and the runs each figure links to
//
// EVERY FIGURE LINKS TO THE RUNS BEHIND IT. A figure is a {@link Figure}: its words and the ids of the runs that make it (a rate's are the runs it is out of, so a person sees the runs that met it
// beside those that did not). A figure with no runs behind it (a rate of nothing) is a dash, and links to none.
// EVERY DOLLAR FIGURE SAYS WHAT IT IS PRICED AT: the words the instance answers with (`pricedAt`, "at configured prices"), never words of the page's own, so a price changed in the host file is
// named as the instance read it. A floor (some tokens unpriced or unread) is "at least", never a figure that looks whole.

import type { Dollars, OutcomeGroup, OutcomeRunView, OutcomesView, OutcomeWindow } from "../api/types.ts";

/** The tables of the page, in order: each names the field of the answer it draws and its heading. */
export const TABLES = [
  /** The model and effort groups split the runs. */
  { field: "byModel", heading: "By model and effort", groupHeading: "Model / effort", overlaps: false },
  /** A run is in each of its repositories' and labels' groups, so those rows do not add up to the window. */
  { field: "byRepo", heading: "By repository", groupHeading: "Repository", overlaps: true },
  { field: "byLabel", heading: "By label", groupHeading: "Label", overlaps: true },
] as const;

/** One table of the page. */
export type Table = (typeof TABLES)[number];

export type TableField = (typeof TABLES)[number]["field"];

/** The columns of a table, after the group's name. */
export const COLUMNS = ["runs", "cost", "reviewerCost", "roundsPerPr", "firstPass", "needsYou"] as const;

export type Column = (typeof COLUMNS)[number];

/** Each column's heading. */
export const COLUMN_HEADINGS: Readonly<Record<Column, string>> = {
  runs: "Runs", cost: "Cost", reviewerCost: "Reviewer", roundsPerPr: "Rounds per PR", firstPass: "First-pass approval", needsYou: "Needs you",
};

/** One figure: what it says, what it says in full (its tooltip and accessible name), and the runs behind it (empty for a dash, which links to none). */
export type Figure = Readonly<{ text: string; full: string; runs: readonly string[] }>;

/** Which figure a person chose: the table, the group's key and the column. */
export type Choice = Readonly<{ table: TableField; key: string; column: Column }>;

const DASH = "—";

/** `usd` as dollars: cents under $100, whole dollars from there. PURE. */
export function usdText(usd: number): string {
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** Dollars as the page shows them: "≥ " before a floor. PURE. */
export const dollarsText = ({ usd, floor }: Dollars): string => `${floor ? "≥ " : ""}${usdText(usd)}`;

/** Dollars in full, with what they are priced at, and why a floor is one. PURE. */
export function dollarsFull(dollars: Dollars, pricedAt: string): string {
  const said = `${usdText(dollars.usd)} ${pricedAt}`;
  return dollars.floor ? `At least ${said}: some tokens behind it could not be read or have no configured price` : said;
}

/** A share as a whole percentage. PURE. */
const percent = (value: number): string => `${Math.round(value * 100)}%`;

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/** One figure of a group. PURE. */
export function figureOf(group: OutcomeGroup, column: Column, pricedAt: string): Figure {
  switch (column) {
    case "runs":
      return { text: String(group.runs.length), full: plural(group.runs.length, "run"), runs: group.runs };
    case "cost":
    case "reviewerCost":
      return { text: dollarsText(group[column]), full: dollarsFull(group[column], pricedAt), runs: group.runs };
    case "roundsPerPr": {
      const { value, rounds, prs, runs } = group.roundsPerPr;
      if (value === null) return { text: DASH, full: "No run opened a pull request", runs: [] };
      return { text: value.toFixed(1), full: `${plural(rounds, "round")} over ${plural(prs, "pull request")}`, runs };
    }
    case "firstPass":
    case "needsYou": {
      const { value, runs, of } = group[column];
      if (value === null) return { text: DASH, full: column === "firstPass" ? "The reviewer reviewed no run" : "No run", runs: [] };
      const met = column === "firstPass" ? "approved at the first review" : "handed to a person";
      return { text: percent(value), full: `${runs.length} of ${plural(of.length, "run")} ${met}`, runs: of };
    }
  }
}

/** Whether two choices name the same figure. PURE. */
export const sameChoice = (a: Choice | null, b: Choice): boolean => a !== null && a.table === b.table && a.key === b.key && a.column === b.column;

/** The group a choice names in `view`, or undefined when the view has none by that key (a newer read dropped it). PURE. */
export const groupOf = (view: OutcomesView, { table, key }: Choice): OutcomeGroup | undefined => view[table].find((group) => group.key === key);

/** The runs a choice links to, in the order the view lists them; every run of the window when nothing is chosen. PURE. */
export function chosenRuns(view: OutcomesView, choice: Choice | null): readonly OutcomeRunView[] {
  if (choice === null) return view.runs;
  const group = groupOf(view, choice);
  const ids = new Set(group === undefined ? [] : figureOf(group, choice.column, view.pricedAt).runs);
  return view.runs.filter(({ run }) => ids.has(run));
}

/** What the list of runs is headed with: the window's runs, or the figure chosen. PURE. */
export function runsHeading(choice: Choice | null): string {
  if (choice === null) return "Every run in the window";
  return `${COLUMN_HEADINGS[choice.column]}, ${choice.key}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const dayText = (at: number): string => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The window in words: its first day to its last, the end being exclusive. PURE. */
export const windowText = ({ from, to }: OutcomeWindow): string => `${dayText(from)} – ${dayText(to - 1)}`;

/** The page's query for a window: what `/api/outcomes` reads, `?from=&to=` in ms. PURE. */
export const windowQuery = ({ from, to }: OutcomeWindow): string => `?${new URLSearchParams({ from: String(from), to: String(to) })}`;

/** The week before `window`, which ends where it starts. PURE. */
export const weekBefore = ({ from }: OutcomeWindow): OutcomeWindow => ({ from: from - WEEK_MS, to: from });

/** The week after `window`, which starts where it ends; null when `window` reaches `now`, since no run has ended after it. PURE. */
export const weekAfter = ({ to }: OutcomeWindow, now: number): OutcomeWindow | null => (to >= now ? null : { from: to, to: to + WEEK_MS });

/** The query the page passes on to `/api/outcomes`: its own `from` and `to`, and nothing else. PURE. */
export function outcomesQueryOf(search: string): string {
  const asked = new URLSearchParams(search);
  const passed = new URLSearchParams();
  for (const name of ["from", "to"]) {
    const value = asked.get(name);
    if (value !== null && value !== "") passed.set(name, value);
  }
  const query = passed.toString();
  return query === "" ? "" : `?${query}`;
}

/** A run's first-pass result in words. PURE. */
export const firstPassText = (firstPass: boolean | null): string => (firstPass === null ? DASH : firstPass ? "Yes" : "No");

/** The count line under the heading: how many runs ended in the window. PURE. */
export const countText = (view: OutcomesView): string => plural(view.runs.length, "run");
