// @ts-check
// module: closing a run's workspace without holding the loop (A11-282) -- the close every end of a run makes, asked of herdr beside the pass instead of in it
//
// The board thread closed each ended run's workspace with a synchronous `herdr workspace close`, 250 ms to 1 s a call, and nothing waited on its answer: the note it returned was dropped at every one of these sites. The close
// is now asked through `herdrCall` and left to end by itself. THE PASS'S FILL AND EVERY START WAIT FOR THE CLOSES THAT ARE OUT (`closesSettled`), so a run queued again at once never opens a workspace beside the one it
// replaces, and the listing `settleSessions` reads never shows a workspace that is closing, as the synchronous close guaranteed by being finished first. An instance that ends waits for them a little (`closesSettledWithin`).
import { closedNoteAsync } from "../herdr-agents.ts";
import type { PoolContext } from "./pool-context.ts";

/** How long a close may take, in ms: the cut the synchronous call has always had. The wait holds no loop. */
const CLOSE_MS = 30_000;

/** The closes that are out, so a start can wait for them. Each ends by itself and never rejects. */
export type WorkspaceCloses = Set<Promise<void>>;

/**
 * Ask herdr to close `workspace` and go on. Never throws and never rejects: a close herdr refuses is the same loss it was when its note was dropped, and the tick's own listing still shows the workspace
 * (`readoptCrashed`, `closeLeftover`) for whatever needs it gone.
 */
export function closeWorkspaceLater(ctx: PoolContext, workspace: string): void {
  const close: Promise<void> = closedNoteAsync((args) => ctx.herdrCall(args, CLOSE_MS), workspace, ctx.session).then(() => undefined);
  ctx.workspaceCloses.add(close);
  void close.finally(() => ctx.workspaceCloses.delete(close));
}

/** Whether a close is out. A caller that waits only when one is adds no turn to a pass when none is, so a pass that nothing waits on ends when it did. */
export const closesOut = (ctx: PoolContext): boolean => ctx.workspaceCloses.size > 0;

/** Resolves once every close that was out when it was called has ended. */
export const closesSettled = async (ctx: PoolContext): Promise<void> => {
  await Promise.all([...ctx.workspaceCloses]);
};

/** {@link closesSettled}, or after `limitMs`: an instance that ends waits for the closes it asked, a little, and no longer. */
export const closesSettledWithin = (ctx: PoolContext, limitMs: number): Promise<void> =>
  Promise.race([closesSettled(ctx), new Promise<void>((resolve) => { setTimeout(resolve, limitMs).unref(); })]);
