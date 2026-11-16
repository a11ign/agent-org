// @ts-check
// module: the epic's bar for the pre-PR review (A11-440, step 2 of 2) -- a run of a set with `tickets.localReview` off and one with it on, at one sha, read against the bar
//
// THE BAR (A11-429's plan, grill Q3; A11-440's acceptance criteria): the key turns on by default only when the first-pass reviewer verdict is better with it on, AND the reviewer tokens the
// pre-PR reviews spent are no more than the tokens of the feedback rounds they save. Either one missed keeps the key off, and the text says which and by how much.
// - THE FIRST-PASS VERDICT is the eval's own: the offline reviewer's verdict on the tree the worker left, counted as convinced tickets over the tickets both runs have. An unknown verdict is
//   not convinced, as the eval's totals count it. Better is strictly more convinced.
// - THE ROUNDS SAVED are the convinced tickets gained: each first pass that is convinced with the key on and was not with it off is a feedback round the pull request no longer spends, and
//   one lost is a round more. A net loss saves none.
// - A ROUND'S TOKENS are the median of the board's own feedback rounds, every round of a run after its first in the outcome log (A11-430). Only the worker's tokens are counted: the board's
//   review of the new head that a round also costs is left out, so the rounds saved are, if anything, costed low, and the bar is no easier to meet than the ticket's words.
// - THE REVIEWER TOKENS are the Codex tokens of every pre-PR review the on run's workers ran (`local-review.ts`). One unknown makes the total unknown, and an unknown total misses the bar.
import { type OutcomeRecord } from "../ticket-mode/outcomes/outcome-record.ts";
import { type TicketResult } from "../run-eval.ts";
import { type StoredRun } from "./store.ts";
import { layOut } from "./table.ts";

/** The key the bar is for. */
export const PRE_REVIEW_KEY = "tickets.localReview";

/** What a feedback round costs: the median tokens of the outcome log's rounds after a run's first, and how many rounds that median is of. */
export type RoundCost = Readonly<{ tokens: number; rounds: number }>;

const sumTokens = (byModel: Readonly<Record<string, Readonly<Record<string, number>>>>): number =>
  Object.values(byModel).reduce((total, tokens) => total + Object.values(tokens).reduce((a, b) => a + b, 0), 0);

/** The median tokens of every run's rounds after its first, among those whose tokens were read (`latestOutcomes`' records). THROWS when the log holds no such round. PURE. */
export function feedbackRoundTokens(records: readonly OutcomeRecord[]): RoundCost {
  const later = records.flatMap(({ rounds }) => rounds.slice(1)).filter(({ tokens }) => tokens !== undefined).map(({ tokens }) => sumTokens(tokens ?? {})).sort((a, b) => a - b);
  if (later.length === 0) throw new Error("the outcome log holds no round after a run's first with its tokens read, so a feedback round has no cost to set the reviewer's against");
  const middle = Math.floor(later.length / 2);
  return { tokens: later.length % 2 === 1 ? later[middle] : Math.round((later[middle - 1] + later[middle]) / 2), rounds: later.length };
}

/** What the bar found. `reviewerTokens` is null when any pre-PR review's tokens are unknown. */
export type Bar = Readonly<{
  tickets: number; convincedOff: number; convincedOn: number; better: boolean;
  roundsSaved: number; savedTokens: number; reviews: number; reviewed: number; reviewerTokens: number | null; affordable: boolean; met: boolean;
}>;

/** Why two runs cannot be set against the bar, or null when they can: the off run and the on run of the key, at one committed sha. PURE. */
function refusal(off: StoredRun, on: StoredRun): string | null {
  const setting = (run: StoredRun) => (run.key?.name === PRE_REVIEW_KEY ? run.key.on : null);
  if (setting(off) !== false || setting(on) !== true) return `the bar needs a run with ${PRE_REVIEW_KEY}=off, then one with ${PRE_REVIEW_KEY}=on`;
  if (off.sha !== on.sha) return `the two runs are at different shas (${off.sha.slice(0, 7)} and ${on.sha.slice(0, 7)}): the bar compares the key alone, at one sha`;
  if (off.dirty || on.dirty) return "a run with uncommitted changes is not named by its sha: run both from a commit";
  return null;
}

const convinced = (result: TicketResult): boolean => result.scores.verdict === "convinced";

/** A ticket both runs have: its result with the key off and with it on. */
type Pair = Readonly<{ off: TicketResult; on: TicketResult }>;

/** The tickets both runs have, in the on run's order. PURE. */
function pairsOf(off: StoredRun, on: StoredRun): Pair[] {
  const offOf = new Map(off.results.map((result) => [result.entry.ticket, result]));
  return on.results.filter(({ entry }) => offOf.has(entry.ticket)).map((result) => ({ on: result, off: offOf.get(result.entry.ticket) as TicketResult }));
}

