// @ts-check
// module: the board's overlap hold -- which paths a run claims, which of them two runs share, and what a planner is shown of the paths other runs hold (A11-125, A11-175, A11-212)
//
// Split from `pull-status-and-notes.ts`, whose public API is at the 50 members a module may export: `waitNote` there words the hold this file decides, and the queue (`queue.ts`) starts a run only when
// `overlapWait` finds none. PURE. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.
import { SCAFFOLD_DIRS } from "../../scaffold-dirs.ts";
import type { HeldClaim } from "../path-claims.ts";
import { currentStepOf, currentStepPaths } from "./plan-steps.ts";
import { parsePull } from "./pull-url.ts";
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";
import { blockersOf, waitersOn } from "./waits-on.ts";

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
 * A run's footprint: the paths its plan says its work touches (for a run on a step of a multi-step plan, that step's, see {@link heldPlanPaths}), and the files each of its open pull requests changes,
 * each in the repository that pull request is in, without the scaffolding (see {@link countsForOverlap}). A pull request whose list was cut short holds the files listed, and no
 * others: the files past those are unknown, not untouched, and an empty name marks them. PURE.
 */
export function footprintOf(entry: ViewEntry): string[] {
  const changed = openPulls(entry).flatMap(({ url, repo }) => (repo === undefined ? [] : (entry.pullFiles?.[url] ?? []).map((file) => `${repo}:${file}`)));
  return [...heldPlanPaths(entry), ...changed].filter(countsForOverlap);
}

/** The tracker's states that end a ticket's work: a run on such a ticket is done, or was dropped, and holds nothing once it is not live. */
const ENDED_TICKETS: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);

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
  blockersOf(entry).some(({ key }) => key === other.ticket.key) || blockersOf(other).some(({ key }) => key === entry.ticket.key);

/**
 * The question whether a holder waits on a queued run's ticket through more than a blocker of its own: a ticket its idle worker declared a wait on, or one reached through the tickets those wait on ({@link waitersOn},
 * A11-272). A run parked on a wait would otherwise hold its files against the very ticket it waits for. The board is walked once, and only when a path is found shared. PURE.
 */
function waitsOnTicketOf(entry: ViewEntry, entries: readonly ViewEntry[]): (holder: ViewEntry) => boolean {
  let waiters: ReadonlySet<string> | null = null;
  return (holder) => (waiters ??= waitersOn(entry.ticket.key, entries)).has(holder.ticket.key);
}

/**
 * The counted paths a queued run contests: none for a run that holds no path (see {@link pathless}), or was started anyway past its overlap
 * (`overlapOverride`); for a queued step of a multi-step plan, its step's paths when the plan lists any for it, and not the whole plan's (A11-175). PURE.
 */
const contested = (entry: ViewEntry): string[] => pathless(entry) || entry.overlapOverride !== undefined ? [] : (currentStepPaths(entry) ?? entry.paths ?? []).filter(countsForOverlap);

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
 * path both touch with whose directory claim made it, or null and none for a run whose pull request's files are not read yet, so that the run is held by its repository alone (A11-125).
 */
export type OverlapWait = Readonly<{ key: string; pull: string | null; path: string | null; overlaps: readonly Overlap[] }>;

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

/**
 * Why a queued run waits, for a path it shares with a run already held in its repository (see {@link holds}), or null when it waits on none. A
 * run is not held by one of whose blockers it is or that is one of its blockers, since those are sequenced on purpose (`waitsOn`, `stackedOn`).
 * Tickets planned together are worked as separate runs, and are held against each other like any others. A review round, a conflict round and a
 * planning run are never held, and nor is a run with no paths declared, or one whose paths are only scaffolding (see {@link footprintOf}).
 * A held run whose open pull request's files are not read yet holds its repository's paths, since they may share one: it waits until a watch reads
 * them (A11-125). The first run that overlaps holds it, and every path the two share is named in `overlaps` (A11-212). `entries` is the whole queue, or the queue with the runs a pass has just chosen counted as starting, so a batch of starts keeps to one another. PURE.
 */
export function overlapWait(entry: ViewEntry, entries: readonly ViewEntry[]): OverlapWait | null {
  const mine = contested(entry);
  if (mine.length === 0) return null;
  const waitsOnIt = waitsOnTicketOf(entry, entries);
  for (const other of entries) {
    if (!competes(entry, other)) continue;
    const held = footprintOf(other);
    const path = mine.find((own) => held.some((theirs) => pathsOverlap(own, theirs)));
    if (path !== undefined && !waitsOnIt(other)) return { key: other.ticket.key, pull: parsePull(openPulls(other)[0]?.url ?? "")?.number ?? null, path: repoPath(path)[1], overlaps: overlapsBetween(mine, held, { waiting: entry.ticket.key, holder: other.ticket.key }) };
  }
  return unreadWait(entry, entries, { mine, waitsOnIt });
}

