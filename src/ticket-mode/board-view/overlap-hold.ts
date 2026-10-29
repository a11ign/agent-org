// @ts-check
// module: the board's overlap hold -- which paths a run claims, which of them two runs share, and what a planner is shown of the paths other runs hold (A11-125, A11-175, A11-212)
//
// Split from `pull-status-and-notes.ts`, whose public API is at the 50 members a module may export: `waitNote` there words the hold this file decides, and the queue (`queue.ts`) starts a run only when
// `overlapWait` finds none. PURE. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.
import { SCAFFOLD_DIRS } from "../../scaffold-dirs.ts";
import type { HeldClaim } from "../path-claims.ts";
import { currentStepOf, currentStepPaths } from "./plan-steps.ts";
import { blockingHits } from "./overlap-stack.ts";
import { parsePull } from "./pull-url.ts";
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";
import { repoOf, sequencedBlockers, waitersOn } from "./waits-on.ts";

/** Split a repository-prefixed path, `<repo>:<path>`, into its repository and its path within it. PURE. */
const repoPath = (path: string): [string, string] => {
  const cut = path.indexOf(":");
  return [path.slice(0, cut), path.slice(cut + 1)];
};

/**
 * Whether a repository-prefixed path counts for overlap: it names a file, and it is not the scaffolding of a ticket's own file (see
 * {@link SCAFFOLD_DIRS}). An empty name is a list cut short, which names no file. PURE.
 */
const countsForOverlap = (path: string): boolean => {
  const [, inRepo] = repoPath(path);
  return inRepo !== "" && !SCAFFOLD_DIRS.some((dir) => inRepo.startsWith(dir));
};

/**
 * Whether two repository-prefixed paths touch the same files: they are in one repository, and are equal, or one is a directory (its path ends in
 * `/`) that holds the other. Sibling directories, and a file and a directory it is not in, do not overlap. PURE.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const [repoA, pathA] = repoPath(a);
  const [repoB, pathB] = repoPath(b);
  if (repoA !== repoB) return false;
  return pathA === pathB || (pathA.endsWith("/") && pathB.startsWith(pathA)) || (pathB.endsWith("/") && pathA.startsWith(pathB));
}

/**
 * The plan paths a run holds (A11-175). A run on a step of a multi-step plan holds that step's paths when the plan's section for it lists any. When it lists none, a run that has a pull request open holds that
 * pull request's files alone (`footprintOf` adds them), since the files it changes are the pull request's, when its worker has ended or it is a round on that pull request (`review` is set). Any other run holds
 * the whole plan's, because the files it will change are not known (A11-125): a first run still working, or one with no pull request open. A run that is no step of a plan holds the whole plan's. PURE.
 */
function heldPlanPaths(entry: ViewEntry): readonly string[] {
  const ofStep = currentStepPaths(entry);
  if (ofStep !== null) return ofStep;
  const workerEnded = entry.phase !== "starting" && entry.phase !== "running";
  const isRoundOnItsPulls = entry.review !== undefined;
  const onlyPulls = currentStepOf(entry) !== null && (workerEnded || isRoundOnItsPulls) && openPulls(entry).length > 0;
  return onlyPulls ? [] : (entry.paths ?? []);
}

/**
 * The files each open pull request of a run changes, each in the repository that pull request is in, without the scaffolding (see {@link countsForOverlap}). A pull request whose list was cut short holds the files listed, and no
 * others: the files past those are unknown, not untouched, and an empty name marks them. PURE.
 */
export const pullFootprintOf = (entry: ViewEntry): string[] =>
  openPulls(entry).flatMap(({ url, repo }) => (repo === undefined ? [] : (entry.pullFiles?.[url] ?? []).map((file) => `${repo}:${file}`))).filter(countsForOverlap);

/**
 * A run's footprint: the paths its plan says its work touches (for a run on a step of a multi-step plan, that step's, see {@link heldPlanPaths}), and the files each of its open pull requests changes ({@link pullFootprintOf}). PURE.
 */
export function footprintOf(entry: ViewEntry): string[] {
  return [...heldPlanPaths(entry), ...pullFootprintOf(entry)].filter(countsForOverlap);
}

