// @ts-check
// module: a row shelved by a pull request that closes a row waiting on it (a11ign/a11ign#4625)
//
// B4 shelves a ready row behind an open pull request that touches its files. When that pull request CLOSES a row, and that row waits (a native `blockedBy` edge, any number of hops) on the shelved
// one, the pull request cannot merge before the shelved row is done and the shelved row cannot be offered before the pull request is gone. Each hop is correct on its own, which is why the tick
// printed it as an ordinary shelving for 63+ minutes (control#32 closes #4575, which waits on #4514, which waits on #4516, which control#32 shelves). Nothing in the cycle clears itself.
//
// A LEAF: pure, no `corpus` import, and no knowledge of how a reason is worded. The caller (`blocking-impact.ts`) has already read the shelving's pull request and the rows it closes; this walks
// the edges it is handed. An edge the caller could not read is not an edge (absence is not proof, and a deadlock is only named when a path was actually read).

/** One shelving the gate computed, resolved to its pull request: the shelved row, the pull request's display name, and the rows its body declares it closes. */
export type Shelving = { shelved: number; pr: string; closes: number[] };
/** `path` runs from the row the pull request closes to the shelved row, each hop waiting on the next: `[4575, 4514, 4516]`. */
export type Deadlock = { shelved: number; pr: string; path: number[] };

/**
 * The shortest chain of waits from `from` to `to`, `from` first, or `null` when `from` does not wait on `to`. A visited set makes a cycle among the rows themselves end the walk.
 * @param {(row: number) => number[]} blockersOf the OPEN rows a row waits on
 */
function waitPath(from: number, to: number, blockersOf: (row: number) => number[]): number[] | null {
  const via = new Map<number, number | null>([[from, null]]);
  const queue = [from];
  for (const row of queue) {
    for (const blocker of blockersOf(row)) {
      if (via.has(blocker)) continue;
      via.set(blocker, row);
      if (blocker === to) return chainTo(to, via);
      queue.push(blocker);
    }
  }
  return null;
}

function chainTo(end: number, via: Map<number, number | null>): number[] {
  const chain = [end];
  for (let step = via.get(end); step !== null && step !== undefined; step = via.get(step)) chain.unshift(step);
  return chain;
}

/**
 * THE SHELVINGS WHOSE PULL REQUEST CLOSES A ROW THAT TRANSITIVELY WAITS ON THE SHELVED ROW. A pull request closing the shelved row itself is that row's own work (B4 exempts it), so it is never
 * named. One deadlock per shelved row, through the lowest-numbered closed row that leads back, so the line is the same on every tick.
 * @param {Shelving[]} shelvings @param {(row: number) => number[]} blockersOf
 */
export function deadlocksOf(shelvings: Shelving[], blockersOf: (row: number) => number[]): Deadlock[] {
  const found: Deadlock[] = [];
  for (const { shelved, pr, closes } of shelvings) {
    if (closes.includes(shelved)) continue;
    const paths = [...closes].sort((a, b) => a - b).map((closed) => waitPath(closed, shelved, blockersOf));
    const path = paths.find((candidate) => candidate !== null);
    if (path) found.push({ shelved, pr, path });
  }
  return found;
}

/** The tick's line: `blocking-impact: DEADLOCK #4516 is shelved by control#32, which closes #4575, which waits on #4514, which waits on #4516: no tick will clear it`. */
export function deadlockLine({ shelved, pr, path }: Deadlock): string {
  const [closed, ...waits] = path;
  return `blocking-impact: DEADLOCK #${shelved} is shelved by ${pr}, which closes #${closed}${waits.map((row) => `, which waits on #${row}`).join("")}: no tick will clear it`;
}
