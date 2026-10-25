// @ts-check
// module: whether the board brings the open member of a stack up to date with the default branch after the member below it merged, and what the card and a conflict round say about it (A11-248) -- PURE
//
// WHEN THE MEMBER BELOW A STACKED PULL REQUEST MERGES, THE BOARD MERGES THE DEFAULT BRANCH INTO IT, NEVER BY A REBASE AND NEVER BY A FORCE-PUSH. The house rules forbid both (as A11-150 settled for a moved blocker branch, `stack-rebase.ts`), so the
// merge is the code host's `updateBranch`: GitHub's own merge of a pull request's base into its branch, as the workers' account, refused when the head moved since it was read. A11-106 has moved the pull request's base to the default branch by then,
// so only the bottom open member is merged into here. The members above it follow when its branch moves: `rebaseStacked` merges a moved blocker branch into the run stacked on it.
import type { StackMergeFacts } from "../plugins/contracts/code-host.ts";
import { conflictLine } from "./worker-files.ts";

/** The member below that merged, as the board reads it: its ticket, its pull request's address, and that pull request's state as the code host says it now (`OPEN`, `MERGED`, `CLOSED`, or null when it could not say). */
export type RestackBelow = Readonly<{ key: string; url: string; state: string | null }>;

/** The restack the board already made for a pull request: the merged member's address, and the head the pull request was at when its conflict or refusal was said (unknown for a restack read back off a note). */
export type RestackDone = Readonly<{ merged: string; head?: string }>;

export type RestackStepInput = Readonly<{
  facts: Pick<StackMergeFacts, "base" | "defaultBranch" | "head">;
  below: RestackBelow;
  done: RestackDone | undefined;
  previousNote: string | undefined;
}>;

/** What to do for one pull request: merge the default branch in (`restack`), and the note the card shows meanwhile (null: nothing to say). */
export type RestackStep = Readonly<{ restack: boolean; note: string | null }>;

/** What the code host answered when the default branch was merged in. */
export type RestackOutcome = Readonly<{ kind: "updated" | "up-to-date" }> | Readonly<{ kind: "conflict"; round: "started" | "capped" | "none" }> | Readonly<{ kind: "refused"; reason: string }>;

const RESTACKED = " restacked on ";
const CONFLICTS = " conflicts with ";
const COULD_NOT = " could not be restacked on ";
const AFTER_MERGED = /^#(\d+)( restacked on | conflicts with | could not be restacked on )(\S+) after #(\d+) merged/;

/** The number a pull request's address ends in. PURE. */
const numberOf = (url: string): string => url.replace(/\/+$/, "").split("/").pop() ?? url;

/**
 * Whether the default branch is to be merged into a pull request: the member below it has merged, the pull request's base is the default branch now (a base that is still the merged member's branch has not been retargeted, and a
 * note about it comes first), and the board has not already done it for that member. PURE.
 */
function isDue({ facts, below, done }: Pick<RestackStepInput, "facts" | "below" | "done">): boolean {
  return below.state === "MERGED" && facts.base === facts.defaultBranch && done?.merged !== below.url;
}

/**
 * What the board does for one pull request above a member that merged. It asks for a restack once for each merged member below. Otherwise it asks for nothing and keeps the restack note it wrote before: a "restacked" note stays true, and a note about
 * a conflict or a refusal stays until the head moves from the one it was said at (a round pushed, or a person did), when it is gone. PURE.
 */
export function restackStep(input: RestackStepInput): RestackStep {
  const { facts, done, previousNote } = input;
  if (isDue(input)) return { restack: true, note: null };
  const kept = previousNote !== undefined && isRestackNote(previousNote);
  const stale = done?.head !== undefined && done.head !== facts.head && !isRestackedNote(previousNote ?? "");
  return { restack: false, note: kept && !stale ? previousNote : null };
}

/** The note for a pull request after the default branch was merged into it (or found already in it), the conflict round that was started or not, or the host's refusal. PURE. */
export function restackNote({ url, defaultBranch, below, outcome }: { url: string; defaultBranch: string; below: RestackBelow; outcome: RestackOutcome }): string {
  const lead = `#${numberOf(url)}`;
  const after = `after #${numberOf(below.url)} merged`;
  switch (outcome.kind) {
    case "updated":
    case "up-to-date":
      return `${lead}${RESTACKED}${defaultBranch} ${after}`;
    case "conflict":
      return outcome.round === "started" ? `${lead}${CONFLICTS}${defaultBranch} ${after}: a conflict round resolves it`
        : outcome.round === "capped" ? `${lead}${CONFLICTS}${defaultBranch} ${after}, and the conflict rounds are used up: Respond to review starts another`
          : `${lead}${CONFLICTS}${defaultBranch} ${after}, and no conflict round starts on this run`;
    case "refused":
      return `${lead}${COULD_NOT}${defaultBranch} ${after}: ${outcome.reason}; agent-org tries again`;
  }
}

/** Whether a per-pull-request note is one the restack wrote, so the sweep of the bases neither keeps nor clears it. PURE. */
export const isRestackNote = (note: string): boolean => AFTER_MERGED.test(note);

/** Whether a restack note says the pull request is up to date, which stays true, rather than something the board still has to do or a person to do. PURE. */
export const isRestackedNote = (note: string): boolean => AFTER_MERGED.exec(note)?.[2] === RESTACKED;

/** Whether a restack note is a conflict, a refusal or a cap: what a pull request needs said before anything else on the card. PURE. */
export const isRestackProblemNote = (note: string): boolean => isRestackNote(note) && !isRestackedNote(note);

/**
 * The merged member a "restacked" or "conflicts" note names, as the address of that pull request, beside `url` in the same repository, or null for a note about another pull request or for any other note, including a refusal, which the board tries again. PURE.
 */
export function restackedAfter(note: string, url: string): string | null {
  const found = AFTER_MERGED.exec(note);
  if (found === null || found[2] === COULD_NOT || found[1] !== numberOf(url)) return null;
  return url.replace(/\/pull\/\d+\/?$/, `/pull/${found[4]}`);
}

/**
 * The feedback a conflict round starts with when merging the default branch into a stacked pull request conflicted: the conflict line the round's brief reads as a conflict to merge first, then the stack and the member that merged. PURE.
 */
export function restackFeedback({ url, defaultBranch, below, key }: { url: string; defaultBranch: string; below: RestackBelow; key: string }): string {
  return [
    conflictLine(url, defaultBranch),
    `${key} is stacked on ${below.key}; its pull request #${numberOf(below.url)} (${below.url}) merged into \`${defaultBranch}\`, and merging \`${defaultBranch}\` into ${url} conflicted.`,
  ].join("\n");
}