/** The paths the run's ticket Region names (A11-374), each in the run's repository, or in the repository it names; none where no repository is known for a bare one. PURE. */
function regionPathsOf(entry: ViewEntry): string[] {
  const repo = repoOf(entry);
  return (entry.regionPaths ?? []).flatMap((path) => {
    const [named, inRepo] = repoPath(path);
    const own = named === "" ? repo : named;
    return own === null ? [] : [`${own}:${inRepo}`];
  }).filter(countsForOverlap);
}

/**
 * What a run claims of a repository's files (A11-374): counted `paths`, or, when it has no file to name, its whole `repoWide` repository. A repository-wide claim overlaps every run that is live in that repository or holds a path in it,
 * so a ticket that was queued without a plan is not treated as overlapping nothing. It is its own kind of claim and not a path, since no path can spell "everything in the repository" (see {@link pathsOverlap}).
 */
export type Claim = Readonly<{ paths: readonly string[]; repoWide: string | null }>;

const NO_CLAIM: Claim = { paths: [], repoWide: null };

/** Whether a claim names nothing. */
const isEmpty = ({ paths, repoWide }: Claim): boolean => paths.length === 0 && repoWide === null;

/** The repositories a claim names. */
const reposOf = ({ paths, repoWide }: Claim): Set<string> => new Set(repoWide === null ? paths.map((path) => repoPath(path)[0]) : [repoWide]);

/** The tracker's states that end a ticket's work: a run on such a ticket is done, or was dropped, and holds nothing once it is not live. */
export const ENDED_TICKETS: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);

/**
 * Whether a run holds its footprint against the runs queued behind it: it is live, or it has a pull request still open and its ticket has not
 * ended. That is a finished run, a draft too, or a queued review round, which keeps the pull requests it continues.
 */
const holds = (entry: ViewEntry): boolean => {
  if (entry.phase === "starting" || entry.phase === "running") return true;
  const pullsOpen = entry.phase === "finished" || entry.review !== undefined;
  return pullsOpen && openPulls(entry).length > 0 && !ENDED_TICKETS.has(entry.trackerState ?? "");
};

/**
 * Whether two runs are sequenced on purpose: one is a blocker of the other (`waitsOn`, `stackedOn`), so they are never held against each other, and a planner is not shown the other's paths. PURE.
 */
const sequenced = (entry: ViewEntry, other: ViewEntry): boolean =>
  sequencedBlockers(entry).some(({ key }) => key === other.ticket.key) || sequencedBlockers(other).some(({ key }) => key === entry.ticket.key);

/**
 * The question whether a holder waits on a queued run's ticket through more than a blocker of its own: a ticket its idle worker declared a wait on, or one reached through the tickets those wait on ({@link waitersOn},
 * A11-272). A run parked on a wait would otherwise hold its files against the very ticket it waits for. The board is walked once, and only when a path is found shared. PURE.
 */
function waitsOnTicketOf(entry: ViewEntry, entries: readonly ViewEntry[]): (holder: ViewEntry) => boolean {
  let waiters: ReadonlySet<string> | null = null;
  return (holder) => (waiters ??= waitersOn(entry.ticket.key, entries)).has(holder.ticket.key);
}

/**
 * What a queued run claims (A11-374), from the first source that gives anything: the paths of its plan (for a queued step of a multi-step plan, its step's when the plan lists any for it, and not the whole plan's, A11-175), else the files of its
 * open pull requests, else the paths its ticket's Region names, else its whole repository. Nothing for a run that holds no path (see {@link pathless}), one started anyway past its overlap (`overlapOverride`), and one whose repository is not known. PURE.
 */
export function claimOf(entry: ViewEntry): Claim {
  if (pathless(entry) || entry.overlapOverride !== undefined) return NO_CLAIM;
  const planned = (currentStepPaths(entry) ?? entry.paths ?? []).filter(countsForOverlap);
  const named = [planned, pullFootprintOf(entry), regionPathsOf(entry)].find((paths) => paths.length > 0);
  return named !== undefined ? { paths: named, repoWide: null } : { paths: [], repoWide: repoOf(entry) };
}

/** Whether a run is at work: starting or running. */
export const isLive = (entry: ViewEntry): boolean => entry.phase === "starting" || entry.phase === "running";

/**
 * What a run that holds its footprint holds (A11-374): its footprint, else, for a run at work, the paths its ticket's Region names, else its whole repository, since the files it changes are not known. A planning run reads and changes no file, so it holds none. PURE.
 */
