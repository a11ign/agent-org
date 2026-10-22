// @ts-check
// module: what the board says of a ticket whose text changed under a plan or a worker, and of the findings a plan learns from its blockers (A11-167) (PURE)
//
// THE LINES ARE THE BOARD'S, THE DIFF IS THE PAGE'S. A run says "ticket changed since plan, re-planning first" while it waits, "planning (ticket changed)" while it re-plans, and "ticket changed: sent to the
// worker at 14:05" when a live run was told; a dependent whose planner was given its blockers' merged findings says "learns from A11-165 (#3 merged)", linked to the pull request. "What changed" opens the
// description as a line diff, the old lines struck and the new added. This file imports nothing, so the page runs it as it is.
import { clockOf } from "./update-banner.ts";

/** A change to a ticket's description: when the board noticed it, the description before and the description after. */
export type ViewTicketChange = Readonly<{ at: number; from: string; to: string }>;

/** What a blocker's merged pull request gave a dependent: the blocker's key, the pull request's number and the file its findings were saved in. Keyed by the pull request's address. */
export type ViewLearned = Readonly<{ key: string; number: number; file: string }>;

/** The fields of a run the lines below read. */
export type TicketChangeView = Readonly<{
  phase: string; plan?: unknown; ticketChange?: ViewTicketChange; ticketChanges?: readonly ViewTicketChange[]; learned?: Readonly<Record<string, ViewLearned>>;
}>;

/** The words a queued run says when its plan was written against a description that has since changed. */
export const STALE_PLAN_LINE = "ticket changed since plan, re-planning first";
/** The words a planning run says when it plans again because the ticket changed. */
export const REPLANNING_LINE = "planning (ticket changed)";

/**
 * What changed in a run's ticket, and the line that says so: a queued run whose plan is stale, a planning run re-planning, or a live run the change was sent to. Null for a run with no change to show, and for a finished
 * one, whose next round's brief carries the new text. PURE.
 */
export function ticketChangeOf(entry: TicketChangeView): Readonly<{ line: string; change: ViewTicketChange }> | null {
  if (entry.phase === "finished") return null;
  if (entry.ticketChange !== undefined) return { line: entry.plan === undefined ? STALE_PLAN_LINE : REPLANNING_LINE, change: entry.ticketChange };
  const sent = entry.ticketChanges?.at(-1);
  if (sent === undefined || (entry.phase !== "running" && entry.phase !== "starting")) return null;
  return { line: `ticket changed: sent to the worker at ${clockOf(sent.at)}`, change: sent };
}

/** The line that says a run's ticket changed, or null. PURE. */
export const ticketChangeLine = (entry: TicketChangeView): string | null => ticketChangeOf(entry)?.line ?? null;

/** The pull requests a queued run's planner learns from, each with the words that name it (`A11-165 (#3 merged)`) and its address, in the order they were learned. PURE. */
export function learnsFrom(entry: TicketChangeView): readonly Readonly<{ text: string; url: string }>[] {
  if (entry.phase !== "queued") return [];
  return Object.entries(entry.learned ?? {}).map(([url, { key, number }]) => ({ text: `${key} (#${number} merged)`, url }));
}

/** The one line a queued run shows for what it learns from its blockers, or null: "learns from A11-165 (#3 merged), A11-166 (#4 merged)". PURE. */
export function learnsLine(entry: TicketChangeView): string | null {
  const pulls = learnsFrom(entry);
  return pulls.length === 0 ? null : `learns from ${pulls.map(({ text }) => text).join(", ")}`;
}

/** One line of a diff: shared by both texts, only in the old (struck) or only in the new (added). */
export type DiffLine = Readonly<{ kind: "same" | "removed" | "added"; text: string }>;

/**
 * The line diff of two descriptions: the lines of the longest common run kept as they are, the old lines that are gone `removed`, and the new lines `added`, in reading order. A line is compared with its
 * trailing space trimmed, so the tracker's line ends do not read as edits. PURE.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const old = before.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  const next = after.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  // The table of longest common suffix lengths: the walk from the top then takes a shared line whenever keeping it costs nothing.
  const common = Array.from({ length: old.length + 1 }, () => new Array<number>(next.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = next.length - 1; j >= 0; j -= 1) common[i][j] = old[i] === next[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < next.length) {
    if (old[i] === next[j]) {
      lines.push({ kind: "same", text: old[i] });
      i += 1;
      j += 1;
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      lines.push({ kind: "removed", text: old[i] });
      i += 1;
    } else {
      lines.push({ kind: "added", text: next[j] });
      j += 1;
    }
  }
  lines.push(...old.slice(i).map((text): DiffLine => ({ kind: "removed", text })), ...next.slice(j).map((text): DiffLine => ({ kind: "added", text })));
  return lines;
}
