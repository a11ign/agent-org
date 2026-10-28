// @ts-check
// module: what a stacked pull request waits on, and what is stacked on a pull request, as the cards say it (A11-370) -- PURE
//
// A STACKED PULL REQUEST'S WAIT WAS NOT SAID ANYWHERE. #1984 (A11-366) sat on #1982 (A11-363), and its card said nothing of why it had no review, so the chairman had to ask. The member says "waits on #<base> (<state of the base>)",
// and the base says which pull requests are stacked on it. Both are read from the runs on the queue alone: a run's `stackBase` names the blocker whose branch it was built on (A11-116), and that blocker's open pull request in the same
// repository is the base. A base whose pull request merged is not waited on (the board moves the member to the default branch); one closed without merging is said, since the member is stranded on it.
import { parsePull } from "./pull-url.ts";
import { stackedOn } from "./pull-status-and-notes.ts";
import { openPulls, pullsOf, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";

type StackPull = Readonly<{ url: string }>;

/** The open pull requests of a run in the repository the stack is in. PURE. */
const pullsIn = (entry: ViewEntry, repo: string): StackPull[] => openPulls(entry).filter((pull) => parsePull(pull.url)?.repo === repo);

/** A pull request's number with its hash, as a card names it, or its whole address when it is no GitHub pull request. */
const numberedOf = (url: string): string => {
  const pull = parsePull(url);
  return pull === null ? url : `#${pull.number}`;
};

/** The run's pull request in the stack's repository, or null when it has none open. PURE. */
const baseOf = (entry: ViewEntry, repo: string): StackPull | null => pullsIn(entry, repo)[0] ?? null;

/** The tickets another run is built on: the one its open pull request is stacked on, and the blockers a run not yet started will stack on. PURE. */
function basesOf(run: ViewEntry, entries: readonly ViewEntry[]): string[] {
  const built = run.stackBase !== undefined && openPulls(run).length > 0 ? [run.stackBase.key] : [];
  return [...built, ...stackedOn(run, entries).map((base) => base.key)];
}

/** The tickets that have a run stacked on them, or queued to be, read once for all of `entries`. PURE. */
export function keysWithStackAbove(entries: readonly ViewEntry[]): ReadonlySet<string> {
  return new Set(entries.flatMap((run) => basesOf(run, entries).filter((key) => key !== run.ticket.key)));
}

/** The runs on the queue that have an open pull request built on `entry`'s branch, or are queued to be. PURE. */
export function stackedAbove(entry: ViewEntry, entries: readonly ViewEntry[]): ViewEntry[] {
  return entries.filter((other) => other.ticket.key !== entry.ticket.key && basesOf(other, entries).includes(entry.ticket.key));
}

/** What a base's reading says of it, in the words a card uses for a pull request's state: its conflict, its requested changes, its red or running checks, its approval, else that it waits for a review. PURE. */
function readingOf(head: PullHead | undefined): string {
  if (head?.conflict !== undefined) return "conflicting";
  if (head?.review === "changes-requested") return "changes requested";
  if ((head?.red ?? []).length > 0) return "checks failing";
  if ((head?.pending ?? []).length > 0) return "checks running";
  return head?.review === "approved" || head?.approved === true ? "approved" : "awaiting review";
}

/** The state of a base run's pull request: its reading when its run is finished, and what the run is doing while it works on one. PURE. */
function baseState(base: ViewEntry, url: string): string {
  if (base.phase === "queued") return "queued for a round";
  if (base.phase === "starting" || base.phase === "running") return "being worked on";
  return readingOf(base.pullHeads?.[url]);
}

/**
 * What a run's open pull request waits on when it is stacked on another run's: `waits on #<base> (<state of the base>)`. Null when the run is not stacked, has no open pull request in the stack's repository, or its base's pull request merged (the board moves the member to the default branch, A11-106). One closed without merging reads `closed without merging`. PURE.
 */
export function stackWaitNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const stack = entry.stackBase;
  if (stack === undefined || pullsIn(entry, stack.repo).length === 0) return null;
  const below = entries.find((other) => other.ticket.key === stack.key);
  if (below === undefined) return null;
  const base = baseOf(below, stack.repo);
  if (base !== null) return `waits on ${numberedOf(base.url)} (${baseState(below, base.url)})`;
  const closed = pullsOf(below).find((pull) => parsePull(pull.url)?.repo === stack.repo && below.pullStates?.[pull.url] === "closed");
  return closed === undefined ? null : `waits on ${numberedOf(closed.url)} (closed without merging)`;
}

/** What is stacked on a run's open pull request, by the member's pull request number and ticket: `#1984 (A11-366) is stacked on it`. Null when nothing is, or the run has no open pull request there. PURE. */
export function stackedOnItNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const members = stackedAbove(entry, entries).flatMap((member) => {
    const stack = member.stackBase;
    if (stack === undefined || stack.key !== entry.ticket.key || baseOf(entry, stack.repo) === null) return [];
    return pullsIn(member, stack.repo).map((pull) => `${numberedOf(pull.url)} (${member.ticket.key})`);
  });
  if (members.length === 0) return null;
  return `${members.join(", ")} ${members.length === 1 ? "is" : "are"} stacked on it`;
}