export function holderClaimOf(entry: ViewEntry): Claim {
  const footprint = footprintOf(entry);
  if (footprint.length > 0 || !isLive(entry) || entry.plan !== undefined) return { paths: footprint, repoWide: null };
  const region = regionPathsOf(entry);
  return region.length > 0 ? { paths: region, repoWide: null } : { paths: [], repoWide: repoOf(entry) };
}

/** Whether a run holds no path in the queue: it is not queued, it is planning, or it is a review round, since no path holds those. PURE. */
const pathless = (entry: ViewEntry): boolean => entry.phase !== "queued" || entry.plan !== undefined || entry.review !== undefined;

/** Whether `other` is a run a queued run contests paths with: a run that holds its footprint, other than its own and not sequenced with it. PURE. */
const competes = (entry: ViewEntry, other: ViewEntry): boolean => other.ticket.key !== entry.ticket.key && holds(other) && !sequenced(entry, other);

/**
 * One path two runs both claim: `path` is the narrower of the two, the file where one is a file, and within its repository. `folderOf` is the key of the run whose directory claim made the overlap, and `folder` that
 * directory, or both null when the two name the same path (A11-212).
 */
type Overlap = Readonly<{ path: string; folderOf: string | null; folder: string | null }>;

/**
 * The run a queued run waits on: its key, the number of its first open pull request when it has one, the first of the waiting run's own paths that overlaps (`path`, which Start anyway records), and every
 * path both touch with whose directory claim made it, or null and none for a run whose pull request's files are not read yet, so that the run is held by its repository alone (A11-125). `repoWide` is the repository when one of the two claims all of it and so nothing narrower is shared (A11-374). `unpushed` marks a holder
 * the run could stack on once it has pushed a branch to build on (A11-374, set by {@link overlapWait}).
 */
export type OverlapWait = Readonly<{ key: string; pull: string | null; path: string | null; overlaps: readonly Overlap[]; repoWide?: string; unpushed?: true }>;

/** The keys of the waiting run and of the run that holds the paths it waits on. */
type Pair = Readonly<{ waiting: string; holder: string }>;

/** How the claim `own` of the waiting run and the claim `theirs` of the holder overlap: the narrower path, and the run whose directory claim is the wider (null when both name the same path). PURE. */
function overlapOf(own: string, theirs: string, { waiting, holder }: Pair): Overlap {
  const [, ownPath] = repoPath(own);
  const [, theirPath] = repoPath(theirs);
  if (ownPath === theirPath) return { path: ownPath, folderOf: null, folder: null };
  const ownIsWider = ownPath.endsWith("/") && theirPath.startsWith(ownPath);
  return ownIsWider ? { path: theirPath, folderOf: waiting, folder: ownPath } : { path: ownPath, folderOf: holder, folder: theirPath };
}

/** Every overlap between the claims `mine` and `held`, each narrow path once, in `mine`'s order. PURE. */
function overlapsBetween(mine: readonly string[], held: readonly string[], pair: Pair): Overlap[] {
  const found = new Map<string, Overlap>();
  for (const own of mine) {
    for (const theirs of held.filter((claim) => pathsOverlap(own, claim))) {
      const overlap = overlapOf(own, theirs, pair);
      if (!found.has(overlap.path)) found.set(overlap.path, overlap);
    }
  }
  return [...found.values()];
}

/** How a run's claim overlaps a holder's: the wait it would be told, and the repository the overlap is in. */
type Overlapping = Readonly<{ wait: OverlapWait; repo: string }>;

/** A run that holds files the waiting run claims, and how they overlap. */
export type OverlapHit = Readonly<Overlapping & { holder: ViewEntry }>;

/** The number of the first open pull request of `holder`, or null when it has none. PURE. */
const firstPullOf = (holder: ViewEntry): string | null => parsePull(openPulls(holder)[0]?.url ?? "")?.number ?? null;

/**
 * How `holder`'s claim overlaps `mine` (A11-374), or null when it does not. Two path claims overlap in the paths they share; a repository-wide claim on either side overlaps any claim in that repository (and the repository-wide claim of the
 * same one), and shares no narrower path to name. PURE.
 */
