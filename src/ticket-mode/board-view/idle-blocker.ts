// @ts-check
// module: a ticket that holds queued runs back, is In Progress and has no run (A11-347) -- what the board does about it. PURE.
//
// ON 2026-10-26 A11-253 SAT IN PROGRESS FOR 15 HOURS with all ten of its pull requests merged and no run, and held A11-254 and A11-256 the whole time: the board said "has no run on the board, so nothing is working on it" and
// did nothing. A queued run's blocker that the tracker holds In Progress while the board has no run for it, not even a finished one, has two ways out, and the board takes the one the tracker's own facts name:
//  - every pull request it links has merged and one of them closes it: the work is over and the tracker did not complete the ticket (its workflow completes on a merge only some of the time), so the board COMPLETES it;
//  - otherwise work remains (a `Partial:` merge with nothing queued to follow it, a pull request still open, a ticket with no pull request yet): the board QUEUES it, to run on the saved choice.
// The bodies of its merged pull requests are read first (`blockersDeclared`, recorded on the runs it holds back), since a body that says `Partial:` leaves the ticket open. A blocker in any other state is a person's: a
// ticket nobody started is not taken up on a dependent's word. The sweep that acts (`idle-blockers.ts`) and the sentence the board says of the wait (`long-waits.ts`) read this one decision; the sweep alone knows what the tracker
// says of who holds the ticket, so it may leave one the decision names (`idle-blockers.ts`).
import { waitsOn } from "./pull-status-and-notes.ts";
import { sequencedBlockers } from "./waits-on.ts";
import type { ViewBlocker, ViewEntry } from "./view-types-and-filters.ts";

/** What the board does about an idle blocker: `complete` its ticket, `queue` it, or `read` the bodies of its merged pull requests first, which it does before it does either. */
export type IdleAction = "complete" | "queue" | "read";

/** A ticket In Progress with no run that holds queued runs back: what the board does about it, the tickets it blocks, how many pull requests it links, and the ones that have merged. */
export type IdleBlocker = Readonly<{ key: string; action: IdleAction; blocks: readonly string[]; pulls: number; merged: readonly string[] }>;

/** The tracker's type for a state work has started in: In Progress and the states like it. */
export const STARTED = "started";

/** The queued runs that are sequenced behind the ticket `key`, whether or not it still holds them. */
const waitersOf = (key: string, entries: readonly ViewEntry[]): ViewEntry[] =>
  entries.filter((entry) => entry.phase === "queued" && sequencedBlockers(entry).some((blocker) => blocker.key === key));

/** What the merged pull requests of `blocker` declared of its ticket, read from the runs it holds back; a pull request none of them has recorded is unread (undefined). PURE. */
function declaredBy(blocker: ViewBlocker, waiters: readonly ViewEntry[]) {
  const merged = Object.entries(blocker.pulls ?? {}).filter(([, state]) => state === "merged").map(([url]) => url);
  return merged.map((url) => waiters.map((waiter) => waiter.blockersDeclared?.[url]).find((declared) => declared !== undefined));
}

/** The action for a blocker the board has no run for, or null when it takes none. */
function actionFor(blocker: ViewBlocker, waiters: readonly ViewEntry[], entries: readonly ViewEntry[]): IdleAction | null {
  const states = Object.values(blocker.pulls ?? {});
  const declared = declaredBy(blocker, waiters);
  if (declared.includes(undefined)) return "read";
  const allMerged = states.length > 0 && states.every((state) => state === "merged");
  if (allMerged && declared.some((each) => each?.kind === "closes")) return "complete";
  return waiters.some((waiter) => waitsOn(waiter, entries).some((held) => held.key === blocker.key)) ? "queue" : null;
}

/** What the board does about the ticket `key`, or null when it takes no action: it has a run on the board, no queued run is sequenced behind it, or the tracker does not hold it In Progress. PURE. */
export function idleBlockerOf(key: string, entries: readonly ViewEntry[]): IdleBlocker | null {
  if (entries.some((entry) => entry.ticket.key === key)) return null;
  const waiters = waitersOf(key, entries);
  const blocker = waiters.flatMap((waiter) => sequencedBlockers(waiter)).find((each) => each.key === key);
  if (blocker === undefined || blocker.state !== STARTED) return null;
  const action = actionFor(blocker, waiters, entries);
  const pulls = Object.entries(blocker.pulls ?? {});
  return action === null ? null : { key, action, blocks: waiters.map(({ ticket }) => ticket.key), pulls: pulls.length, merged: pulls.filter(([, state]) => state === "merged").map(([url]) => url) };
}

/** Every ticket that holds queued runs back, is In Progress and has no run, with what the board does about each, in the order the queue first names them. PURE. */
export function idleBlockers(entries: readonly ViewEntry[]): IdleBlocker[] {
  const keys = new Set(entries.filter(({ phase }) => phase === "queued").flatMap((entry) => sequencedBlockers(entry).map(({ key }) => key)));
  return [...keys].flatMap((key) => idleBlockerOf(key, entries) ?? []);
}

/** The sentence the board says of the ticket `on` when it has no run: the action it takes, or that it takes none and a person decides. PURE. */
export function idleWords(on: string, idle: IdleBlocker | null): string {
  if (idle === null) return `${on} has no run on the board, so nothing is working on it, and the board takes no action on it: a person decides`;
  if (idle.action === "complete") return `${on} has no run on the board and all ${idle.pulls} of its pull requests have merged, one of them closing it, so the board completes it on its next sweep`;
  if (idle.action === "queue") return `${on} has no run on the board and still has open work, so the board queues it on the saved model on its next sweep, unless a person or another instance holds it`;
  return `${on} has no run on the board, and the board is reading its merged pull requests before it completes or queues it`;
}
