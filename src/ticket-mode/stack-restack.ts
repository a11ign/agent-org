// @ts-check
// module: whether the board brings the open member of a stack up to date with the default branch after the member below it merged, whether it then closes a member that holds nothing of its own, and what the card and a conflict round say about it (A11-248) -- PURE
//
// WHEN THE MEMBER BELOW A STACKED PULL REQUEST MERGES, THE BOARD MERGES THE DEFAULT BRANCH INTO IT, NEVER BY A REBASE AND NEVER BY A FORCE-PUSH. The house rules forbid both (as A11-150 settled for a moved blocker branch, `stack-rebase.ts`), so the
// merge is the code host's `updateBranch`: GitHub's own merge of a pull request's base into its branch, as the workers' account, refused when the head moved since it was read. A11-106 has moved the pull request's base to the default branch by then,
// so only the bottom open member is merged into here. The members above it follow when its branch moves: `rebaseStacked` merges a moved blocker branch into the run stacked on it.
//
// A MEMBER LEFT WITH NOTHING OF ITS OWN IS CLOSED. When everything a member held merged with the member below it, merging the default branch in leaves its pull request with no changes: the files it changes are none, or only the scaffolding every worker's pull request
// carries (`SCAFFOLD_DIRS`). The board closes it with a comment, once the read of its files is one it can trust (`emptyMember`).
import type { StackMergeFacts } from "../plugins/contracts/code-host.ts";
import { SCAFFOLD_DIRS } from "../scaffold-dirs.ts";
import { conflictLine } from "./worker-files.ts";

/** The member below that merged, as the board reads it: its ticket, its pull request's address, and that pull request's state as the code host says it now (`OPEN`, `MERGED`, `CLOSED`, or null when it could not say). */
export type RestackBelow = Readonly<{ key: string; url: string; state: string | null }>;

/**
 * The restack the board already made for a pull request: the merged member's address, and the head the pull request was at when its conflict or refusal was said, or when the restack was made (unknown for a restack read back off a note). `upToDate` is that the restack found the
 * branch already current, so a head that did not move is fine; `ownChangesAt` is the head at which the board read a file of the member's own, which it does not read again.
 */
export type RestackDone = Readonly<{ merged: string; head?: string; upToDate?: true; ownChangesAt?: string }>;

export type RestackStepInput = Readonly<{
  facts: Pick<StackMergeFacts, "base" | "defaultBranch" | "head" | "settled">;
  below: RestackBelow;
  done: RestackDone | undefined;
  previousNote: string | undefined;
}>;

/** What to do for one pull request: merge the default branch in (`restack`), and the note the card shows meanwhile (null: nothing to say). */
export type RestackStep = Readonly<{ restack: boolean; note: string | null }>;

/** What a conflict found by the restack earns the run: a conflict round (`round`), none because the board's rounds are used up (`capped`), or none because the board does not resume the run on a conflict (`none`). */
export type ConflictRound = "round" | "capped" | "none";

/** What the code host answered when the default branch was merged in. */
export type RestackOutcome = Readonly<{ kind: "updated" | "up-to-date" }> | Readonly<{ kind: "conflict"; round: ConflictRound }> | Readonly<{ kind: "refused"; reason: string }>;

const RESTACKED = " restacked on ";
const CONFLICTS = " conflicts with ";
const COULD_NOT = " could not be restacked on ";
const AFTER_MERGED = /^#(\d+)( restacked on | conflicts with | could not be restacked on )(\S+) after #(\d+) merged/;
const CLOSED = /^#(\d+) closed: everything it held merged with #(\d+)/;
const EMPTY = /^#(\d+) has no changes of its own after #(\d+) merged(, and closing it failed: |: close it, because this code host cannot)/;

/** The number a pull request's address ends in. PURE. */
const numberOf = (url: string): string => url.replace(/\/+$/, "").split("/").pop() ?? url;

/**
 * Whether the default branch is to be merged into a pull request: the member below it has merged, the pull request is neither queued to merge nor merged, its base is the default branch now (a base that is still the merged member's branch has not been retargeted, and a
 * note about it comes first), and the board has not already done it for that member. PURE.
 */
function isDue({ facts, below, done }: Pick<RestackStepInput, "facts" | "below" | "done">): boolean {
  return below.state === "MERGED" && facts.settled === null && facts.base === facts.defaultBranch && done?.merged !== below.url;
}

/**
 * What the board does for one pull request above a member that merged. It asks for a restack once for each merged member below. Otherwise it asks for nothing and keeps the restack note it wrote before: a "restacked" note stays true, and a note about
 * a conflict or a refusal stays until the head moves from the one it was said at (a round pushed, or a person did), when it is gone. A note about closing a member stays whatever the head: the restack moved it. PURE.
 */
export function restackStep(input: RestackStepInput): RestackStep {
  const { facts, done, previousNote } = input;
  if (isDue(input)) return { restack: true, note: null };
  const kept = previousNote !== undefined && isRestackNote(previousNote);
  const stale = done?.head !== undefined && done.head !== facts.head && !isRestackedNote(previousNote ?? "") && !isCloseNote(previousNote ?? "");
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
      return outcome.round === "round" ? `${lead}${CONFLICTS}${defaultBranch} ${after}: a conflict round resolves it`
        : outcome.round === "capped" ? `${lead}${CONFLICTS}${defaultBranch} ${after}, and the conflict rounds are used up: Respond to review starts another`
          : `${lead}${CONFLICTS}${defaultBranch} ${after}, and no conflict round starts on this run`;
    case "refused":
      return `${lead}${COULD_NOT}${defaultBranch} ${after}: ${outcome.reason}; agent-org tries again`;
  }
}