function overlapWith(entry: ViewEntry, mine: Claim, holder: ViewEntry): Overlapping | null {
  const theirs = holderClaimOf(holder);
  const repoWide = mine.repoWide ?? theirs.repoWide;
  if (repoWide !== null) {
    const touchesRepo = (claim: Claim): boolean => claim.repoWide === repoWide || claim.paths.some((path) => repoPath(path)[0] === repoWide);
    // A run that names no file overlaps the runs at work in its repository and the runs that name none themselves, not every pull request open in it: what those change cannot be compared with files it has not named.
    const meets = mine.repoWide === null || theirs.repoWide !== null || isLive(holder);
    return meets && touchesRepo(mine) && touchesRepo(theirs) ? { repo: repoWide, wait: { key: holder.ticket.key, pull: firstPullOf(holder), path: null, overlaps: [], repoWide } } : null;
  }
  const path = mine.paths.find((own) => theirs.paths.some((held) => pathsOverlap(own, held)));
  if (path === undefined) return null;
  const overlaps = overlapsBetween(mine.paths, theirs.paths, { waiting: entry.ticket.key, holder: holder.ticket.key });
  return { repo: repoPath(path)[0], wait: { key: holder.ticket.key, pull: firstPullOf(holder), path: repoPath(path)[1], overlaps } };
}

/**
 * Every run a queued run's claim overlaps (A11-374), in queue order, with how: a run that holds its footprint ({@link holds}) and shares a path or a repository-wide claim with it ({@link overlapWith}), and a finished run whose open pull request's
 * files are not read yet (`pullFiles` unset) and lies in a repository the claim names, since the files it may change are unknown, so they may share one (A11-125). A run is not one that the queued run's ticket is sequenced with
 * on purpose, or that waits on it through a declared wait ({@link waitsOnTicketOf}). PURE.
 */
export const overlapHits = (entry: ViewEntry, entries: readonly ViewEntry[]): OverlapHit[] => hitsFor(entry, entries, waitsOnTicketOf(entry, entries));

/** The same runs without the exemption for a holder that waits on the queued run's ticket: the hold the wait cycles look for (see {@link overlapHolders}). PURE. */
const rawOverlapHits = (entry: ViewEntry, entries: readonly ViewEntry[]): OverlapHit[] => hitsFor(entry, entries, () => false);

/** The runs a queued run's claim overlaps, except those `waitsOnIt` says wait on its ticket. PURE. */
function hitsFor(entry: ViewEntry, entries: readonly ViewEntry[], waitsOnIt: (holder: ViewEntry) => boolean): OverlapHit[] {
  const mine = claimOf(entry);
  if (isEmpty(mine)) return [];
  const repos = reposOf(mine);
  const sharing = entries.flatMap((other): OverlapHit[] => {
    const found = competes(entry, other) ? overlapWith(entry, mine, other) : null;
    return found !== null && !waitsOnIt(other) ? [{ holder: other, ...found }] : [];
  });
  // A run whose files are unread comes after those that share one: the wait names a shared file first. A run that claims its whole repository names no file for it to share, so it waits for no read.
  const unread = entries.flatMap((other): OverlapHit[] => {
    const found = mine.repoWide === null && competes(entry, other) && !sharing.some(({ holder }) => holder === other) ? unreadWith(other, repos) : null;
    return found !== null && !waitsOnIt(other) ? [{ holder: other, ...found }] : [];
  });
  return [...sharing, ...unread];
}

/** How a finished run's open pull request that has no files read yet holds a repository one of the repositories `repos` names: it holds it alone, and no path of it is named. Null when `holder` is no such run. PURE. */
function unreadWith(holder: ViewEntry, repos: ReadonlySet<string>): Overlapping | null {
  if (holder.phase !== "finished" || holder.pullFiles !== undefined) return null;
  const pull = openPulls(holder).find(({ repo }) => repo !== undefined && repos.has(repo));
  return pull === undefined ? null : { repo: pull.repo ?? "", wait: { key: holder.ticket.key, pull: parsePull(pull.url)?.number ?? null, path: null, overlaps: [] } };
}

