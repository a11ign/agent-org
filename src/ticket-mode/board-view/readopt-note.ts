// @ts-check
// module: the line a card says when the board took a live pane back, or lost a run to a restart (A11-240) (PURE)
import { clockOf } from "./update-banner.ts";

/** What the line needs of a run: how it was taken back or lost, and where it is now. */
type ReadoptView = Readonly<{
  phase: string;
  readopted?: Readonly<{ at: number; from: "starting" }> | Readonly<{ at: number; from: "crashed"; reason: string }>;
  lostInRestart?: Readonly<{ at: number }>;
}>;

/**
 * The one line for a run a restart touched, or null: a run queued again after it was lost says so while it waits; a run whose live pane the board took back says so, whether it was caught starting by the restart or
 * had been marked crashed and its worker carried on. The times are the viewer's clock. PURE.
 */
export function readoptNote(entry: ReadoptView): string | null {
  if (entry.lostInRestart !== undefined && entry.phase === "queued") return `lost in a restart at ${clockOf(entry.lostInRestart.at)} and re-queued`;
  const { readopted } = entry;
  if (readopted === undefined) return null;
  return readopted.from === "starting"
    ? `re-adopted after a restart at ${clockOf(readopted.at)}: its worker carried on`
    : `re-adopted at ${clockOf(readopted.at)}: it was marked crashed (${readopted.reason}), but its worker carried on`;
}