/**
 * The keys of every run whose footprint a queued run contests, whether or not that run waits on the queued run's ticket (A11-272): the hold {@link overlapWait} would find without its exemption for a holder that waits
 * on the ticket, and every such holder, not the first. The wait cycles read this (`wait-cycles.ts`): with the exemption, the hold that makes a run and the ticket it waits on wait on each other is gone, and the cycle
 * with it. A run held only because a pull request's files are not read yet is not counted: that is a hold on a finished run, which waits on nothing. PURE.
 */
export function overlapHolders(entry: ViewEntry, entries: readonly ViewEntry[]): string[] {
  const mine = contested(entry);
  if (mine.length === 0) return [];
  return entries.filter((other) => competes(entry, other) && footprintOf(other).some((held) => mine.some((own) => pathsOverlap(own, held)))).map(({ ticket }) => ticket.key);
}

/**
 * The paths every other queued or running ticket holds, as a planner is shown them (A11-212): for each run that holds its footprint (`running`, or `open pull request`) that footprint, and for each queued run that
 * contests paths the ones it contests (`queued`). A run is left out when it is one of `selves` or sequenced on purpose with one of them (its blockers, and the runs it blocks, see {@link sequenced}), and so is a run that holds
 * nothing. `selves` is the ticket being planned, or every ticket of the batch being planned. PURE.
 */
export function heldClaims(entries: readonly ViewEntry[], selves: readonly ViewEntry[]): HeldClaim[] {
  const keys = new Set(selves.map(({ ticket }) => ticket.key));
  return entries.filter((other) => !keys.has(other.ticket.key) && !selves.some((self) => sequenced(self, other))).flatMap((other) => {
    const paths = holds(other) ? footprintOf(other) : contested(other);
    return paths.length === 0 ? [] : [{ key: other.ticket.key, state: claimState(other), paths }];
  });
}

/** Why a run holds paths a planner is shown: it is `running`, it has an `open pull request`, or it is still `queued` and contests them. PURE. */
function claimState(run: ViewEntry): string {
  if (run.phase === "starting" || run.phase === "running") return "running";
  return holds(run) ? "open pull request" : "queued";
}

/** What a queued run contests: its counted paths, and whether a holder waits on its ticket, which exempts that holder (see {@link waitsOnTicketOf}). */
type Contest = Readonly<{ mine: readonly string[]; waitsOnIt: (holder: ViewEntry) => boolean }>;

/**
 * The run a queued run waits on because a held run's pull request has no files read yet (`pullFiles` unset) and lies in a repository one of the queued
 * run's paths names: the files it may change are unknown, so they may share one. Null when no such run holds it. PURE.
 */
function unreadWait(entry: ViewEntry, entries: readonly ViewEntry[], { mine, waitsOnIt }: Contest): OverlapWait | null {
  const repos = new Set(mine.map((path) => repoPath(path)[0]));
  for (const other of entries) {
    if (!competes(entry, other) || other.phase !== "finished" || other.pullFiles !== undefined) continue;
    const pull = openPulls(other).find(({ repo }) => repo !== undefined && repos.has(repo));
    if (pull !== undefined && !waitsOnIt(other)) return { key: other.ticket.key, pull: parsePull(pull.url)?.number ?? null, path: null, overlaps: [] };
  }
  return null;
}

/**
 * What the board says about a queued run that has paths declared, when a run that holds its repository has a pull request whose list of files was
 * cut short (A11-117): each such pull request, as "A11-98 #12 lists only part of its changed files, so a clash in the rest shows only as a conflict
 * on the pull request". It says what is unknown and does not hold the run, so it is never worded as a wait; null when there is none. PURE.
 */
export function cutListNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const mine = contested(entry);
  if (mine.length === 0) return null;
  const repos = new Set(mine.map((path) => repoPath(path)[0]));
  const notes = entries.filter((other) => competes(entry, other)).flatMap((other) => openPulls(other)
    .filter(({ url, repo }) => repo !== undefined && repos.has(repo) && (other.pullFiles?.[url] ?? []).includes(""))
    .map(({ url }) => `${other.ticket.key} #${parsePull(url)?.number ?? url} lists only part of its changed files, so a clash in the rest shows only as a conflict on the pull request.`));
  return notes.length === 0 ? null : notes.join(" ");
}
