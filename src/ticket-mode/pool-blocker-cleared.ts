// @ts-check
// module: a needs-human run whose blocker merged lets go of its workspace, so the merge acts on it as on any finished run (A11-258)
//
// A run that ends `needs-human` is parked, and the next-step and plan-count sweeps skip a parked run (`queue/queue-next-step.ts`), so a `Partial:` merge was never followed by the next step, and a `Closes` merge left
// the workspace open under the old question. The tracker refresh calls {@link adoptNamedBlockers} right after it reads the pull requests' states, and {@link releaseMergedBlockers} once the merged bodies are read
// and the tracker's early completion is put back, ahead of the sweeps that queue the next step and complete the ticket. What the run is about and when it is let go is `board-view/blocker-cleared.ts`'s.
import { isReleasable, namedBlockers } from "./board-view/blocker-cleared.ts";
import { pullLabel } from "./board-view/pull-label.ts";
import { parsePull } from "./board-view/pull-url.ts";
import { replace } from "./queue/queue-entries-and-outcomes.ts";
import { mergedPullUrls } from "./queue/queue-declarations.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { close } from "./pool-settle.ts";
import { type PoolContext } from "./pool-context.ts";

/**
 * Record the pull requests a finished `needs-human` run that holds none names in its reason, as the pull requests it is about (its `review` pull requests, which `settledByPulls`, the declaration read, the next step and the
 * completion all read), once all of them have merged or closed with one merged (`namedBlockers`). `read` is what the tracker says now, and each run's earlier read is still in its `pullStates`, so this runs between the
 * tracker's answer and the record of it. A run that holds a pull request, or names none, is left as it is.
 */
export function adoptNamedBlockers(ctx: PoolContext, read: ReadonlyMap<string, Readonly<Record<string, string>>>): void {
  const { store } = ctx;
  for (const entry of store.get().entries) {
    const urls = namedBlockers(entry, read.get(entry.ticket.key) ?? {});
    if (urls.length === 0) continue;
    const review = urls.flatMap((url) => {
      const pull = parsePull(url);
      return pull === null ? [] : [{ repo: pull.repo, url }];
    });
    update(ctx, (queue) => replace(queue, entry.ticket.key, (found) => ({ ...found, review })));
    log(`${entry.ticket.key}: ${urls.map(pullLabel).join(", ")}, named in its reason, ${urls.length === 1 ? "has" : "have"} merged or closed`);
  }
}

/**
 * Close the workspace of each parked `needs-human` run whose pull requests all merged (`isReleasable`), so the sweeps after this one queue its next step or complete its ticket. Herdr refusing the close is logged and
 * leaves the run parked, and the next sweep asks again.
 */
export function releaseMergedBlockers(ctx: PoolContext): void {
  for (const entry of ctx.store.get().entries.filter(isReleasable)) {
    const key = entry.ticket.key;
    const merged = mergedPullUrls(entry).map(pullLabel).join(", ");
    try {
      close(ctx, key);
      log(`${key}: the blocker cleared: ${merged} merged; its workspace was closed`);
    } catch (err) {
      log(`${key}: the blocker cleared: ${merged} merged, but its workspace could not be closed, and is tried again at the next refresh: ${messageOf(err)}`);
    }
  }
}