/** Whether a per-pull-request note is one the restack wrote, or the close of a member left empty, so the sweep of the bases neither keeps nor clears it. PURE. */
export const isRestackNote = (note: string): boolean => AFTER_MERGED.test(note) || isCloseNote(note);

/** Whether a note is about closing a member that holds nothing of its own: that it was closed, that closing it failed, or that this code host cannot close it. PURE. */
export const isCloseNote = (note: string): boolean => CLOSED.test(note) || EMPTY.test(note);

/** Whether a restack note says the pull request is up to date, which stays true, rather than something the board still has to do or a person to do. PURE. */
export const isRestackedNote = (note: string): boolean => AFTER_MERGED.exec(note)?.[2] === RESTACKED;

/** Whether a restack note is a conflict, a refusal, a cap, or an empty member that is not closed: what a pull request needs said before anything else on the card. PURE. */
export const isRestackProblemNote = (note: string): boolean => isRestackNote(note) && !isRestackedNote(note) && !CLOSED.test(note);

/** Whether a note says a member holds nothing of its own and is not closed yet, which the board tries again or leaves to whoever closes it. PURE. */
export const isEmptyMemberNote = (note: string): boolean => EMPTY.test(note);

/**
 * The merged member a "restacked" or "conflicts" note names, or an empty member's (a member that is empty was restacked first), as the address of that pull request, beside `url` in the same repository, or null for a note about another pull request or for any other note,
 * including a refusal, which the board tries again. PURE.
 */
export function restackedAfter(note: string, url: string): string | null {
  const found = AFTER_MERGED.exec(note);
  const [number, merged] = found !== null && found[2] !== COULD_NOT ? [found[1], found[4]] : emptyOf(note);
  if (number !== numberOf(url) || merged === undefined) return null;
  return url.replace(/\/pull\/\d+\/?$/, `/pull/${merged}`);
}

/** The pull request and the merged member an empty member's note names, or nothing for any other note. PURE. */
function emptyOf(note: string): [string | undefined, string | undefined] {
  const found = EMPTY.exec(note);
  return [found?.[1], found?.[2]];
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

/** What was done about a member that holds nothing of its own: it was closed, closing it was refused (`reason` is the host's first line), or the code host cannot close. */
export type CloseOutcome = Readonly<{ kind: "closed" }> | Readonly<{ kind: "refused"; reason: string }> | Readonly<{ kind: "unsupported" }>;

/** The note for a member that holds nothing of its own, after it was closed, after closing it failed, or for a code host that cannot close. None of it says a person resolves anything: the member holds nothing to resolve. PURE. */
export function closeNote({ url, below, outcome }: { url: string; below: RestackBelow; outcome: CloseOutcome }): string {
  const lead = `#${numberOf(url)}`;
  const merged = `#${numberOf(below.url)}`;
  switch (outcome.kind) {
    case "closed":
      return `${lead} closed: everything it held merged with ${merged}`;
    case "refused":
      return `${lead} has no changes of its own after ${merged} merged, and closing it failed: ${outcome.reason}; agent-org tries again`;
    case "unsupported":
      return `${lead} has no changes of its own after ${merged} merged: close it, because this code host cannot`;
  }
}

/** The comment the board closes an empty member with: the pull request, and the member whose merge left it with nothing. PURE. */
export const closeComment = (url: string, below: RestackBelow): string =>
  `Closed by agent-org: everything #${numberOf(url)} held merged with #${numberOf(below.url)}, so it has no changes of its own left.`;

/** Whether a changed file is scaffolding every worker's pull request carries (`.acceptance/`, `.changeset/`), which is not a change of the member's own. PURE. */
const isScaffold = (file: string): boolean => SCAFFOLD_DIRS.some((dir) => file.startsWith(dir));

/** Whether any listed file is one of the member's own, which settles that it is not empty even for a list cut short. PURE. */
export const holdsOwnFile = (files: readonly string[]): boolean => files.some((file) => !isScaffold(file));

export type EmptyMemberInput = Readonly<{
  files: readonly string[]; filesComplete: boolean;
  /** The head the code host read the files at, or null when it does not say. */
  head: string | null;
  done: RestackDone;
}>;

/**
 * Whether a member left open holds nothing of its own, so the board closes it: the list of its files is complete and every file in it is scaffolding (or there is none), at a head the board can trust. A head is trusted when it is known, is not the head at which a
 * read already found a file of the member's own, and, if the restack moved the branch, is not the head the restack was made at (a read right after a merge may still be of the old one). A restack that found the branch already current moved nothing, so its head is fine. PURE.
 */
export function emptyMember({ files, filesComplete, head, done }: EmptyMemberInput): boolean {
  if (!filesComplete || head === null || holdsOwnFile(files)) return false;
  if (done.ownChangesAt === head) return false;
  return done.upToDate === true || done.head === undefined || done.head !== head;
}
