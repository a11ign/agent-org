// @ts-check
// module: the health figures a board-reliability ticket may name as its measurement, and the `Figure:` line of its Done-when that names one (A11-366). PURE
//
// A RELIABILITY FIX CLOSED ON GREEN TESTS AND NOTHING WATCHED WHETHER THE SYMPTOM WENT AWAY. A11-282 and A11-345 were Done while both symptoms were still there. So a ticket labelled `board-reliability` names, in its
// `## Done-when`, one figure `GET /api/health` serves and a threshold, and the board watches that figure after the fix is released (`sweep.ts`).
//
// THE LINE IS DECLARED, NOT GUESSED, as an After-merge check's `Observe:` is (`after-merge/observe.ts`): `Figure: <figure> under <number>[ <unit>][, for <window>]`, as a bullet or a line of its own, anywhere in the
// Done-when section. "Under" is strict: a reading equal to the threshold is a breach. The window is `30m`, `6h` or `7d`, and is {@link DEFAULT_WINDOW_MS} when the line names none.
import type { HealthFigures } from "../health-figures.ts";
import { doneWhenOf } from "../done-when.ts";
import { parseWindow } from "../after-merge/observe.ts";

/** The figures a ticket may name. */
export type FigureId = "sync-holds" | "loop-p99" | "linear-failures" | "github-failures";

/** How a figure's number is written: milliseconds, holds in the last hour, or failures per 100 calls (a percentage). */
type Unit = "ms" | "an hour" | "%";

type FigureDef = Readonly<{
  id: FigureId;
  /** The words the board says the figure with. */
  name: string;
  unit: Unit;
  /** What a ticket's line may call it, tried on the line's lower-case words. */
  called: RegExp;
  /** The figure's reading in the health figures, or null when there is nothing to read yet: a failure rate over fewer than {@link MIN_CALLS} calls. */
  read: (figures: HealthFigures) => number | null;
}>;

/** The fewest calls an hour's failure rate is read over: one failed call of three is 33%, and says nothing of Linear. */
export const MIN_CALLS = 20;

const rateOf = ({ calls, failuresPer100 }: HealthFigures["calls"]["linear"]): number | null => (calls < MIN_CALLS ? null : failuresPer100);

const FIGURES: readonly FigureDef[] = [
  { id: "sync-holds", name: "synchronous holds", unit: "an hour", called: /^(?:synchronous|sync)\s+holds?$/, read: ({ syncHolds }) => syncHolds.lastHour },
  { id: "loop-p99", name: "loop lag p99", unit: "ms", called: /^(?:(?:event[- ])?loop)(?:\s+(?:lag|delay))?\s+p99$|^p99\s+loop(?:\s+(?:lag|delay))?$/, read: ({ loop }) => loop.lastHour.p99Ms },
  { id: "linear-failures", name: "Linear failures", unit: "%", called: /^linear\s+(?:call\s+)?failures?$/, read: ({ calls }) => rateOf(calls.linear) },
  { id: "github-failures", name: "GitHub failures", unit: "%", called: /^github\s+(?:call\s+)?failures?$/, read: ({ calls }) => rateOf(calls.github) },
];

/** Every figure the board serves, in the order a comment lists them. */
export const FIGURE_IDS: readonly FigureId[] = FIGURES.map(({ id }) => id);