/**
 * Why a queued run waits, for a file or a repository it shares with a run already held in it (see {@link holds}), or null when it waits on none. A run is not held by one of whose blockers it is or that is one of its blockers, since those
 * are sequenced on purpose (`waitsOn`, `stackedOn`). Tickets planned together are worked as separate runs, and are held against each other like any others. A review round, a conflict round and a planning run are never held.
 * What a run claims is {@link claimOf}: its plan's paths, else its open pull requests' files, else its ticket's Region, else its whole repository; a run with no repository known claims nothing.
 * OVERLAP MEANS STACK, NOT WAIT (A11-374): a run that overlaps a run it can stack on ({@link overlapStackOf}) waits for none, and starts at once on the most recently updated one's branch. It waits only while no run it overlaps has a branch to
 * build on, and then `unpushed` says so. A held run whose open pull request's files are not read yet holds its repository's paths, since they may share one (A11-125). The first run that overlaps holds it, and every path the two share is
 * named in `overlaps` (A11-212). `entries` is the whole queue, or the queue with the runs a pass has just chosen counted as starting, so a batch of starts keeps to one another. PURE.
 */
export function overlapWait(entry: ViewEntry, entries: readonly ViewEntry[]): OverlapWait | null {
  const [first] = blockingHits(entry, overlapHits(entry, entries));
  if (first === undefined) return null;
  // The run waits for a branch to build on only where it could stack on one: its repository is known and is the overlap's, and the run it overlaps has a branch to push.
  const pushable = repoOf(entry) === first.repo && first.holder.ticket.branch !== undefined;
  return pushable ? { ...first.wait, unpushed: true } : first.wait;
}

/**
 * The keys of every run whose footprint a queued run contests, whether or not that run waits on the queued run's ticket (A11-272): the hold {@link overlapWait} would find without its exemption for a holder that waits
 * on the ticket, and every such holder, not the first. The wait cycles read this (`wait-cycles.ts`): with the exemption, the hold that makes a run and the ticket it waits on wait on each other is gone, and the cycle
 * with it. A run held only because a pull request's files are not read yet is not counted: that is a hold on a finished run, which waits on nothing. PURE.
 */
export function overlapHolders(entry: ViewEntry, entries: readonly ViewEntry[]): string[] {
  const shared = rawOverlapHits(entry, entries).filter(({ wait }) => wait.path !== null || wait.repoWide !== undefined);
  return blockingHits(entry, shared).map(({ holder }) => holder.ticket.key);
}

/**
 * The paths every other queued or running ticket holds, as a planner is shown them (A11-212): for each run that holds its footprint (`running`, or `open pull request`) that footprint, and for each queued run that
 * contests paths the ones it contests (`queued`). A run is left out when it is one of `selves` or sequenced on purpose with one of them (its blockers, and the runs it blocks, see {@link sequenced}), and so is a run that holds
 * nothing. `selves` is the ticket being planned, or every ticket of the batch being planned. PURE.
 */
export function heldClaims(entries: readonly ViewEntry[], selves: readonly ViewEntry[]): HeldClaim[] {
  const keys = new Set(selves.map(({ ticket }) => ticket.key));
  return entries.filter((other) => !keys.has(other.ticket.key) && !selves.some((self) => sequenced(self, other))).flatMap((other) => {
    const paths = holds(other) ? holderClaimOf(other).paths : claimOf(other).paths;
    return paths.length === 0 ? [] : [{ key: other.ticket.key, state: claimState(other), paths }];
  });
}

/** Why a run holds paths a planner is shown: it is `running`, it has an `open pull request`, or it is still `queued` and contests them. PURE. */
function claimState(run: ViewEntry): string {
  if (run.phase === "starting" || run.phase === "running") return "running";
  return holds(run) ? "open pull request" : "queued";
}

/**
 * What the board says about a queued run that has paths declared, when a run that holds its repository has a pull request whose list of files was
 * cut short (A11-117): each such pull request, as "A11-98 #12 lists only part of its changed files, so a clash in the rest shows only as a conflict
 * on the pull request". It says what is unknown and does not hold the run, so it is never worded as a wait; null when there is none. PURE.
 */
export function cutListNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const mine = claimOf(entry);
  if (isEmpty(mine)) return null;
  const repos = reposOf(mine);
  const notes = entries.filter((other) => competes(entry, other)).flatMap((other) => openPulls(other)
    .filter(({ url, repo }) => repo !== undefined && repos.has(repo) && (other.pullFiles?.[url] ?? []).includes(""))
    .map(({ url }) => `${other.ticket.key} #${parsePull(url)?.number ?? url} lists only part of its changed files, so a clash in the rest shows only as a conflict on the pull request.`));
  return notes.length === 0 ? null : notes.join(" ");
}
