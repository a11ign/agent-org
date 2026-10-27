// @ts-check
// module: a needs-human run whose pull requests merged -- which pull requests it is about, when the board lets it go, and what its card says (A11-258); a run that stopped without an outcome is let go the same way (A11-274) -- PURE
//
// A run that ends `needs-human` keeps its herdr workspace (parked), and the merge machinery skips a parked run: its next plan step was never queued, and a `Closes` merge left it parked under the old
// question. When every pull request the run is about has merged, the blocker it asked about is gone, so the pool's sweep (`pool-blocker-cleared.ts`) closes the workspace and the merge machinery acts on it as on
// any finished run. A run is about the pull requests it holds (`pullsOf`: a round's `review`), or, when it holds none, the ones its own reason names. This file is in `board-view/` because the card words the
// line from it, and the page runs only what that folder holds.
import { pullLabel } from "./pull-label.ts";
import { liftedBlocks } from "./pull-answer.ts";
import { settledByPulls } from "./pull-settled.ts";
import { pullsOf, type ViewEntry } from "./view-types-and-filters.ts";

/** A pull request address, as a worker writes it in a reason. */
const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** `owner/repo#N` or `repo#N`, after the start of the text or a character that is no part of a name or path: a bare `#N` names no repository, so it is not read. (No lookbehind: the page runs this folder in the browser.) */
const PULL_SHORTHAND = /(?:^|[^\w/.-])(?:([\w.-]+)\/)?([\w.-]+)#(\d+)\b/g;

/** The owner, repository and number of a GitHub pull request address, or null for any other. */
function addressOf(url: string): Readonly<{ owner: string; repo: string; number: string }> | null {
  const found = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
  if (found === null) return null;
  const [, owner, repo, number] = found;
  return { owner, repo, number };
}

/**
 * The pull requests of `linked` (the ones the tracker links to the ticket) that `reason` names, in the order they are linked: by address, or as `owner/repo#N` or `repo#N`. A pull request the tracker does not link to the
 * ticket is nothing the board can read, so it is never named here. PURE.
 */
export function namedPulls(reason: string, linked: readonly string[]): string[] {
  const addresses = new Set(reason.match(PULL_URL) ?? []);
  const shorthands = [...reason.matchAll(PULL_SHORTHAND)].map(([, owner, repo, number]) => ({ owner, repo, number }));
  return linked.filter((url) => {
    const address = addressOf(url);
    return addresses.has(url) || (address !== null && shorthands.some((said) => said.repo === address.repo && said.number === address.number && (said.owner === undefined || said.owner === address.owner)));
  });
}

/**
 * The pull requests a finished `needs-human` run that holds none is about, once they have merged: the ones its reason names that the tracker links to the ticket and the board last read OPEN (`entry.pullStates`), given the
 * states it reads now (`now`). Empty while any of them is still open, and when none has merged. One that stood merged or closed the first time the board read it is context the worker cited, not what it waits on, and is
 * never adopted: a merged pull request quoted in an unrelated question must not release it. Adopted only when they have merged, because a run that holds a pull request is watched, retried and held against as a round
 * (`review`), and a named pull request that is still open must not change what the board does with the run. PURE.
 */
export function namedBlockers(entry: ViewEntry, now: Readonly<Record<string, string>>): string[] {
  const reason = entry.outcome?.kind === "needs-human" ? entry.outcome.reason : undefined;
  if (entry.phase !== "finished" || reason === undefined || pullsOf(entry).length > 0) return [];
  const open = Object.entries(entry.pullStates ?? {}).filter(([, state]) => state === "open").map(([url]) => url);
  const named = namedPulls(reason, open);
  const settled = named.every((url) => now[url] === "merged" || now[url] === "closed");
  return named.length > 0 && settled && named.some((url) => now[url] === "merged") ? named : [];
}

/** The tracker states of a ticket that will not be done: its card reads Cancelled, so it does not say a blocker cleared. */
const CANCELLED: ReadonlySet<string> = new Set(["canceled", "duplicate"]);

/** The outcomes of a parked run that the merge of its pull requests lets go: a question (`needs-human`, A11-258), and a run that stopped without writing an outcome (A11-274). */
const RELEASED_ON_MERGE: ReadonlySet<string> = new Set(["needs-human", "no-outcome"]);

/**
 * Whether a finished run ended `needs-human`, or stopped without an outcome (A11-274), and every pull request it is about has merged or closed with one merged: nothing is left for a person to answer. PURE.
 */
export const isMergedBlocker = (entry: ViewEntry): boolean =>
  entry.phase === "finished" && RELEASED_ON_MERGE.has(entry.outcome?.kind ?? "") && settledByPulls(entry) === "completed";

/**
 * Whether the board lets a run's parked workspace go (A11-258): it is parked (and no talk session, a person at its terminal), ended `needs-human` or stopped without an outcome (A11-274), its pull requests merged, and their
 * bodies are read, so the `Closes` or `Partial:` that decides what the merge means (A11-181) is known before the next step is queued or the ticket completed. PURE.
 */
export const isReleasable = (entry: ViewEntry): boolean =>
  isMergedBlocker(entry) && entry.workspace !== undefined && entry.talk !== true && entry.declared !== undefined;

/** Whether a run asked a question (`needs-human`) that the merge of its pull requests answered. PURE. */
const isAnsweredByMerge = (entry: ViewEntry): boolean => entry.outcome?.kind === "needs-human" && isMergedBlocker(entry);

/** The merged pull requests of a run, as a card names them. */
const mergedNames = (entry: ViewEntry): string => pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged").map(({ url }) => pullLabel(url)).join(", ");

/** `the blocker cleared: <the merged pull requests> merged`, the head of a card line for a `needs-human` run whose pull requests merged. */
export const blockerClearedHead = (names: string): string => `the blocker cleared: ${names} merged`;

/**
 * The head of the card line of a run whose `needs-human` blocker merged ({@link blockerClearedHead}), or null for a run that is not one. A run that stopped without an outcome asked nothing, so no blocker of it cleared: its
 * card says what completed it (A11-274). PURE.
 */
export function blockerClearedLine(entry: ViewEntry): string | null {
  return isAnsweredByMerge(entry) && !CANCELLED.has(entry.trackerState ?? "") ? blockerClearedHead(mergedNames(entry)) : null;
}

/** `the blocker cleared: the requested changes on <the pull requests> were lifted`, the card line of a `needs-human` run whose open pull requests stopped it on changes requested and are lifted and mergeable now (A11-258), or null. PURE. */
export function liftedBlockLine(entry: ViewEntry): string | null {
  const lifted = liftedBlocks(entry);
  return lifted.length === 0 ? null : `the blocker cleared: the requested changes on ${lifted.map(pullLabel).join(", ")} were lifted`;
}
