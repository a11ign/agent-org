// @ts-check
// module: the board's conflict rounds, and what they cost a run (A11-374) -- PURE
//
// A CONFLICT ROUND ANSWERS NO REVIEW, SO IT IS NOT ONE OF THE BOARD'S OWN ROUNDS. On 2026-10-28 six pull requests of one epic changed the same files, each merge put the rest into conflict, and A11-364 used up its rounds (`MAX_FEEDBACK_ROUNDS`) on
// conflicts alone. A round that only resolves a conflict with a base that other merges moved is not feedback that repeats, so it counts toward no cap. What it does count is itself, for each pull request (`conflictRounds`), so the run is told
// how often this one conflicted, and, from the 4th, which pull requests it keeps colliding with.
// TWO EXCEPTIONS BOUND THEM. A conflict at the same base as the pull request's last conflict round is the worker's own failure to resolve it, not churn from other merges, so it counts as a round of the board's own and reaches the cap. So does a conflict whose
// base is not known, since nothing then says other merges moved it: it counts as every conflict round did.
import { pullsOf } from "../board-view/view-types-and-filters.ts";
import { parsePull } from "../board-view/pull-url.ts";
import { roundsLeft } from "./queue-round-cap.ts";
import type { Entry, Queue } from "./queue-entries-and-outcomes.ts";

/** The conflict the board starts a round for on one pull request: the commit its base is at (null when not known), and the files the conflict touches when they were listed. */
export type ConflictAt = Readonly<{ base: string | null; files?: readonly string[] | null }>;

/** The conflicts a round answers, by the address of the pull request. */
export type ConflictOn = Readonly<Record<string, ConflictAt>>;

/** The conflict rounds from the 4th on one pull request name the pull requests it keeps colliding with: a conflict that "recurs more than 3 times". */
export const CONFLICT_RECURS_AFTER = 3;

/** Whether some pull request of `on` is in conflict at the same base as at its last conflict round (the worker's own failure to resolve it), or at a base that is not known: the round counts toward the cap. PURE. */
const isCounted = (entry: Entry, on: ConflictOn): boolean => Object.entries(on).some(([url, { base }]) => base === null || entry.conflictBase?.[url] === base);

/** Whether the board may start a conflict round on `entry` for `on`: always, unless it would count (see {@link isCounted}) and the board's own rounds are used up. PURE. */
export const conflictRoundLeft = (entry: Entry, on: ConflictOn): boolean => !isCounted(entry, on) || roundsLeft(entry);

/** The fields a conflict round writes on the run: each pull request's conflict count and base, and, only for a conflict at an unmoved or unknown base, one round of the board's own. PURE. */
export function conflictFields(entry: Entry, on: ConflictOn): Pick<Entry, "rounds" | "conflictRounds" | "conflictBase"> {
  const counts = { ...entry.conflictRounds };
  const bases = { ...entry.conflictBase };
  for (const [url, { base }] of Object.entries(on)) {
    counts[url] = (counts[url] ?? 0) + 1;
    if (base !== null) bases[url] = base;
  }
  return { rounds: (entry.rounds ?? 0) + (isCounted(entry, on) ? 1 : 0), conflictRounds: counts, conflictBase: bases };
}

/** A pull request's number with its hash, as the feedback names it, or its whole address for one that is no GitHub pull request. */
const numbered = (url: string): string => {
  const pull = parsePull(url);
  return pull === null ? url : `#${pull.number}`;
};

/** When a run last moved, as the queue holds it: the latest of when it finished, started and was queued. */
const updatedAt = (entry: Entry): number => Math.max(entry.finishedAt ?? 0, entry.startedAt ?? 0, entry.queuedAt ?? 0);

/** The other pull requests on the queue that change a file this one conflicts in, with those files: the pull request's own files stand in where the conflicting ones were not listed. Most recently updated run first. PURE. */
function collidingWith(queue: Queue, entry: Entry, url: string, at: ConflictAt): { label: string; files: string[]; at: number }[] {
  const mine = at.files ?? entry.pullFiles?.[url] ?? [];
  return queue.entries.filter((other) => other.ticket.key !== entry.ticket.key).flatMap((other) => pullsOf(other).flatMap((pull) => {
    const shared = (other.pullFiles?.[pull.url] ?? []).filter((file) => file !== "" && mine.includes(file));
    return shared.length === 0 ? [] : [{ label: `${other.ticket.key} ${numbered(pull.url)}`, files: shared, at: updatedAt(other) }];
  })).sort((a, b) => b.at - a.at);
}

/** The paragraph a pull request's 4th and later conflict round adds: which pull requests it keeps colliding with, and what to do about it. Empty where none is known. PURE. */
function keepsCollidingWith(queue: Queue, entry: Entry, url: string, at: ConflictAt, count: number): string {
  const colliding = collidingWith(queue, entry, url, at);
  const names = colliding.length === 0 ? "other pull requests that change the same files" : colliding.map(({ label, files }) => `${label} (${files.join(", ")})`).join("; ");
  const advice = colliding.length === 0 ? "" : ` Stack on the one most recently updated, ${colliding[0].label}, or merge its branch in, so this conflict is resolved once and not again with each merge.`;
  return `This pull request keeps colliding with ${names}: it has conflicted ${count} times.${advice}`;
}

/**
 * The feedback of a conflict round on `on`: a line for each pull request, "Conflict <n> on #<pr>:" where `<n>` is how often it has conflicted counting this round, then `feedback`, and, for each pull request on its 4th conflict or later, a paragraph naming the pull
 * requests it keeps colliding with. The round's reason in the run's log keeps that first line. PURE.
 */
export function conflictRoundFeedback(queue: Queue, entry: Entry, on: ConflictOn, feedback: string): string {
  const counted = Object.entries(on).map(([url, at]) => ({ url, at, count: (entry.conflictRounds?.[url] ?? 0) + 1 }));
  const head = `Conflict ${counted.map(({ url, count }) => `${count} on ${numbered(url)}`).join(", ")}:`;
  const recurring = counted.filter(({ count }) => count > CONFLICT_RECURS_AFTER).map(({ url, at, count }) => keepsCollidingWith(queue, entry, url, at, count));
  return [head, feedback, ...recurring.map((text) => `\n${text}`)].join("\n");
}
