// @ts-check
// module: the tickets a run waits on (A11-272) -- its blockers, the tickets its stopped run is queued behind, and the tickets and pull requests its worker declared a wait on, followed through the tickets those wait on
//
// One set of edge rules, shared by the overlap hold (a run never holds its files against a ticket it waits on, `overlap-hold.ts`) and the queue's hold of a stopped run (`waitsOn`). A fleet job and a CI run belong to
// no ticket on the board, so they add no edge. PURE. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.
import { isRoundOnOpenPull } from "./round-pulls.ts";
import { openPulls, pullsOf, type ViewBlocker, type ViewEntry } from "./view-types-and-filters.ts";

/**
 * The repository a run is planned for: the planner's, when its batch named one, else its project's (`project-repo.ts`). A planner's `null` falls back
 * to the project's, so a planner that names none does not suppress the default. PURE.
 */
export const repoOf = (entry: Pick<ViewEntry, "plannedRepo" | "projectRepo">): string | null => entry.plannedRepo ?? entry.projectRepo ?? null;

/**
 * A run's blockers: those the tracker last listed, then each ticket its stopped run is queued behind (`stoppedForBlocker`) that the list does not name yet, with the tracker's state last read of it ("unknown" before
 * any read). The board records the relation in the tracker as it stops the run, but the list is read later, and a tracker may not record it at all, so the stop's own record holds the run meanwhile. PURE.
 */
export function blockersOf(entry: ViewEntry): readonly ViewBlocker[] {
  const states = entry.stoppedForBlocker?.states;
  return [...stackBlockersOf(entry), ...unlistedStops(entry).map((key) => ({ key, state: states?.[key] ?? "unknown", status: "" }))];
}

/**
 * The blockers a run may be stacked on (A11-374): those the tracker last listed, and the run it was started stacked on because their files overlap (`overlapStack`), as a blocker that carries its branch, head and pull requests (read from `entries` where the run is on the queue), so that it passes
 * `stackBaseOf` and is never waited for. The tracker's own entry for it wins, when the tracker lists it. A run the board recorded no overlap stack for has its listed blockers alone. PURE.
 */
export function stackBlockersOf(entry: ViewEntry, entries: readonly ViewEntry[] = []): readonly ViewBlocker[] {
  const listed = entry.blockers ?? [];
  const stack = entry.overlapStack;
  if (stack === undefined || listed.some(({ key }) => key === stack.key)) return listed;
  const below = entries.find((other) => other.ticket.key === stack.key);
  // The state of its pull requests is the run's own where the run is on the queue: a base that has merged is done, as a listed blocker whose pull requests merged is. Otherwise it is the one recorded as the stack was made.
  const pulls = below !== undefined && pullsOf(below).length > 0 ? Object.fromEntries(pullsOf(below).map(({ url }) => [url, below.pullStates?.[url] ?? "open"])) : stack.url === null ? {} : { [stack.url]: "open" };
  return [...listed, { key: stack.key, state: "started", status: "", branch: stack.branch, ...(stack.head === null ? {} : { head: stack.head }), pulls }];
}

/**
 * The blockers a run is sequenced behind, which it waits for and which are never held against it (A11-298): all of {@link blockersOf}, except for a review round on an open pull request, which waits on none of its ticket's other
 * blockers (the pull request exists already) and so is sequenced behind only the tickets its worker waited on. PURE.
 */
export function sequencedBlockers(entry: ViewEntry): readonly ViewBlocker[] {
  const blockers = blockersOf(entry);
  return isRoundOnOpenPull(entry) ? blockers.filter((blocker) => isStoppedFor(entry, blocker)) : blockers;
}

/** The tickets a stopped run is queued behind that its blockers, as the tracker last listed them, do not name. PURE. */
export const unlistedStops = (entry: ViewEntry): string[] =>
  (entry.stoppedForBlocker?.keys ?? []).filter((key) => !(entry.blockers ?? []).some((blocker) => blocker.key === key));

/** The tracker's states that end a ticket wait, as its reading judges one (A11-245): `completed` finishes it and `canceled` fails it. */
const TICKET_WAIT_ENDS: ReadonlySet<string> = new Set(["completed", "canceled"]);

/** Whether the board stopped the run for a wait on this blocker (A11-272). PURE. */
export const isStoppedFor = (entry: ViewEntry, blocker: ViewBlocker): boolean => (entry.stoppedForBlocker?.keys ?? []).includes(blocker.key);

