// @ts-check
// module: the run a queued run is started stacked on because their files overlap (A11-374) -- PURE
//
// OVERLAP MEANS STACK, NOT WAIT. On 2026-10-28 six tickets of one epic changed the same three files and ran side by side off `main`, so each merge put the rest into conflict. A queued run that overlaps a run in its repository is not held until
// that run merges, and not run beside it off `main`: it starts at once, branched from that run's branch, with its pull request based on that branch, and A11-248's restack moves the stack onto `main` as each pull request below it merges.
// The run it stacks on is a blocker in all but name (`stackBlockersOf`), so the stacking, the restack, the stack merge and A11-370's CI, notes and start priority are the ones a blocker has. Like the rest of `board-view/`, it is sent to the
// browser as one script with its relative imports dropped.
import { isLive, overlapHits, type OverlapHit } from "./overlap-hold.ts";
import { stackBaseOf, type StackBase } from "./pull-status-and-notes.ts";
import { pullsOf, type ViewBlocker, type ViewEntry } from "./view-types-and-filters.ts";
import { repoOf } from "./waits-on.ts";

/**
 * The run a queued run was started stacked on because their files overlap (A11-374), recorded as the start is decided: the base's key, its repository, its branch, the commit the branch was at (`head`, null before it was read) and its first open pull request there (`url`),
 * which together let the base pass for a blocker the run stacks on (`stackBlockersOf`). `shared` is the first file the two share, null where the run claimed its whole repository, which the card says. `others` are the other runs it overlaps
 * that it could have stacked on, which the brief names.
 */
export type OverlapStackRecord = Readonly<{
  key: string; repo: string; branch: string; head: string | null; url: string | null; shared: string | null;
  others: readonly Readonly<{ key: string; branch: string }>[];
}>;

/** What a queued run starts stacked on: the run it stacks on, and the other runs it overlaps that it could have stacked on instead. */
export type OverlapStack = Readonly<{ base: StackBase; others: readonly StackBase[]; shared: string | null }>;

/**
 * The run `holder` as a blocker the queued run could stack on: its ticket's branch, the commit that branch is at in the run's repository once the board read it pushed there (`pushed`), and each pull request it has by its state. The one rule of
 * what is stackable stays {@link stackBaseOf}'s: a branch with an open pull request in the run's repository, or a pushed head. PURE.
 */
function holderAsBlocker(holder: ViewEntry, repo: string): ViewBlocker {
  const pushed = holder.pushed?.repo === repo ? holder.pushed.head : undefined;
  return {
    key: holder.ticket.key, state: holder.trackerState ?? "started", status: "", ...(holder.ticket.branch === undefined ? {} : { branch: holder.ticket.branch }), ...(pushed === undefined ? {} : { head: pushed }),
    pulls: Object.fromEntries(pullsOf(holder).map(({ url }) => [url, holder.pullStates?.[url] ?? "open"])),
  };
}

/** When a run last moved: the latest of when it finished, started and was queued, all fields the queue already holds, so no read gates a start. A round queues and restarts a run, so these move with its activity. PURE. */
const updatedAt = (entry: ViewEntry): number => Math.max(entry.finishedAt ?? 0, entry.startedAt ?? 0, entry.queuedAt ?? 0);

/** Whether the queued run could stack on `holder`: it has a branch with an open pull request in the run's repository, or one read as pushed there (the one rule of what is stackable, {@link stackBaseOf}). PURE. */
const stackableOn = (entry: ViewEntry, holder: ViewEntry, repo: string | null): boolean => repo !== null && stackBaseOf(entry, holderAsBlocker(holder, repo)) !== null;

/**
 * The runs a queued run waits for among `hits`, the runs its claim overlaps (A11-374), or none when it starts. OVERLAP MEANS STACK, NOT WAIT: a run waits for none while it can stack on one of them. It still waits for a run that is at work with no branch to build on
 * yet, since it would otherwise run beside it off the same base, and that conflicts as the runs it stacks on do: it is stacked on that run in a later pass, once the run has pushed. With nothing to stack on, it waits for all of them, as it did. PURE.
 */
export function blockingHits(entry: ViewEntry, hits: readonly OverlapHit[]): OverlapHit[] {
  const repo = repoOf(entry);
  const lacking = hits.filter(({ holder }) => !stackableOn(entry, holder, repo));
  return lacking.length < hits.length ? lacking.filter(({ holder }) => isLive(holder)) : lacking;
}

/**
 * What a queued run stacks on, or null when it stacks on nothing (A11-374). The runs its claim overlaps ({@link overlapHits}) in its own repository that it can stack on are the candidates, and it stacks on the one most recently updated
 * ({@link updatedAt}), the later in the queue on a tie; the others it could have stacked on are told to the run. A run with no repository known stacks on nothing, and neither does one that waits for a run to push ({@link blockingHits}). `hits` are the runs it overlaps,
 * when the caller has them already. PURE.
 */
export function overlapStackOf(entry: ViewEntry, entries: readonly ViewEntry[], hits: readonly OverlapHit[] = overlapHits(entry, entries)): OverlapStack | null {
  const repo = repoOf(entry);
  if (repo === null || blockingHits(entry, hits).length > 0) return null;
  const candidates = hits.flatMap(({ holder, wait }) => {
    const base = stackBaseOf(entry, holderAsBlocker(holder, repo));
    return base === null ? [] : [{ base, at: updatedAt(holder), place: entries.indexOf(holder), shared: wait.path }];
  });
  if (candidates.length === 0) return null;
  const [chosen, ...rest] = [...candidates].sort((a, b) => b.at - a.at || b.place - a.place);
  return { base: chosen.base, others: rest.map(({ base }) => base), shared: chosen.shared };
}

/** The record of what a run stacks on, as the queue keeps it. PURE. */
export const overlapRecordOf = ({ base, others, shared }: OverlapStack): OverlapStackRecord => ({
  key: base.key, repo: base.repo, branch: base.branch, head: base.head, url: base.url, shared, others: others.map(({ key, branch }) => ({ key, branch })),
});
