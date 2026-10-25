// @ts-check
// module: the After-merge checks' sweep (A11-277) -- copy the runs' listed lines into records, prune the old closed ones, and post each close on its ticket once
import { log, messageOf } from "../pool-state.ts";
import type { PoolContext } from "../pool-context.ts";
import { claimPost, closeComment, listedIds, markUnpostable, pruneChecks, releasePost, seedChecks, unpostedChecks } from "./checks.ts";
import { afterMergeChecksPath, changeChecks, loadChecks, saveChecks } from "./store.ts";

type SweepContext = Pick<PoolContext, "settings" | "store" | "source" | "now">;

/**
 * One sweep, run at the end of each tracker refresh: every After-merge line a run listed (A11-173) that has no record yet becomes an open check, so a check outlives its run's dismissal; the closed checks no run
 * lists any more are dropped after 30 days; and each close not posted yet is posted on its ticket. A file that cannot be read changes nothing, and is logged.
 */
export async function syncAfterMergeChecks(ctx: SweepContext): Promise<void> {
  const { settings, store, now } = ctx;
  const path = afterMergeChecksPath(settings.stateDir);
  try {
    const runs = store.get().entries;
    const file = changeChecks(path, (before) => pruneChecks(seedChecks(before, runs, now()), now(), listedIds(runs)));
    await postCloses(ctx, path, unpostedChecks(file).map(({ id }) => id));
  } catch (err) {
    log(`the After-merge checks in ${path} could not be swept: ${messageOf(err)}`);
  }
}

/**
 * Post each of the closes `ids` names on its ticket. A post is claimed on the file as it is now before it is sent, so a sweep beside this one never posts it too, and released when it fails, so the next sweep
 * tries again. A tracker that cannot comment keeps the close on the board alone, and the log says so once.
 */
async function postCloses({ source }: SweepContext, path: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    if (source.comment === undefined) {
      const check = changeChecks(path, (before) => markUnpostable(before, id)).checks[id];
      log(`${check.key}: its After-merge check ${id} closed ${check.state} on the board; this tracker cannot post it as a comment`);
      continue;
    }
    const current = loadChecks(path);
    const claimed = claimPost(current, id);
    if (claimed === current) continue;
    saveChecks(path, claimed);
    const check = claimed.checks[id];
    try {
      await source.comment(check.key, closeComment(check));
    } catch (err) {
      changeChecks(path, (file) => releasePost(file, id));
      log(`${check.key}: its After-merge check ${id} could not be posted as a comment, and is tried again at the next refresh: ${messageOf(err)}`);
    }
  }
}
