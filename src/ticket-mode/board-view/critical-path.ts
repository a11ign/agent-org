// @ts-check
// module: the critical path of the runs on the board (A11-442) -- in each set of runs joined by their blockers, the longest chain of runs still to finish, which decides when the set finishes
//
// A BATCH'S ORDER BECOMES BLOCKERS. The board writes a planned batch's `order.json` to the tracker as blockers (`batch-order.ts`), and a run that starts alone leaves its batch, so the
// blockers are what still joins a batch's runs once they start. The path is read from them: each run's tracker-listed blockers that are runs still to finish on the board. A run that is
// Completed or Cancelled has nothing left to decide, and a blocker the board holds no run for is not drawn. A chain of one run is no path: a run with nothing before or after it is not marked.
// PURE, and it uses no Node API, since the Runs page runs it in the browser.
import { runStatus } from "./pull-status-and-notes.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

/** The statuses of a run with nothing left to do: it holds up no other run. */
const OVER: ReadonlySet<string> = new Set(["completed", "cancelled"]);

/** The fewest runs a chain needs to be a path: a run alone decides nothing beyond itself. */
const SHORTEST_PATH = 2;

/** The edges among the runs still to finish: the keys each waits on (`after`) and the keys that wait on each (`before`), in key order. */
type Graph = Readonly<{ keys: readonly string[]; after: ReadonlyMap<string, readonly string[]>; before: ReadonlyMap<string, readonly string[]> }>;

/** The keys of the runs in `open` that `entry` waits on: its tracker-listed blockers, once each, never itself, in key order. */
const blockersIn = (entry: ViewEntry, open: ReadonlySet<string>): string[] =>
  [...new Set((entry.blockers ?? []).map((blocker) => blocker.key))].filter((key) => key !== entry.ticket.key && open.has(key)).sort();

/** The runs still to finish on the board, and the blockers between them. */
function graphOf(entries: readonly ViewEntry[]): Graph {
  const keys = entries.filter((entry) => !OVER.has(runStatus(entry, entries))).map(({ ticket }) => ticket.key).sort();
  const open = new Set(keys);
  const after = new Map(keys.map((key) => [key, [] as string[]]));
  const before = new Map(keys.map((key) => [key, [] as string[]]));
  for (const entry of entries) {
    const key = entry.ticket.key;
    if (!open.has(key)) continue;
    for (const blocker of blockersIn(entry, open)) {
      after.get(key)?.push(blocker);
      before.get(blocker)?.push(key);
    }
  }
  for (const list of before.values()) list.sort();
  return { keys, after, before };
}

/**
 * The longest chain of runs that ends at each key, stepping back along `next` (from a key to the keys just before it in a chain), with the run itself last. A tie goes to the first in key order. A cycle
 * among blockers (`wait-cycles.ts` reports it) is cut where the walk meets it again, so it lengthens no chain.
 */
function longestChains(keys: readonly string[], next: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, readonly string[]> {
  const chains = new Map<string, readonly string[]>();
  const walking = new Set<string>();
  const chainOf = (key: string): readonly string[] => {
    const known = chains.get(key);
    if (known !== undefined) return known;
    walking.add(key);
    let best: readonly string[] = [];
    for (const other of next.get(key) ?? []) {
      if (walking.has(other)) continue;
      const chain = chainOf(other);
      if (chain.length > best.length) best = chain;
    }
    walking.delete(key);
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

/**
 * The chain through a run, from the longest chain up to it (`upTo`, the run last) and the longest on from it (`onFrom`, the run last), or none when the two meet again past the run: the
 * run is on a cycle of blockers, which `wait-cycles.ts` reports, and a chain that names a run twice is no path.
 */
function throughOnce(upTo: readonly string[], onFrom: readonly string[]): readonly string[] {
  const chain = [...upTo, ...[...onFrom].reverse().slice(1)];
  return new Set(chain).size === chain.length ? chain : [];
}

/**
 * The critical path through each run that is on one, by its key: the longest chain of runs still to finish in the set of runs its blockers join it to, first run first. A run is on
 * it when the longest chain through it is as long as the longest in its set, and that set's longest chain has two runs or more. Where chains tie, each run on one is on the path,
 * and the chain given for it is the one through it. A run on no path has no entry. PURE.
 */
export function criticalPaths(entries: readonly ViewEntry[]): ReadonlyMap<string, readonly string[]> {
  const graph = graphOf(entries);
  const upTo = longestChains(graph.keys, graph.after);
  const onFrom = longestChains(graph.keys, graph.before);
  const chains = new Map(graph.keys.map((key) => [key, throughOnce(upTo.get(key) ?? [], onFrom.get(key) ?? [])]));
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
  const chain = paths.get(entry.ticket.key);
  return chain === undefined ? null : `On the critical path: ${chain.join(" → ")}`;
}
