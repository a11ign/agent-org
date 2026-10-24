// @ts-check
// module: whether the board hands an approved, green stacked pull request to the arm bot, and what the card says when GitHub refused it (A11-238) -- PURE
//
// GITHUB REFUSES AUTO-MERGE FOR A PULL REQUEST IN A STACK, so the arm bot merges it with the stack merge once it is approved and green (`auto-arm.yml`, job `arm-approved`). It acts on events: an approving review starts it. A stacked pull request that turns ready
// LATER (its checks go green after the approval, or its head moves after the one below it merged, with the approval kept) gets no second event, so the board asks the arm bot again. THE BOARD NEVER MERGES: asking is a dispatch of the arm bot's own job, which re-reads
// the pull request and trusts nothing the dispatch says. What the arm bot refused is a keyed comment on the pull request carrying the head it was given at; it holds only for that head, so a head that moves (a push after changes were requested, or a rebase
// after a member below merged) makes the board ask again.
import type { StackMergeFacts, StackMergeRequest } from "../plugins/contracts/code-host.ts";

/** How long the board waits for the arm bot before it asks again about the same head: the arm bot's job runs for about a minute, and a refusal it left is read before this runs out. */
export const STACK_MERGE_ASK_AGAIN_MS = 15 * 60_000;

/** The head the board last asked the arm bot about, and when (the pool's clock). */
export type StackMergeAsk = Readonly<{ head: string; at: number }>;

export type StackMergeStepInput = Readonly<{
  url: string;
  facts: StackMergeFacts;
  /** Whether the pull request is approved at the head the facts name, with no required check red or running there. */
  ready: boolean;
  /** The last time the board asked the arm bot about this pull request, if it did. */
  asked: StackMergeAsk | undefined;
  now: number;
}>;

/** What to do for one pull request: ask the arm bot to merge it, and the note the card shows for it (null: nothing to say). */
export type StackMergeStep = Readonly<{ ask: boolean; note: string | null }>;

const NOTHING: StackMergeStep = { ask: false, note: null };

/** Whether the pull request is in a stack, still open, and the bottom member that is left: its base is the default branch, so every member below it has merged. PURE. */
const isOpenBottomMember = ({ stacked, settled, base, defaultBranch }: StackMergeFacts): boolean => stacked && settled === null && base === defaultBranch;

/**
 * What the board does for one pull request. A pull request that is not in a stack stays with the arm bot's auto-merge, and one already merged or queued is settled. One whose base is not the default branch has a member below it still open, so the stack
 * merge would take that one too: it waits (the card already says what the run is stacked on). One that is not ready waits for its review and checks. A ready one is asked about, unless GitHub refused it at this head (then the card says why, and the board does not ask again)
 * or the board asked about this head less than {@link STACK_MERGE_ASK_AGAIN_MS} ago. PURE.
 */
export function stackMergeStep({ url, facts, ready, asked, now }: StackMergeStepInput): StackMergeStep {
  if (!isOpenBottomMember(facts) || !ready) return NOTHING;
  if (facts.refusal !== null && facts.refusal.head === facts.head) return { ask: false, note: `GitHub refused the stack merge of ${url}: ${facts.refusal.reason}` };
  const waiting = asked !== undefined && asked.head === facts.head && now - asked.at < STACK_MERGE_ASK_AGAIN_MS;
  return { ask: !waiting, note: null };
}

/** The repository (`owner/name`) and number of the pull request a GitHub address names, or null for any other address. PURE. */
export function stackMergeRequestOf(url: string): StackMergeRequest | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { repo: match[1], number: Number(match[2]) };
}