/** The pre-PR reviews' tokens added up over `pairs`, or null when any ticket's are unknown or were not kept. PURE. */
function reviewerTokensOf(pairs: readonly Pair[]): number | null {
  let total = 0;
  for (const { on } of pairs) {
    const tokens = on.scores.localReviews?.tokens;
    if (tokens === null || tokens === undefined) return null;
    total += tokens;
  }
  return total;
}

/** The bar, over the tickets both runs have. THROWS naming why when the runs are not the off and on runs of the key at one committed sha. PURE. */
export function preReviewBar(off: StoredRun, on: StoredRun, round: RoundCost): Bar {
  const refused = refusal(off, on);
  if (refused !== null) throw new Error(refused);
  const pairs = pairsOf(off, on);
  const convincedOff = pairs.filter((pair) => convinced(pair.off)).length;
  const convincedOn = pairs.filter((pair) => convinced(pair.on)).length;
  const roundsSaved = Math.max(0, convincedOn - convincedOff);
  const counts = pairs.map((pair) => pair.on.scores.localReviews?.count ?? 0);
  const reviewerTokens = reviewerTokensOf(pairs);
  const savedTokens = roundsSaved * round.tokens;
  const better = convincedOn > convincedOff;
  const affordable = reviewerTokens !== null && reviewerTokens <= savedTokens;
  return { tickets: pairs.length, convincedOff, convincedOn, better, roundsSaved, savedTokens, reviews: counts.reduce((a, b) => a + b, 0),
    reviewed: counts.filter((count) => count > 0).length, reviewerTokens, affordable, met: better && affordable };
}

const withCommas = (value: number): string => value.toLocaleString("en-US");
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${withCommas(value)}`;

/** The verdict line: better, or by how much it is not. PURE. */
function verdictLine({ tickets, convincedOff, convincedOn, better }: Bar): string {
  const change = `${convincedOff} → ${convincedOn} convinced of ${tickets} (${signed(convincedOn - convincedOff)})`;
  return better ? `first-pass verdict: ${change}: better` : `first-pass verdict: ${change}: NOT better, ${convincedOff + 1 - convincedOn} more convinced needed`;
}

/** The tokens line: within the rounds saved, or by how much it is over, or unknown. PURE. */
function tokensLine({ reviewerTokens, savedTokens, reviews, reviewed, tickets }: Bar): string {
  const spent = `reviewer tokens of the pre-PR reviews: ${reviewerTokens === null ? "unknown (a review's tokens could not be read)" : withCommas(reviewerTokens)} in ${reviews} reviews on ${reviewed} of ${tickets} tickets`;
  if (reviewerTokens === null) return `${spent}: NOT shown to be within the rounds saved`;
  return reviewerTokens <= savedTokens ? `${spent}: within the ${withCommas(savedTokens)} of the rounds saved` : `${spent}: ${withCommas(reviewerTokens - savedTokens)} MORE than the ${withCommas(savedTokens)} of the rounds saved`;
}

/** One row per ticket both runs have: its verdict off and on, the pre-PR reviews and their tokens, and the worker's tokens off and on. PURE. */
function ticketRows(pairs: readonly Pair[]): string[] {
  const known = (tokens: number | null | undefined): string => (tokens === null || tokens === undefined ? "?" : withCommas(tokens));
  const rows = pairs.map(({ off, on }) => [on.entry.ticket, `${off.scores.verdict ?? "?"} → ${on.scores.verdict ?? "?"}`, String(on.scores.localReviews?.count ?? "?"),
    known(on.scores.localReviews?.tokens), `${known(off.scores.tokens)} → ${known(on.scores.tokens)}`]);
  return layOut([["ticket", "verdict off → on", "reviews", "reviewer tokens", "worker tokens off → on"], ...rows]);
}

/** The bar as the command prints it, and whether it was met. THROWS as `preReviewBar` does. PURE. */
export function barText(off: StoredRun, on: StoredRun, round: RoundCost): { text: string; met: boolean } {
  const bar = preReviewBar(off, on, round);
  const lines = [
    `pre-PR review bar (${PRE_REVIEW_KEY}), ${on.set} at ${on.sha.slice(0, 7)}: off → on (${on.model}, effort ${on.effort})`,
    "", ...ticketRows(pairsOf(off, on)), "",
    verdictLine(bar),
    `feedback rounds saved: ${bar.roundsSaved}, at ${withCommas(round.tokens)} tokens a round (the median of ${round.rounds} rounds after a run's first in the outcome log) = ${withCommas(bar.savedTokens)} tokens`,
    tokensLine(bar),
    bar.met ? `BAR MET: ${PRE_REVIEW_KEY} turns on by default` : `BAR MISSED: ${PRE_REVIEW_KEY} stays off`,
  ];
  return { text: `${lines.join("\n")}\n`, met: bar.met };
}