/**
 * Whether the wait a run was stopped for has ended for a blocker in the tracker's `state`: completed or canceled, as the wait's own reading judges it. Merged pull requests do not end it, as they let an ordinary
 * blocker go, since the worker asked for the ticket to be done: a run let go on a merge that leaves its ticket open would declare the same wait again, and be stopped again. PURE.
 */
export const ticketWaitEnded = (state: string): boolean => TICKET_WAIT_ENDS.has(state);

/** The tracker's states of a ticket whose work is over: a blocker in one is waited on no longer. */
const SETTLED_STATES: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);

/** Whether a blocker may still hold the run it blocks: the tracker has not settled it, and its pull requests have not all merged. PURE. */
function stillAhead({ state, pulls }: ViewBlocker): boolean {
  const states = Object.values(pulls ?? {});
  return !SETTLED_STATES.has(state) && !(states.includes("merged") && !states.includes("open"));
}

/** The ticket of each open pull request on the board: what {@link declaredIn} reads a pull request wait by, built once for a walk. */
type Board = Readonly<{ pullOwner: ReadonlyMap<string, string> }>;

function boardOf(entries: readonly ViewEntry[]): Board {
  return { pullOwner: new Map(entries.flatMap((entry) => openPulls(entry).map(({ url }): [string, string] => [url, entry.ticket.key]))) };
}

/**
 * The tickets a run's idle worker declared a wait on, or [] when it declared none: while the run is live and its worker sits idle in a declared wait (`working.waiting`), each ticket the wait names and the ticket whose
 * run has a pull request it names. A worker woken from its wait, or at work again, waits on none of those. The tickets of a wait are the wait's, so a fleet job and a CI run add none. PURE.
 */
function declaredIn(entry: ViewEntry, board: Board): string[] {
  const parked = (entry.phase === "starting" || entry.phase === "running") && entry.working?.waiting === true;
  if (!parked) return [];
  return (entry.working?.waits ?? []).flatMap((wait) => {
    if (wait.kind === "ticket") return [wait.key];
    const owner = wait.kind === "pullRequest" ? board.pullOwner.get(wait.url) : undefined;
    return owner === undefined ? [] : [owner];
  });
}

/** The tickets each ticket's idle worker declared a wait on ({@link declaredIn}), by ticket key, given every run on the board and read in one pass over it: what the wait cycles read (`wait-cycles.ts`) beside what the overlap hold reads. PURE. */
export function declaredWaits(entries: readonly ViewEntry[]): ReadonlyMap<string, readonly string[]> {
  const board = boardOf(entries);
  const declared = new Map<string, string[]>();
  for (const entry of entries) declared.set(entry.ticket.key, [...(declared.get(entry.ticket.key) ?? []), ...declaredIn(entry, board)]);
  return declared;
}

/** The tickets a run waits on directly: its blockers that may still hold it ({@link blockersOf}, {@link stillAhead}), then the tickets its worker declared a wait on ({@link declaredIn}). PURE. */
const directWaits = (entry: ViewEntry, board: Board): string[] => [...sequencedBlockers(entry).filter(stillAhead).map(({ key }) => key), ...declaredIn(entry, board)];

/**
 * The tickets whose runs wait on ticket `key`, directly ({@link directWaits}) or through the tickets those wait on, each once, and never `key` itself. One walk back from `key` over the board's waits, so a caller
 * that asks it of every holder of a run's paths walks the board once. PURE.
 */
export function waitersOn(key: string, entries: readonly ViewEntry[]): ReadonlySet<string> {
  const board = boardOf(entries);
  const waitedBy = new Map<string, string[]>();
  for (const entry of entries) {
    for (const target of directWaits(entry, board)) {
      const waiters = waitedBy.get(target) ?? [];
      waiters.push(entry.ticket.key);
      waitedBy.set(target, waiters);
    }
  }
  const found = new Set<string>();
  const toFollow = [...(waitedBy.get(key) ?? [])];
  for (let waiter = toFollow.pop(); waiter !== undefined; waiter = toFollow.pop()) {
    if (waiter === key || found.has(waiter)) continue;
    found.add(waiter);
    toFollow.push(...(waitedBy.get(waiter) ?? []));
  }
  return found;
}
