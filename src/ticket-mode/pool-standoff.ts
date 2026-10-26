// @ts-check
// module: the pool's side of a stand-off (A11-290) -- recording a re-review the verdict door refused, routing it, and settling the planner's round
//
// A RE-REVIEW THAT STAYS NOT CONVINCED AT AN UNCHANGED HEAD IS NEVER LOST. The door refuses a second review at an equal patch (exit 3) and keeps a copy of the verdict file it refused beside it; when the re-review's reviewer has ended and the block
// still stands, `recordRefusedRereview` reads that file, logs `rereview: still not convinced` with the reasons on the run, opens the stand-off, and posts the result as a comment on the pull request. `startStandoffRound` then routes the stand-off once
// for each head: to the planner when the worker's reply disputes a decision (only the planner can change one), else to the worker. `settlePlannerRound` takes the planner's decision, attaches an amended plan, and leaves the re-review to the sweep:
// the plan's decisions are in the re-review's brief and its look, so an amended decision is a new answer and the reviewer re-reviews bound by it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { reviewVerdict as readVerdict } from "../review-verdict.ts";
import type { Reply } from "../plugins/contracts/code-host.ts";
import { pullsOf } from "./board-view/view-types-and-filters.ts";
import { type PoolContext } from "./pool-context.ts";
import { log, messageOf, runPlace, update } from "./pool-state.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { planDecisions } from "./pool-ticket-text.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { type PlannerDecision } from "./queue/standoff-types.ts";
import { plannerDecided, recordRereview, standoffRound, workerRoundEnded } from "./queue/queue-standoff.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { logHas } from "./queue/run-log.ts";
import { REVIEWER_LOGIN, standingBlock, type ReviewerPort, type ReviewState } from "./reviewer-port.ts";
import { decisionsOf } from "./ticket-decisions.ts";
import { STANDOFF_DECISION_FILE } from "./standoff-files.ts";
import { disputedDecision } from "./standoff-dispute.ts";
import { isRereviewComment, rereviewComment, standoffPlannerFeedback, standoffWorkerFeedback } from "./standoff-words.ts";

/** The most of the worker's replies a stand-off keeps, in characters. */
const REPLIES_KEPT = 6000;

/** The run of the queue that holds the pull request at `url`, or undefined when none does (one a person opened, or a run since removed). */
export const heldBy = (ctx: PoolContext, url: string): Entry | undefined => ctx.store.get().entries.find((entry) => pullsOf(entry).some((pull) => pull.url === url));

/** The text of the reviewer's newest block in the pull request as the host gave it (`view.reviews`, the gate's read), or null when the read carries none. */
function blockTextOf(state: ReviewState): string | null {
  const reviews: unknown = state.view.reviews;
  if (!Array.isArray(reviews)) return null;
  const mine = reviews.filter((review: any) => review?.state === "CHANGES_REQUESTED" && String(review?.author?.login ?? review?.author ?? "").toLowerCase().startsWith(REVIEWER_LOGIN));
  const body: unknown = mine.at(-1)?.body;
  return typeof body === "string" && body.trim() !== "" ? body.trim() : null;
}

/** The verdict file the re-review's reviewer left, when it was written since the re-review began (`since`) and carries a verdict: its text and its word. Null otherwise. */
function refusedVerdictOf(reviewer: ReviewerPort, ref: { pr: string; head: string }, since: number): { text: string; verdict: "convinced" | "not-convinced" } | null {
  const file = reviewer.verdictFileOf(ref);
  if (file === null) return null;
  try {
    if (statSync(file).mtimeMs < since) return null;
    const text = readFileSync(file, "utf8");
    const { verdict } = readVerdict(text);
    return verdict === "convinced" || verdict === "not-convinced" ? { text, verdict } : null;
  } catch {
    return null;
  }
}

/** Posts the record of a refused re-review on its pull request, as the code host's `commentOnPull` does. A host without it is said once, and a post that fails is said: the result is in the run's log either way. */
function commentRefused(ctx: PoolContext, url: string, comment: string): void {
  const { codeHost, refusedHeads } = ctx;
  if (codeHost.commentOnPull === undefined) {
    if (!refusedHeads.has("no-commentOnPull")) log("the code host cannot comment on a pull request, so a refused re-review is recorded in the run's log alone");
    refusedHeads.add("no-commentOnPull");
    return;
  }
  try {
    codeHost.commentOnPull(url, comment);
  } catch (err) {
    log(`${url}: the result of the refused re-review could not be commented on the pull request (${messageOf(err).split("\n")[0]}); it is in the run's log`);
  }
}

/**
 * A RE-REVIEW THE VERDICT DOOR REFUSED IS RECORDED (A11-290): the head was re-reviewed (`reviewerRereviewed`), its reviewer has ended or is gone, the block still stands (no second review was posted), and the reviewer left a verdict file written
 * since the re-review began. Its verdict and reasons are logged on the run that holds the pull request, as a `rereview` event ("rereview: still not convinced"), the stand-off is opened for a `not convinced` one, and the result is commented on
 * the pull request. Once for each re-review: the log is what says it was done, or, for a pull request no run holds, the pool's memory of the sweep. `repliesSince` reads the worker's replies after the block, or null when they could not be read.
 */
