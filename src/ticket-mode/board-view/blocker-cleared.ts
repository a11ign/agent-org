// @ts-check
// module: a needs-human run whose pull requests merged -- which pull requests it is about, when the board lets it go, and what its card says (A11-258) -- PURE
//
// A run that ends `needs-human` keeps its herdr workspace (parked), and the merge machinery skips a parked run: its next plan step was never queued, and a `Closes` merge left it parked under the old
// question. When every pull request the run is about has merged, the blocker it asked about is gone, so the pool's sweep (`pool-blocker-cleared.ts`) closes the workspace and the merge machinery acts on it as on
// any finished run. A run is about the pull requests it holds (`pullsOf`: a round's `review`), or, when it holds none, the ones its own reason names. This file is in `board-view/` because the card words the
// line from it, and the page runs only what that folder holds.
import { pullLabel } from "./pull-label.ts";
import { settledByPulls } from "./pull-settled.ts";
import { pullsOf, type ViewEntry } from "./view-types-and-filters.ts";

/** A pull request address, as a worker writes it in a reason. */
const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** `owner/repo#N` or `repo#N`, not preceded by a word character or a path: a bare `#N` names no repository, so it is not read. */
const PULL_SHORTHAND = /(?<![\w/.-])(?:([\w.-]+)\/)?([\w.-]+)#(\d+)\b/g;

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
 * The pull requests a finished `needs-human` run that holds none is about: the ones its reason names that the tracker links to the ticket and reads open (`pullStates`). Empty for any other run. One that stands merged or closed the
 * first time the board reads it is context the worker cited, not what it waits on, and is never adopted: a merged pull request quoted in an unrelated question must not release it. PURE.
 */
export function namedBlockers(entry: ViewEntry): string[] {
  const reason = entry.outcome?.kind === "needs-human" ? entry.outcome.reason : undefined;
  if (entry.phase !== "finished" || reason === undefined || pullsOf(entry).length > 0) return [];
  const open = Object.entries(entry.pullStates ?? {}).filter(([, state]) => state === "open").map(([url]) => url);
  return namedPulls(reason, open);
}

/** Whether a finished run ended `needs-human` and every pull request it is about has merged or closed with one merged. PURE. */
export const isMergedBlocker = (entry: ViewEntry): boolean =>
  entry.phase === "finished" && entry.outcome?.kind === "needs-human" && settledByPulls(entry) === "completed";

/**
 * Whether the board lets a run's parked workspace go (A11-258): it is parked (and no talk session, a person at its terminal), ended `needs-human`, its pull requests merged, and their bodies are read, so the
 * `Closes` or `Partial:` that decides what the merge means (A11-181) is known before the next step is queued or the ticket completed. PURE.
 */
export const isReleasable = (entry: ViewEntry): boolean =>
  isMergedBlocker(entry) && entry.workspace !== undefined && entry.talk !== true && entry.declared !== undefined;

/** The merged pull requests of a run, as a card names them. */
const mergedNames = (entry: ViewEntry): string => pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged").map(({ url }) => pullLabel(url)).join(", ");

/** `the blocker cleared: <the merged pull requests> merged`, the head of a card line for a `needs-human` run whose pull requests merged. */
export const blockerClearedHead = (names: string): string => `the blocker cleared: ${names} merged`;

/** The head of the card line of a run whose `needs-human` blocker merged ({@link blockerClearedHead}), or null for a run that is not one. PURE. */
export function blockerClearedLine(entry: ViewEntry): string | null {
  return isMergedBlocker(entry) ? blockerClearedHead(mergedNames(entry)) : null;
}
