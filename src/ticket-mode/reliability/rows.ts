// @ts-check
// module: the open board-reliability tickets with their current figures, as `doctor` lists them (A11-366). PURE
//
// ONE ROW A TICKET THAT IS NOT YET HELD. A held ticket's window closed clean and it is no longer the board's concern. A row is a warning when the ticket's figure is at its threshold now, when the board owes a reopen, or when the
// ticket names no figure at all; the exit code is the same, as every board row's is.
import type { HealthFigures } from "../health-figures.ts";
import { breaches, FIGURE_NAMES, readFigure, sayReading, saySpec } from "./figures.ts";
import { owesReopen, type Watch } from "./watch.ts";

/** One row of the list: the ticket, what it says, and the fix for a warning. */
export type ReliabilityRow = Readonly<{ name: string; detail: string; warning: boolean; fix: string | null }>;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Where a watch stands, in words. */
function standing(watch: Watch): string {
  const end = watch.spec !== null && watch.began !== undefined ? `, the window ends ${iso(watch.began + watch.spec.windowMs)}` : "";
  switch (watch.state) {
    case "open": return watch.reopens > 0 ? `reopened by the board ${watch.reopens === 1 ? "once" : `${watch.reopens} times`}, at work again` : "not closed yet";
    case "watching": return watch.began === undefined ? "closed, waiting for its fix to be installed on this host" : `watched since ${iso(watch.began)}${end}`;
    case "breached": return `breached at ${iso(watch.breach?.reading.at ?? 0)}, to be reopened by the board`;
    case "reopened": return `reopened by the board at ${iso(watch.reopenedAt ?? 0)}, ${watch.commented === true && watch.queued === true ? "readings posted and queued" : "its comment or its place on the queue is still to do"}`;
    case "held": return "held";
  }
}

/** The rows for the reliability tickets not yet held, and each one's current reading from `figures` (null when the board serves none). PURE. */
export function reliabilityRows(watches: readonly Watch[], figures: HealthFigures | null): readonly ReliabilityRow[] {
  return watches.filter(({ state }) => state !== "held").sort((a, b) => a.key.localeCompare(b.key)).map((watch): ReliabilityRow => {
    const name = `reliability ${watch.key}`;
    if (watch.spec === null) {
      return { name, detail: `labelled board-reliability, and ${watch.why ?? "names no figure"}`, warning: true, fix: `add a line such as \`Figure: synchronous holds under 10 an hour, for 7d\` to its ## Done-when; the figures are ${FIGURE_NAMES.join(", ")}` };
    }
    const reading = figures === null ? null : readFigure(watch.spec.figure, figures);
    const now = reading === null ? "no reading now" : `${sayReading(watch.spec.figure, reading)} now`;
    const over = reading !== null && breaches(reading, watch.spec);
    const owed = owesReopen(watch);
    return { name, detail: `${watch.title}: ${saySpec(watch.spec)}; ${now}; ${standing(watch)}`, warning: over || owed,
      fix: over || owed ? "the board reopens a closed ticket whose figure does not hold; `GET /api/health` names the calls that hold the loop and the failing service" : null };
  });
}
