// @ts-check
// module: the board's wait cycles (A11-272) -- tickets that wait on each other through blockers, declared waits and the files a run holds, found as one graph so a deadlock nothing else could see is named
//
// ON 2026-10-25 A11-231's run waited on A11-229 while A11-229 was held behind A11-231's files: two waits that each looked fine alone. One node is a ticket on the board, and an edge A -> B says A cannot go on until B does:
//   `blocked-by`  A is queued and a ticket that may still hold it back is B (`waitsOn`);
//   `files`       A is queued and B holds paths A contests, counted WITHOUT the exemption a holder that waits on A's ticket gets (`overlapHolders`), so the hold the exemption lifts is still seen;
//   `waits-on`    A is live and its idle worker declared a wait on B, a ticket or a pull request B's run has open (`declaredWaits`).
// A fleet job and a CI run name no ticket and add no edge. A cycle is a strongly connected component of two or more tickets. PURE. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.
import { overlapHolders } from "./overlap-hold.ts";
import { waitsOn } from "./pull-status-and-notes.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";
import { declaredWaits } from "./waits-on.ts";

/** Why one ticket cannot go on until another does. */
export type WaitEdgeKind = "blocked-by" | "files" | "waits-on";

/** `from` cannot go on until `to` does, for the reason `kind` says. */
export type WaitEdge = Readonly<{ from: string; to: string; kind: WaitEdgeKind }>;

/**
 * Tickets that wait on each other: their keys sorted (`keys`), one loop through them that starts at the smallest key (`loop`, such as `A11-229 → A11-231 → A11-229`), every edge between them (`edges`), and an `id`, the
 * keys joined by commas. The id leaves the kinds out, so a cycle the board breaks in part is still the same cycle.
 */
export type WaitCycle = Readonly<{ id: string; keys: readonly string[]; loop: readonly string[]; edges: readonly WaitEdge[] }>;

/** Every edge between tickets on the board, each once. */
function edgesOf(entries: readonly ViewEntry[]): WaitEdge[] {
  const onBoard = new Set(entries.map(({ ticket }) => ticket.key));
  const found = new Map<string, WaitEdge>();
  const add = (from: string, to: string, kind: WaitEdgeKind): void => {
    if (from !== to && onBoard.has(to)) found.set(`${from}\0${to}\0${kind}`, { from, to, kind });
  };
  for (const entry of entries) {
    const from = entry.ticket.key;
    if (entry.phase !== "queued") continue;
    for (const { key } of waitsOn(entry, entries)) add(from, key, "blocked-by");
    for (const key of overlapHolders(entry, entries)) add(from, key, "files");
  }
  for (const [from, keys] of declaredWaits(entries)) for (const key of keys) add(from, key, "waits-on");
  return [...found.values()];
}

/** The strongly connected components of the graph that hold two tickets or more, by Tarjan's walk. */
function componentsOf(edges: readonly WaitEdge[]): string[][] {
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) next.set(from, [...(next.get(from) ?? []), to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const open: string[] = [];
  const onOpen = new Set<string>();
  const found: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.get(node) ?? 0);
    open.push(node);
    onOpen.add(node);
    for (const to of next.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(to) ?? 0));
      } else if (onOpen.has(to)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(to) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const members: string[] = [];
    for (let member = open.pop(); member !== undefined; member = open.pop()) {
      onOpen.delete(member);
      members.push(member);
      if (member === node) break;
    }
    if (members.length > 1) found.push(members);
  };
  for (const node of next.keys()) if (!index.has(node)) visit(node);
  return found;
}

/** The shortest loop from `start` back to itself over `edges`, as the keys it passes with `start` at both ends. The edges are those of one component, so there is always one. */
function loopThrough(start: string, edges: readonly WaitEdge[]): string[] {
  const came = new Map<string, string>();
  const queue = [start];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const { to } of edges.filter(({ from }) => from === node)) {
      if (to === start) return [...pathTo(node, came), start];
      if (!came.has(to)) {
        came.set(to, node);
        queue.push(to);
      }
    }
  }
  return [start, start];
}

/** The keys from the start of a search to `node`, by the nodes each was reached from. */
function pathTo(node: string, came: ReadonlyMap<string, string>): string[] {
  const path = [node];
  for (let from = came.get(node); from !== undefined; from = came.get(from)) path.unshift(from);
  return path;
}

/** Where a ticket comes in a loop, so the edges of a cycle are worded in the order of its loop; a ticket the loop does not pass comes last. */
const along = (loop: readonly string[], key: string): number => (loop.includes(key) ? loop.indexOf(key) : loop.length);

/** The cycles last found for each queue, so a card asking of every row walks the board once. The queue is immutable, so its answer is too. */
const cyclesOf = new WeakMap<readonly ViewEntry[], readonly WaitCycle[]>();

/** Every wait cycle among the tickets on the board, the one with the smallest key first. Empty when there is none. PURE. */
export function waitCycles(entries: readonly ViewEntry[]): readonly WaitCycle[] {
  const known = cyclesOf.get(entries);
  if (known !== undefined) return known;
  const edges = edgesOf(entries);
  const cycles = componentsOf(edges).map((members): WaitCycle => {
    const keys = [...members].sort();
    const inside = new Set(keys);
    const between = edges.filter(({ from, to }) => inside.has(from) && inside.has(to));
    const loop = loopThrough(keys[0], between);
    return { id: keys.join(","), keys, loop, edges: between.sort((a, b) => along(loop, a.from) - along(loop, b.from) || (a.from + a.to + a.kind < b.from + b.to + b.kind ? -1 : 1)) };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  cyclesOf.set(entries, cycles);
  return cycles;
}

/** What one edge says, in words: `A11-229 is held behind A11-231's files`. */
function edgeWords({ from, to, kind }: WaitEdge): string {
  if (kind === "blocked-by") return `${from} is blocked by ${to}`;
  if (kind === "files") return `${from} is held behind ${to}'s files`;
  return `${from}'s worker waits on ${to}`;
}

/** The sentence the comment and the banner say of a cycle: its loop, then each edge in words. `Wait cycle A11-229 → A11-231 → A11-229: A11-229 is held behind A11-231's files; A11-231's worker waits on A11-229.` PURE. */
export const cycleSentence = (cycle: WaitCycle): string => `Wait cycle ${cycle.loop.join(" → ")}: ${cycle.edges.map(edgeWords).join("; ")}.`;

/** The line a card of a ticket in a wait cycle shows, `in a wait cycle: A11-229 → A11-231 → A11-229`, or null for a ticket in none. PURE. */
export function cycleNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const cycle = waitCycles(entries).find(({ keys }) => keys.includes(entry.ticket.key));
  return cycle === undefined ? null : `in a wait cycle: ${cycle.loop.join(" → ")}`;
}
