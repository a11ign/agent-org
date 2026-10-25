// @ts-check
// module: the After-merge checks' sweep (A11-277) -- copy the runs' listed lines into records with what their plans say, prune the old closed ones, pass the ones the board saw, and post each close on its ticket once
import { dirname, join } from "node:path";
import { log, messageOf } from "../pool-state.ts";
import type { PoolContext } from "../pool-context.ts";
import { planTexts } from "../pool-ticket-text.ts";
import { DEPENDENCY_TICKETS_FILE } from "../dependency-updates/board.ts";
import { loadState } from "../dependency-updates/filed.ts";
import { reviewOnHead } from "../wait-on/wait-read.ts";
import { claimPost, closeComment, listedIds, markUnpostable, pruneChecks, releasePost, seedChecks, ticketsToSeed, unpostedChecks, type ChecksFile, type PlannedCheck } from "./checks.ts";
import { closeObserved, filedKeys, observedChecks, watchesSweep, withFiledBaselines, type ObserveFacts } from "./observe.ts";
import { plannedChecks } from "./plan-section.ts";
import { afterMergeChecksPath, changeChecks, loadChecks, saveChecks } from "./store.ts";

/**
 * One sweep, run at the end of each tracker refresh: every After-merge line a run listed (A11-173) that has no record yet becomes an open check, with what its ticket's plan says of it, so a check outlives its run's
 * dismissal; the closed checks no run lists any more are dropped after 30 days; each check the board watches and saw happen is passed; and each close not posted yet is posted on its ticket. A file that cannot be read
 * changes nothing, and is logged.
 */
export async function syncAfterMergeChecks(ctx: PoolContext): Promise<void> {
  const { settings, store, now } = ctx;
  const path = afterMergeChecksPath(settings.stateDir);
  try {
    const runs = store.get().entries;
    const planned = plansOf(ctx, ticketsToSeed(loadChecks(path), runs));
    const seeded = changeChecks(path, (before) => pruneChecks(seedChecks(before, runs, now(), planned), now(), listedIds(runs)));
    const file = closeWhatTheBoardSaw(ctx, path, seeded);
    await postCloses(ctx, path, unpostedChecks(file).map(({ id }) => id));
  } catch (err) {
    log(`the After-merge checks in ${path} could not be swept: ${messageOf(err)}`);
  }
}

/**
 * Pass each check the board watches and saw happen, with its evidence, after recording the dependency sweep's filed tickets on each `sweep-ticket` check that began to watch in this sweep, so only a ticket filed
 * later passes it. Returns the file as it now is.
 */
function closeWhatTheBoardSaw(ctx: PoolContext, path: string, file: ChecksFile): ChecksFile {
  const facts = observeFacts(ctx, file);
  const { dependencyTickets } = facts;
  const watched = dependencyTickets === null ? file : changeChecks(path, (before) => withFiledBaselines(before, filedKeys(dependencyTickets)));
  const passes = observedChecks(watched, facts);
  return passes.length === 0 ? watched : changeChecks(path, (before) => closeObserved(before, passes, ctx.now()));
}

/**
 * What the plan of each ticket in `keys` names in its `## After-merge checks` section, by ticket. A plan that cannot be read, or whose section cannot be, names nothing, and is logged: its lines run as their owners
 * say, so the session still gets them, and a check is never held back unlisted.
 */
function plansOf(ctx: PoolContext, keys: ReadonlySet<string>): Map<string, readonly PlannedCheck[]> {
  const planned = new Map<string, readonly PlannedCheck[]>();
  for (const key of keys) {
    try {
      const read = plannedChecks([...planTexts(ctx, key)]);
      if ("refusal" in read) log(`${key}: ${read.refusal}, so its After-merge checks run as their lines' owners say`);
      else planned.set(key, read.checks);
    } catch (err) {
      log(`${key}: ${messageOf(err)}, so its After-merge checks run as their lines' owners say`);
    }
  }
  return planned;
}

/** What the board reads to pass a watched check: the dependency sweep's file, read only while a check watches it (null when none does, or it cannot be read), the queue, and a pull request's review through the code host. */
function observeFacts(ctx: PoolContext, file: ChecksFile): ObserveFacts {
  const { codeHost, settings, store } = ctx;
  return {
    dependencyTickets: watchesSweep(file) ? dependencyTickets(join(dirname(afterMergeChecksPath(settings.stateDir)), DEPENDENCY_TICKETS_FILE)) : null,
    queue: store.get(),
    reviewOn: (url) => {
      try {
        const state = codeHost.readReviewState(url);
        return state === null ? null : reviewOnHead(state);
      } catch {
        return null;
      }
    },
  };
}

/** The dependency sweep's requests by key, or null when its file cannot be read, which is logged: no check is passed or begins to watch on a file the board could not read. */
function dependencyTickets(path: string): ObserveFacts["dependencyTickets"] {
  try {
    return loadState(path).tickets;
  } catch (err) {
    log(`the dependency sweep's ${path} could not be read for the After-merge checks that watch it: ${messageOf(err)}`);
    return null;
  }
}

/**
 * Post each of the closes `ids` names on its ticket. A post is claimed on the file as it is now before it is sent, so a sweep beside this one never posts it too, and released when it fails, so the next sweep
 * tries again. A tracker that cannot comment keeps the close on the board alone, and the log says so once.
 */
async function postCloses({ source }: PoolContext, path: string, ids: readonly string[]): Promise<void> {
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
