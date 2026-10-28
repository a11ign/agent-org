// @ts-check
// module: what the board writes on a ticket it reopens (A11-366). PURE
import type { HealthFigures } from "../health-figures.ts";
import { figureOf, FIGURE_IDS, readFigure, sayReading, saySpec } from "./figures.ts";
import type { Readings, Watch } from "./watch.ts";

/** Every figure the board serves with its reading at `at`, one line each: what a reopened ticket's comment lists beside the figure that breached. PURE. */
export function readingsOf(figures: HealthFigures, at: number): Readings {
  return { at, lines: FIGURE_IDS.map((id) => { const reading = readFigure(id, figures); return reading === null ? `${figureOf(id).name}: too few calls in the last hour to read` : sayReading(id, reading); }) };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The comment the board posts on a ticket it reopened: the figure and its threshold, the reading that breached and when, the window it was watched in, and every figure then. PURE. */
export function reopenComment(watch: Watch): string {
  const { spec, breach } = watch;
  if (spec === null || breach === undefined) throw new Error(`${watch.key} has no breach to say`);
  const peak = watch.peak === undefined ? "" : `, the highest ${sayReading(spec.figure, watch.peak.value)}`;
  return [
    `agent-org reopened this ticket: the figure it named did not hold after its fix was released.`,
    "",
    `- Figure: ${saySpec(spec)}.`,
    `- Reading: ${sayReading(spec.figure, breach.reading.value)} at ${iso(breach.reading.at)}, the threshold being ${spec.threshold}. The window began ${iso(watch.began ?? breach.reading.at)}; ${watch.reads} reading${watch.reads === 1 ? "" : "s"} in it${peak}.`,
    `- Every figure then, from \`/api/health\`:`,
    ...breach.readings.lines.map((line) => `  - ${line}`),
    "",
    "The board has queued it on the default model. Fix the cause and close it again: the board watches the figure again from that close.",
  ].join("\n");
}
