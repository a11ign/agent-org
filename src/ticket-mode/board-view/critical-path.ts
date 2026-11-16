// @ts-check
// module: the critical path of the runs on the board (A11-442) -- in each set of runs joined by their blockers, the longest chain of runs still to finish, which decides when the set finishes
//
// A BATCH'S ORDER BECOMES BLOCKERS. The board writes a planned batch's `order.json` to the tracker as blockers (`batch-order.ts`), and a run that starts alone leaves its batch, so the
// blockers are what still joins a batch's runs once they start. The path is read from them: each run's blockers that it waits on or is stacked on, as the board's own `waitsOn` and `stackedOn` read them, that are runs still
// to finish on the board, each ticket's newest run alone. A run that is Completed, Cancelled or Checked has nothing left to decide, a run on a cycle of blockers is left to the cycle's own note, and a blocker the board holds no run for is not drawn. A chain of one run is no path: a run with nothing before or after it is not marked.
// PURE, and it uses no Node API, since the Runs page runs it in the browser.
import { runStatus, stackedOn, waitsOn } from "./pull-status-and-notes.ts";
import { stackWaitNote } from "./stack-wait.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

/** The statuses of a run with nothing left to do: it holds up no other run. Checked found nothing to change. */
const OVER: ReadonlySet<string> = new Set(["completed", "cancelled", "checked"]);

/** The fewest runs a chain needs to be a path: a run alone decides nothing beyond itself. */
const SHORTEST_PATH = 2;

/** The edges among the runs still to finish: the keys each waits on (`after`) and the keys that wait on each (`before`), in key order. */
type Graph = Readonly<{ keys: readonly string[]; after: ReadonlyMap<string, readonly string[]>; before: ReadonlyMap<string, readonly string[]> }>;

/** Whether `entry` was queued no earlier than `other`: a run with no time reads as queued first. */
const queuedNoEarlier = (entry: ViewEntry, other: ViewEntry): boolean => (entry.queuedAt ?? 0) >= (other.queuedAt ?? 0);

/** Each ticket's newest run, by key: an older run of the ticket (one that crashed or failed before it was queued again) stands for nothing on the path. */
function newestRuns(entries: readonly ViewEntry[]): ReadonlyMap<string, ViewEntry> {
  const newest = new Map<string, ViewEntry>();
  for (const entry of entries) {
    const known = newest.get(entry.ticket.key);
    if (known === undefined || queuedNoEarlier(entry, known)) newest.set(entry.ticket.key, entry);
  }
  return newest;
}

/**
 * The keys of the runs in `open` that `entry` cannot finish before, in key order, read with the board's own rules: the blockers it waits on (`waitsOn`, which drops a done or canceled one and keeps
 * one it was stopped for until that wait ends), the blockers it starts stacked on (`stackedOn`), and the run its open pull request is built on while that pull request still waits on it
 * (`stackWaitNote`). A stacked run is not held from starting, but its pull request merges only after its base's, so its base still decides when the set finishes.
 */
function blockersIn(entry: ViewEntry, entries: readonly ViewEntry[], open: ReadonlySet<string>): string[] {
  const built = entry.stackBase !== undefined && stackWaitNote(entry, entries) !== null ? [entry.stackBase.key] : [];
  const keys = [...waitsOn(entry, entries), ...stackedOn(entry, entries)].map(({ key }) => key).concat(built);
  return [...new Set(keys)].filter((key) => key !== entry.ticket.key && open.has(key)).sort();
}

/** The keys among `waits` (each key to the keys it waits on) that lie on a cycle: a key that its own waits lead back to. `wait-cycles.ts` reports such a cycle, and its runs are on no path. */
function onCycles(waits: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const leadsBack = (start: string): boolean => {
    const seen = new Set<string>();
    const next = [...(waits.get(start) ?? [])];
    for (let key = next.pop(); key !== undefined; key = next.pop()) {
      if (key === start) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(...(waits.get(key) ?? []));
    }
    return false;
  };
  return new Set([...waits.keys()].filter(leadsBack));
}

