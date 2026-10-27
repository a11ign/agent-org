// @ts-check
// module: an access hand-back that says the run lost the right to push is checked by the board with a push, before it reaches a person (A11-346)
//
// A WORKER'S CLAIM OF LOST PUSH ACCESS IS NOT EVIDENCE, AND THE BOARD CAN TEST IT. On 2026-10-27 A11-229's worker ended `needs-human` under the access item: a `git push` got a 403 (its text not kept) and `gh api repos/<repo>` read
// `permissions.push=false`. That field reads false for every repository under an App installation token, so it proves nothing, and the 403 was transient: the chairman's session pushed the same commits from the worker's checkout 35 minutes later and
// GitHub took them. The card sat in Needs you for that long.
//
// THE BOARD PUSHES FIRST. Before such a hand-back ends the run, the board runs, in each checkout of the run and as the account its git is configured for there (the workers' own), a dry-run push of the ticket's branch and then a real push of the
// run's unpushed commits, and tries the pair once more when it fails. A push that works is logged on the run (`push-check`), the worker is told access is fine, and no card is raised. A push that fails twice keeps the card, with git's own
// words appended to the worker's reason and to the log. A hand-back that is not about pushing, and a run with no checkout to push from, is not checked.
import { type Git } from "./worktree.ts";
import { type PoolContext } from "./pool-context.ts";
import { type Entry, type Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { isPlanning, runPlace } from "./pool-state.ts";
import { isCapPlanner } from "./queue/queue-cap.ts";
import { isParked } from "./board-view/pull-status-and-notes.ts";
import { worktreesIn } from "./pool-paths.ts";
import { sendToAgent } from "./pool-resume.ts";
import { markOutcomeStale } from "./pool-outcome.ts";
import { OUTCOME_FILE } from "./worker-files.ts";
import { MS_PER_SECOND } from "./attach-retry.ts";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** How many times the board tries the pair of pushes before it keeps the card: the first, and one retry. */
export const PUSH_TRIES = 2;

/** The longest a push may take before the board counts it as failed, so a hung connection does not hold the run's settle for ever. */
export const PUSH_TIMEOUT_MS = 120_000;

/** The most of git's error the log and the card carry. */
export const PUSH_ERROR_CHARS = 1500;

/** The words of an access hand-back that is about pushing: a push, and a refusal of it or a claim about the right to it. PURE over the reason. */
const PUSHING = /\bpush(?:ed|es|ing)?\b/i;
const REFUSED = /\b403\b|denied|forbidden|permissions\.push|read-only|unauthori[sz]ed|lost (?:the )?(?:write |push )?access|remote: /i;

/** Whether `outcome` is an access hand-back whose reason says a push was refused or the right to push is gone. PURE. */
export const claimsLostPush = (outcome: Outcome): outcome is Extract<Outcome, { kind: "needs-human" }> =>
  outcome.kind === "needs-human" && outcome.escalation === "access" && PUSHING.test(outcome.reason) && REFUSED.test(outcome.reason);

/** What came of the board's own pushes: all of them worked, the error of the last failure in git's words, or `unchecked` when no checkout of the run is on the ticket's branch, so there is nothing of the worker's to push. */
export type PushCheck = Readonly<{ ok: true; repos: readonly string[] } | { ok: false; error: string } | { unchecked: true }>;

/**
 * Whether the board may test the hand-back of this run by pushing: the run is live (running, or parked with its pane open) and is a worker's own, not a planning run, a talk session or the planner of a round cap or a stand-off, whose
 * hand-back is not about pushing a branch. A run that already finished with no pane is settled by `end` as it always was. PURE.
 */
export const isWorkersOwnRun = (ctx: PoolContext, entry: Entry): boolean =>
  (entry.phase === "running" || isParked(entry)) && entry.talk !== true && !isPlanning(ctx, entry) && !isCapPlanner(entry) && entry.standoff?.stage !== "planner";

/** The error of a failed git call as git said it: its stderr (the `remote:` lines among them), else its message, cut to {@link PUSH_ERROR_CHARS}. PURE. */
export function gitErrorText(err: unknown): string {
  const { stderr, message } = (err ?? {}) as { stderr?: unknown; message?: unknown };
  const text = [stderr, message].find((part): part is string => typeof part === "string" && part.trim() !== "") ?? String(err);
  const trimmed = text.trim();
  return trimmed.length > PUSH_ERROR_CHARS ? `${trimmed.slice(0, PUSH_ERROR_CHARS - 1)}…` : trimmed;
}

/** Run `git` and fail with a timeout's words if it does not answer in {@link PUSH_TIMEOUT_MS}. */
async function withinTime<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the push did not answer in ${PUSH_TIMEOUT_MS / MS_PER_SECOND} seconds`)), PUSH_TIMEOUT_MS); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The dry run, then the real push of the checkout's HEAD to the ticket's branch: null when both worked, else git's error. The hooks are not run: the board tests the right to push, not the code. */
async function pushOnce(git: Git, worktree: string, branch: string): Promise<string | null> {
  const to = ["origin", `HEAD:refs/heads/${branch}`];
  try {
    await withinTime(git(worktree, ["push", "--dry-run", "--no-verify", ...to]));
    await withinTime(git(worktree, ["push", "--no-verify", ...to]));
    return null;
  } catch (err) {
    return gitErrorText(err);
  }
}

/** The checkouts of the run the board can push from: the repositories under its folder that hold a git worktree. */
export const checkoutsOf = (ctx: PoolContext, entry: Entry): readonly string[] => worktreesIn(runPlace(ctx, entry).folder);

/** The branch a checkout is on, or git's error when it cannot be read (a broken repository, a missing `.git` target). */
async function branchOf(git: Git, worktree: string): Promise<{ branch: string } | { error: string }> {
  try {
    return { branch: (await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() };
  } catch (err) {
    return { error: gitErrorText(err) };
  }
}

/**
 * Push the run's branch from each of its checkouts that is on it (a checkout left on another branch or detached holds none of the ticket's work), with the dry run first and one retry of the pair ({@link PUSH_TRIES}). Every checkout must work for the check to pass; the first that fails twice ends it with git's error, named by repository.
 * Pushing the run's own unpushed commits to its own branch is what the worker does, so a push that works leaves the branch as the worker would have.
 */
export async function checkPush(ctx: PoolContext, entry: Entry, repos: readonly string[]): Promise<PushCheck> {
  const { folder } = runPlace(ctx, entry);
  const heads = await Promise.all(repos.map((repo) => branchOf(ctx.git, join(folder, repo))));
  // A checkout whose branch cannot be read is not skipped: the board cannot tell whether it holds the worker's work, so the check fails with git's words and the card stays.
  const unreadable = heads.findIndex((head) => "error" in head);
  if (unreadable !== -1) return { ok: false, error: `${repos[unreadable]}: could not read its branch: ${(heads[unreadable] as { error: string }).error}` };
  const pushable = repos.filter((_, at) => (heads[at] as { branch: string }).branch === entry.ticket.branch);
  if (pushable.length === 0) return { unchecked: true };
  for (const repo of pushable) {
    let error: string | null = null;
    for (let attempt = 0; attempt < PUSH_TRIES; attempt += 1) {
      error = await pushOnce(ctx.git, join(folder, repo), entry.ticket.branch);
      if (error === null) break;
    }
    if (error !== null) return { ok: false, error: `${repo}: ${error}` };
  }
  return { ok: true, repos: pushable };
}

/** The worker's reason with the board's finding after it: the pushes were tried twice and git's words. PURE. */
export const reasonWithGitError = (reason: string, error: string): string =>
  `${reason}\n\nThe board tried the push itself from the run's checkout (a dry run, then a real push, ${PUSH_TRIES} times) and it failed:\n${error}`;

/** The one-line prompt that wakes a worker whose access the board has shown to be fine. PURE. */
export const accessIsFinePrompt = (repos: readonly string[]): string =>
  `The board checked your claim that you lost push access: a dry-run push and a real push of ${repos.join(", ")} from your checkout worked, so access is fine, carry on. The 403 you saw was transient or from the wrong identity. `
  + "`permissions.push` reads false under an App installation token and is not evidence; retry a failed push once and quote the full `remote:` lines of the error. Push again, finish the work, and write the outcome file again as the last thing you do.";

/**
 * Tell the run's worker access is fine, and mark the outcome it wrote stale so its next one is read, as a send-back does. False, with the run left as it is, when herdr would not take the message: the card then stands.
 */
export function wakeWorker(ctx: PoolContext, entry: Entry, repos: readonly string[]): boolean {
  const place = runPlace(ctx, entry);
  if (sendToAgent(ctx, place, accessIsFinePrompt(repos)) !== null) return false;
  const written = join(place.dir, OUTCOME_FILE);
  markOutcomeStale(place.dir, existsSync(written) ? statSync(written).mtimeMs : ctx.now());
  return true;
}
