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

/** A path as prose: `#4575, which waits on #4514, which waits on #4516`. */
export function pathText(path: number[]): string {
  const [closed, ...waits] = path;
  return `#${closed}${waits.map((row) => `, which waits on #${row}`).join("")}`;
}

/** The tick's line: `blocking-impact: DEADLOCK #4516 is shelved by control#32, which closes #4575, which waits on #4514, which waits on #4516: no tick will clear it`. */
export function deadlockLine({ shelved, pr, path }: Deadlock): string {
  return `blocking-impact: DEADLOCK #${shelved} is shelved by ${pr}, which closes ${pathText(path)}: no tick will clear it`;
}

// A LINE THAT PRINTS EVERY TICK IS NOT A RESOLUTION (agent-org#5009): agent-org#878 stood red for 1h45m in exactly this cycle, its worker waiting on #884 and B4 shelving #884 behind #878, and the gate printed
// both halves each tick and joined them to no one. What follows is the cycle's life across ticks: a cycle is put to its holder ONCE, put to the escalation on the NEXT tick it is still read, and counted when
// it is no longer read. The walker above is unchanged; this only remembers which cycles it found before.

/** A cycle as the tick read it. `repo` is the keyed tracker the shelved row is in (absent for the home tracker's); `holder` is the session holding the pull request, `null` when none is known; `files` is the overlap B4 named, when its reason did. */
export type Sighting = Deadlock & { repo?: string; holder: string | null; files?: string };
/** A cycle standing across ticks. `woke` is the session its first sighting was put to (`null` when nobody was known to hold the pull request, which goes straight to the escalation, so `escalated` starts true). */
export type DeadlockEpisode = { shelved: number; pr: string; repo?: string; since: number; woke: string | null; escalated: boolean };
/** A cycle that was read on one tick and not on the next. `minutes` runs from the first tick that read it to the first that did not, so it can exceed the time it stood by up to one tick. */
export type BrokenDeadlock = { key: string; shelved: number; pr: string; since: number; minutes: number; escalated: boolean };
export type DeadlockMove =
  | { kind: "wake-holder"; deadlock: Sighting; holder: string; since: number }
  | { kind: "escalate"; deadlock: Sighting; woke: string | null; since: number };

const MS_PER_MINUTE = 60 * 1000;

/** A cycle's identity across ticks: the tracker its shelved row is in (two trackers' row numbers are different rows) and the pair that shelves. */
export const deadlockKey = ({ repo, shelved, pr }: Pick<Sighting, "repo" | "shelved" | "pr">): string => `${repo ?? ""}#${shelved}<-${pr}`;

/**
 * THE NEXT EPISODES, AND WHAT THIS TICK MUST DO ABOUT THEM. A cycle not read last tick is put to its holder. One read last tick and again now has had its one wake and is escalated, once. One that was
 * read last tick and is not read now has been broken and is returned for the record. A cycle named twice in one tick is one cycle.
 * @param {Record<string, DeadlockEpisode>} previous the last tick's episodes, `{}` for none or for a tick after a gap in observation
 */
export function advanceDeadlocks(previous: Record<string, DeadlockEpisode>, seen: Sighting[], now: number): { episodes: Record<string, DeadlockEpisode>; moves: DeadlockMove[]; broken: BrokenDeadlock[] } {
  const episodes: Record<string, DeadlockEpisode> = {};
  const moves: DeadlockMove[] = [];
  for (const deadlock of seen) {
    const key = deadlockKey(deadlock);
    if (Object.hasOwn(episodes, key)) continue;
    const prior = Object.hasOwn(previous, key) ? previous[key] : undefined;
    const { shelved, pr, repo, holder } = deadlock;
    const identity = { shelved, pr, ...(repo === undefined ? {} : { repo }) };
    if (prior === undefined) {
      episodes[key] = { ...identity, since: now, woke: holder, escalated: holder === null };
      moves.push(holder === null ? { kind: "escalate", deadlock, woke: null, since: now } : { kind: "wake-holder", deadlock, holder, since: now });
    } else if (prior.escalated) {
      episodes[key] = prior;
    } else {
      episodes[key] = { ...prior, escalated: true };
      moves.push({ kind: "escalate", deadlock, woke: prior.woke, since: prior.since });
    }
  }
  const broken = Object.entries(previous).filter(([key]) => !Object.hasOwn(episodes, key))
    .map(([key, { shelved, pr, since, escalated }]) => ({ key, shelved, pr, since, minutes: Math.max(0, Math.round((now - since) / MS_PER_MINUTE)), escalated }));
  return { episodes, moves, broken };
}