export function recordRefusedRereview(ctx: PoolContext, reviewer: ReviewerPort, url: string, state: ReviewState, repliesSince: (since: number) => readonly Reply[] | null): void {
  const { head } = state;
  const key = `${url}@${head}`;
  const look = ctx.reviewerMemory.looks.get(key);
  const block = standingBlock(state.reviews, head);
  const ref = { pr: url, head };
  const rereviewEnded = ctx.reviewerRereviewed.has(key) && reviewer.settled(ref) !== "working";
  if (look === undefined || block === null || !rereviewEnded) return;
  const refused = refusedVerdictOf(reviewer, ref, look.at);
  if (refused === null) return;
  const held = heldBy(ctx, url);
  const memo = `${key}#rereview-recorded@${look.at}`;
  const done = held === undefined ? ctx.refusedHeads.has(memo) : logHas(ctx.store.get(), held.ticket.key, (event) => event.kind === "rereview" && event.url === url && event.head === head && event.at >= look.at);
  if (done) return;
  ctx.refusedHeads.add(memo);
  const replies = (repliesSince(block.at) ?? []).filter(({ text }) => !isRereviewComment(text));
  const reply = replies.length === 0 ? null : replies.map(({ text }) => text.trim()).join("\n\n").slice(-REPLIES_KEPT);
  log(`${url}: the re-review at ${head.slice(0, 8)} ended ${refused.verdict === "not-convinced" ? "still not convinced" : "convinced, but the verdict door refused it"}; recorded`);
  if (held !== undefined) update(ctx, (queue) => recordRereview(queue, held.ticket.key, { url, head, review: blockTextOf(state), verdict: refused.verdict, reasons: refused.text, reply }, ctx.now()));
  commentRefused(ctx, url, rereviewComment(head, refused.verdict, refused.text));
}

/**
 * Routes the open stand-off of a finished run, once for each head (A11-290): a round of the planner when the worker's reply disputes a decision of the plan or the ticket and this machine has a planner, else a round of the worker, which carries the
 * re-reviewer's reasons. A stand-off the planner has decided goes to the worker, with what the planner decided. Returns whether a round was queued; the stand-off of a head the pull request has left is not routed (the heads' record settles it).
 */
export function startStandoffRound(ctx: PoolContext, entry: Entry): boolean {
  const { standoff } = entry;
  if (standoff === undefined || (standoff.stage !== "open" && standoff.stage !== "planned")) return false;
  if (entry.pullHeads?.[standoff.url]?.head !== standoff.head) return false;
  const disputed = standoff.stage === "open" && ctx.settings.planner !== null
    ? disputedDecision(standoff.reply === null ? [] : [standoff.reply], [planDecisions(ctx, entry.ticket.key), decisionsOf(entry.ticket.description)])
    : null;
  const stage = disputed === null ? "worker" : "planner";
  log(`${entry.ticket.key}: ${standoff.url} stayed not convinced at ${standoff.head.slice(0, 8)}; the stand-off goes to ${stage === "planner" ? `the planner (the worker's reply disputes a decision: ${disputed})` : "the worker"}`);
  update(ctx, (queue) => standoffRound(queue, entry.ticket.key, stage, stage === "planner" ? standoffPlannerFeedback(standoff) : standoffWorkerFeedback(standoff), ctx.now()));
  return true;
}

/** What the planner's round wrote in {@link STANDOFF_DECISION_FILE}, or why it is no decision. */
function decisionOf(dir: string): PlannerDecision | string {
  const path = join(dir, STANDOFF_DECISION_FILE);
  if (!existsSync(path)) return `the planner's round wrote no ${STANDOFF_DECISION_FILE}`;
  try {
    const { decision, reason } = JSON.parse(readFileSync(path, "utf8")) as { decision?: unknown; reason?: unknown };
    if (decision !== "amended" && decision !== "upheld") return `${path} needs decision: "amended" or "upheld"`;
    if (typeof reason !== "string" || reason.trim() === "") return `${path} needs a reason, in words`;
    return { decision, reason: reason.trim() };
  } catch (err) {
    return `${path} cannot be read (${messageOf(err).split("\n")[0]})`;
  }
}

/** What settling a stand-off round decided: the decision it took, or the words that hand the run to a person because it could not be taken. */
export type StandoffSettled = Readonly<{ decided: PlannerDecision } | { refused: string }>;

/**
 * The planner's round ended `reviewed`: its decision is read from the run's folder. An `upheld` decision ends the round; an `amended` one first attaches the amended plan (`attachAmended`, which answers null once it is attached, else the words that
 * refuse it) and ends the round only then. Answers the decision for the caller to end the run with and record, or the refusal.
 */
export async function settlePlannerRound(ctx: PoolContext, entry: Entry, attachAmended: () => Promise<string | null>): Promise<StandoffSettled> {
  const read = decisionOf(runPlace(ctx, entry).dir);
  if (typeof read === "string") return { refused: read };
  if (read.decision === "amended") {
    const refused = await attachAmended();
    if (refused !== null) return { refused };
  }
  return { decided: read };
}

/** The planner's round ended with `decided`: record it on the run, which has finished by now. */
export const recordPlannerDecision = (ctx: PoolContext, key: string, decided: PlannerDecision): void => update(ctx, (queue) => plannerDecided(queue, key, decided, ctx.now()));

/** The worker's round for the stand-off ended: both routes that apply have ended. */
export const recordWorkerRoundEnded = (ctx: PoolContext, key: string): void => update(ctx, (queue) => workerRoundEnded(queue, key));
