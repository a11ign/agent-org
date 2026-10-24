// @ts-check
// module: a run's timeline, as the page draws it (A11-219) -- PURE
//
// A RUN'S LOG IS RECORDED FROM THE BOARD THAT KEPT IT: a run stored before it was has none, and shows what the times its entry already holds can rebuild. The rebuilt events are made at read time, carry `rebuilt: true` so the page
// can say so, and are never written to the queue file, so every stored event is one that was recorded. This file is in `board-view/` because the page runs only what that folder holds.
import type { RunEvent } from "../queue/run-log.ts";
import { pullsOf, type ViewEntry } from "./view-types-and-filters.ts";

/** An event of a run's timeline: one the board recorded, or, marked `rebuilt`, one its entry's times rebuild. */
export type TimelineEvent = RunEvent & Readonly<{ rebuilt?: true }>;

/**
 * The timeline of `entry`: its `logged` events when it has any, and otherwise those its own fields rebuild, oldest first. Queued at `queuedAt`; started at `startedAt`; finished at `finishedAt`, with the kind of
 * its outcome and its reason; merged for each of its pull requests that merged, at `finishedAt`, the nearest time the entry holds; and published at the time it was. A field the entry lacks gives no event. PURE.
 */
export function runTimeline(entry: ViewEntry, logged: readonly RunEvent[]): readonly TimelineEvent[] {
  if (logged.length > 0) return logged;
  const { queuedAt, startedAt, finishedAt, outcome, published } = entry;
  const choice = entry.plan ?? entry;
  const merged = pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged");
  const rebuilt: TimelineEvent[] = [
    ...(queuedAt === undefined ? [] : [{ at: queuedAt, kind: "queued" as const, model: choice.model ?? "", effort: choice.effort ?? "", planFirst: entry.plan !== undefined || entry.planned === true }]),
    ...(startedAt === undefined ? [] : [{ at: startedAt, kind: "started" as const, model: entry.model ?? "", effort: entry.effort ?? "", instance: entry.worker?.instance ?? null }]),
    ...(finishedAt === undefined || outcome === undefined ? [] : [{ at: finishedAt, kind: "finished" as const, outcome: outcome.kind, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) }]),
    ...(finishedAt === undefined ? [] : merged.map(({ url }) => ({ at: finishedAt, kind: "merged" as const, url }))),
    ...(published?.at === undefined ? [] : [{ at: published.at, kind: "published" as const, link: published.link }]),
  ].map((event) => ({ ...event, rebuilt: true as const }));
  return rebuilt.sort((a, b) => a.at - b.at);
}