/** The runs still to finish on the board, each ticket's newest alone and none on a cycle of blockers, and the blockers between them. */
function graphOf(entries: readonly ViewEntry[]): Graph {
  const runs = [...newestRuns(entries).values()].filter((entry) => !OVER.has(runStatus(entry, entries)));
  const open = new Set(runs.map(({ ticket }) => ticket.key));
  const waits = new Map(runs.map((entry) => [entry.ticket.key, blockersIn(entry, entries, open)]));
  const cycled = onCycles(waits);
  const keys = [...open].filter((key) => !cycled.has(key)).sort();
  const after = new Map(keys.map((key) => [key, (waits.get(key) ?? []).filter((blocker) => !cycled.has(blocker))]));
  const before = new Map(keys.map((key) => [key, keys.filter((other) => after.get(other)?.includes(key))]));
  return { keys, after, before };
}

/**
 * The longest chain of runs that ends at each key, stepping back along `next` (from a key to the keys just before it in a chain), with the run itself last. A tie goes to the first in key order. The graph has
 * no cycle (`graphOf` leaves its runs out), so each chain is a run's own, whichever key the walk starts from.
 */
function longestChains(keys: readonly string[], next: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, readonly string[]> {
  const chains = new Map<string, readonly string[]>();
  const chainOf = (key: string): readonly string[] => {
    const known = chains.get(key);
    if (known !== undefined) return known;
    let best: readonly string[] = [];
    for (const other of next.get(key) ?? []) {
      const chain = chainOf(other);
      if (chain.length > best.length) best = chain;
    }
    const chain = [...best, key];
    chains.set(key, chain);
    return chain;
  };
  for (const key of keys) chainOf(key);
  return chains;
}

/** The sets of keys joined by an edge either way, as the size of the longest chain in each key's set. */
function longestBySet(graph: Graph, longest: (key: string) => number): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  for (const start of graph.keys) {
    if (sizes.has(start)) continue;
    const members = new Set([start]);
    for (const key of members) for (const other of [...(graph.after.get(key) ?? []), ...(graph.before.get(key) ?? [])]) members.add(other);
    const size = Math.max(...[...members].map(longest));
    for (const key of members) sizes.set(key, size);
  }
  return sizes;
}

/** The chain through a run: the longest chain up to it (`upTo`, the run last), then the longest on from it (`onFrom`, the run last), first run first. */
const throughRun = (upTo: readonly string[], onFrom: readonly string[]): readonly string[] => [...upTo, ...[...onFrom].reverse().slice(1)];

/**
 * The critical path through each run that is on one, by its key: the longest chain of runs still to finish in the set of runs its blockers join it to, first run first. A run on a cycle of blockers is on none. A run is on
 * it when the longest chain through it is as long as the longest in its set, and that set's longest chain has two runs or more. Where chains tie, each run on one is on the path,
 * and the chain given for it is the one through it. A run on no path has no entry. PURE.
 */
export function criticalPaths(entries: readonly ViewEntry[]): ReadonlyMap<string, readonly string[]> {
  const graph = graphOf(entries);
  const upTo = longestChains(graph.keys, graph.after);
  const onFrom = longestChains(graph.keys, graph.before);
  const chains = new Map(graph.keys.map((key) => [key, throughRun(upTo.get(key) ?? [], onFrom.get(key) ?? [])]));
  const longest = longestBySet(graph, (key) => chains.get(key)?.length ?? 0);
  return new Map(graph.keys.flatMap((key) => {
    const chain = chains.get(key) ?? [];
    return chain.length >= SHORTEST_PATH && chain.length === longest.get(key) ? [[key, chain] as const] : [];
  }));
}

/** The paths of each queue read, kept so a page of notes works them out once per read (each read of the queue is a new entries array, so a stale one is never reused). */
const pathsByRead = new WeakMap<readonly ViewEntry[], ReadonlyMap<string, readonly string[]>>();

/** The line a run on the critical path shows, such as "On the critical path: A11-500 → A11-501 → A11-502", or null when it is on none. Its answer depends on its arguments alone; the paths are worked out once per queue read. */
export function criticalPathNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  let paths = pathsByRead.get(entries);
  if (paths === undefined) {
    paths = criticalPaths(entries);
    pathsByRead.set(entries, paths);
  }
  const chain = newestRuns(entries).get(entry.ticket.key) === entry ? paths.get(entry.ticket.key) : undefined;
  return chain === undefined ? null : `On the critical path: ${chain.join(" → ")}`;
}