/** The figure `id` names. */
export function figureOf(id: FigureId): FigureDef {
  const found = FIGURES.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no board-reliability figure is called ${id}`);
  return found;
}

/** The figures a ticket may name, as its line writes them, for a refusal to list. */
export const FIGURE_NAMES: readonly string[] = FIGURES.map(({ name }) => name);

/** What the board does with a figure: the one a ticket names, the threshold it must stay under, and how long the board watches it after release. */
export type FigureSpec = Readonly<{ figure: FigureId; threshold: number; windowMs: number }>;

/** How long a figure is watched when its line names no window: the epic's own, "for 7 days". */
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The figure's reading in `figures`, or null when it has none yet. PURE. */
export const readFigure = (figure: FigureId, figures: HealthFigures): number | null => figureOf(figure).read(figures);

/** Whether a reading has reached the threshold its figure must stay under. PURE. */
export const breaches = (reading: number, { threshold }: Pick<FigureSpec, "threshold">): boolean => reading >= threshold;

const NUMBER_WORDS = /^(.+?)\s+under\s+(\d+(?:\.\d+)?)\s*(%|ms|an?\s+hour|\/\s*h|per\s+hour)?\s*(?:,?\s*for\s+(\S+))?$/i;
const FIGURE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?figure(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/im;

/** The unit a line wrote, as the board's {@link Unit}, or null when it wrote none. */
function unitOf(written: string | undefined): Unit | null {
  if (written === undefined || written === "") return null;
  if (written === "%" || written === "ms") return written;
  return "an hour";
}

/** What a ticket's `Figure:` line gave: a spec, no line at all, or why the line the board found is refused. */
export type Parsed = Readonly<{ kind: "figure"; spec: FigureSpec }> | Readonly<{ kind: "none" }> | Readonly<{ kind: "refused"; why: string }>;

const refused = (why: string): Parsed => ({ kind: "refused", why });

/** The spec one line's text gives (the words after `Figure:`), or why not. PURE. */
export function parseFigureText(text: string): Parsed {
  const match = NUMBER_WORDS.exec(text.replace(/`/g, "").trim().replace(/\.$/, ""));
  if (match === null) return refused(`"${text}" is not "<figure> under <number>", such as "synchronous holds under 10 an hour"`);
  const [, called, number, written, windowText] = match;
  const def = FIGURES.find(({ called: pattern }) => pattern.test(called.toLowerCase().replace(/\s+/g, " ").trim()));
  if (def === undefined) return refused(`"${called}" is not a figure the board serves; it serves ${FIGURE_NAMES.join(", ")}`);
  const unit = unitOf(written?.toLowerCase().replace(/\s+/g, " "));
  if (unit !== null && unit !== def.unit) return refused(`${def.name} is counted in ${def.unit === "an hour" ? "holds an hour" : def.unit}, not "${written}"`);
  const window = windowText === undefined ? DEFAULT_WINDOW_MS : parseWindow(windowText);
  if (typeof window === "string") return refused(window);
  return { kind: "figure", spec: { figure: def.id, threshold: Number(number), windowMs: window } };
}

/** The measurement a ticket's description names in its `## Done-when`: the first `Figure:` line there, or none. PURE. */
export function figureOfDescription(description: string | null | undefined): Parsed {
  const section = doneWhenOf(description);
  const line = section === null ? null : FIGURE_LINE.exec(section);
  return line === null ? { kind: "none" } : parseFigureText(line[1]);
}

/** A number with its figure's unit: `10 an hour`, `100 ms`, `1%`. */
const withUnit = ({ unit }: FigureDef, number: number): string => `${number}${unit === "%" ? "%" : ` ${unit}`}`;

/** A reading as the board says it: the figure, its number with its unit. PURE. */
export const sayReading = (figure: FigureId, reading: number): string => `${figureOf(figure).name} ${withUnit(figureOf(figure), reading)}`;

/** A spec as the board says it: "synchronous holds under 10 an hour for 7d". PURE. */
export function saySpec({ figure, threshold, windowMs }: FigureSpec): string {
  const def = figureOf(figure);
  const days = windowMs % 86_400_000 === 0 ? `${windowMs / 86_400_000}d` : windowMs % 3_600_000 === 0 ? `${windowMs / 3_600_000}h` : `${Math.round(windowMs / 60_000)}m`;
  return `${def.name} under ${withUnit(def, threshold)}, for ${days}`;
}

/** The label that makes a ticket a board-reliability ticket. */
export const RELIABILITY_LABEL = "board-reliability";

/**
 * The figures of tickets the epic closed before the board watched any (A11-366 applies backwards): A11-282's symptom was a blocked loop, 755 synchronous holds in ten minutes on 2026-10-27, and A11-345's was
 * `fetch failed` and `ECONNRESET` on the calls to Linear. Their descriptions name no `Figure:` line and the board does not write a ticket's description, so the board holds these.
 */
export const BACKFILLED: Readonly<Record<string, FigureSpec>> = {
  "A11-282": { figure: "sync-holds", threshold: 10, windowMs: DEFAULT_WINDOW_MS },
  "A11-345": { figure: "linear-failures", threshold: 1, windowMs: DEFAULT_WINDOW_MS },
};
