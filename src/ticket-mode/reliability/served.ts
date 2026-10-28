// @ts-check
// module: the health figures the reliability watches read (A11-366) -- the ones `GET /api/health` serves, worked out from the board now
//
// The pool is made inside the board, and the figures are worked out from the board (its pool's runs and `fill()` passes) and the board thread's measuring (`startHealth`), so the pool is given a reader that is pointed at
// the board once it is made.
import { figuresOf, type ThreadBoard } from "../board-thread.ts";
import type { HealthView } from "../health-route.ts";
import type { HealthFigures } from "../health-figures.ts";

/** What the pool reads: the figures as they are now, or null before the reader is pointed at a board. */
export type ServedFigures = Readonly<{ read: () => HealthFigures | null; pointAt: (board: Pick<ThreadBoard, "pool">, health: () => HealthView, startedAt: number) => void }>;

/** A reader of the served figures that answers null until it is pointed at a board. */
export function servedFigures(now: () => number = Date.now): ServedFigures {
  let source: (() => HealthFigures | null) | null = null;
  return { read: () => source?.() ?? null, pointAt: (board, health, startedAt) => { source = () => figuresOf(board, health(), now(), startedAt); } };
}
