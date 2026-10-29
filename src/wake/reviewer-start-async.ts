// @ts-check
// module: the steps of a reviewer's start and end that spawn a program, answering a promise (A11-379)
//
// The reviewer port (`plugins/atomic-reviewer/port.ts`) used to make every step of a start as a synchronous spawn on the board's thread: the checkout's `git`, the tree's install, the token mint, `herdr` and the
// verdict door held the loop about nine times, about 10 s, for each reviewer started. These are the same steps over async runners (`realExecAsync`, `herdrRunAsync`), each with its synchronous form's arguments and
// answers but for the runners and the promise. The synchronous forms stay: row mode (`wake.ts`) still starts its reviewers through them (ADR 0002 keeps row mode).
//
// ONLY THE SEQUENCING OF AWAITED CALLS IS WRITTEN TWICE. Every pure piece the two forms share (the `git` arguments, the refusal texts, the install's reading of what failed, the mint's environment) is exported from the
// file it lives in and called by both, and `reviewer-start-async.test.ts` holds each pair to the same program calls, in the same order, and the same answer, for a success and for each refusal.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppIdentity } from "../host-config.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { pnpmCliInvocation } from "../lib/npm-cli-executable.ts";
import { INSIDE, OUTSIDE, type ReviewTrust } from "../review-trust.ts";
import { recordRemoval } from "../worktree-removal.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { closedNoteAsync, firstLine, herdrRunAsync, openPaneAsync, programFailure } from "../herdr-agents.ts";
import { realExecAsync } from "../plugins/real-seams.ts";
import type { ExecOptions } from "../plugins/manifest.ts";
import type { Depth } from "../review-depth.ts";
import { APP_TOKEN_MINT_TIMEOUT_MS, APP_TOKEN_SCRIPT, REVIEW_CHECKOUT_ROOT, reviewCheckoutPath, reviewerTokenDir, type ReviewerApp, type ReviewerEntry } from "./pull-request-spawn-orders.ts";
import { uncommittedPathsIn, UNCOMMITTED_STATUS } from "./ci-class-and-spares.ts";
import { closeReviewerAsync } from "./seat-reset.ts";
import { GIT_TIMEOUT_MS, OUTSIDE_CHECKOUT_NOTE, REVIEW_GIT, TREE_INSTALL_TIMEOUT_MS, checkoutMismatch, checkoutRefusal, linkedCheckout, mintEnvironment, mintRefusal, mintedRefusal, removalLine, tokenCacheRefusal, tokenIsStale } from "./reviewer-start-steps.ts";
import { REAL_LINK_FS, clearedBeforeInstall, installArgs, installFailed, installFinished, keyedPlan, linkCloneEntries, linkReviewDependencies, paneEnvironment, reviewRef, reviewRepoRootOf, reviewTreeLocation, reviewerToStart,
  startInvocation, startRefusal, type CheckoutDeps, type LinkFs, type LinkResult } from "./reviewer-tokens-and-checkouts.ts";

export { closeReviewerAsync };

/** A `git` that answers a promise: the synchronous `git`'s arguments (`cwd` and `timeout` of its options are the ones read), and it rejects as the synchronous one throws. */
export type GitAsync = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; }) => Promise<string>;

/** A tree's install, answering a promise: it rejects on a non-zero exit with the child's output on the error. */
export type TreeInstallAsync = (run: { cwd: string; args: string[]; }) => Promise<void>;

/** The checkout's dependencies as the async forms take them: a `git` that answers a promise, and a dependency step that may. The rest are the synchronous forms'. */
export type CheckoutDepsAsync = Omit<CheckoutDeps, "git" | "link"> & { git?: GitAsync; link?: (args: { path: string; repoRoot: string; }) => LinkResult | Promise<LinkResult>; };

/** The environment options that give a program exactly `env` and nothing of this process's: what `spawnSync` with an `env` does, which `realExecAsync` (it lays `env` over this process's) does not. */
const exactly = (env: Record<string, string>): Pick<ExecOptions, "env" | "withoutEnv"> => ({ env, withoutEnv: Object.keys(process.env).filter((name) => !(name in env)) });

/** Runs `file` and resolves its stdout, or rejects with {@link programFailure}'s error: the async form of `execFileSync`. */
async function runProgram(file: string, args: string[], options: ExecOptions): Promise<string> {
  const answer = await realExecAsync(file, args, options);
  if (answer.status === 0) return answer.stdout;
  throw programFailure(file, args, answer);
}

/** The variables of this process that `sandboxGitEnv` removes (every `GIT_*`), as the names `realExecAsync` takes off a program's environment. */
function withoutGitEnv(): string[] {
  const scrubbed = sandboxGitEnv();
  return Object.keys(process.env).filter((name) => !(name in scrubbed));
}

/** The one real `git` of the async forms: 30 s, with every `GIT_*` variable of this process taken off (what `sandboxGitEnv` does), as the synchronous `defaultGit` runs it. */
export const defaultGitAsync: GitAsync = (cmd, args, opts) => runProgram(cmd, args, { timeoutMs: opts?.timeout ?? GIT_TIMEOUT_MS,
  withoutEnv: withoutGitEnv(),
  ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }) });

/** The one real install: `pnpm` in `cwd`, bounded as the synchronous one is. */
export const defaultInstallAsync: TreeInstallAsync = async ({ cwd, args }) => {
  const pnpm = pnpmCliInvocation(args);
  await runProgram(pnpm.command, pnpm.args, { cwd, timeoutMs: TREE_INSTALL_TIMEOUT_MS });
};

/** {@link import("./reviewer-tokens-and-checkouts.ts").linkKeyedDependencies} over an async install. */
export async function linkKeyedDependenciesAsync({ path, repoRoot, fs, install = defaultInstallAsync }: { path: string; repoRoot: string; fs: LinkFs; install?: TreeInstallAsync; }): Promise<LinkResult> {
  const plan = keyedPlan(fs, path, repoRoot);
  if ("answer" in plan) return plan.answer;
  if (plan.missing.length === 0) return linkCloneEntries({ fs, path, modules: plan.modules });
  const facts = { fs, path, repoRoot, declared: plan.names, missing: plan.missing };
  const cleared = clearedBeforeInstall(fs, path);
  if (cleared !== null) return cleared;
  try {
    await install({ cwd: path, args: installArgs(fs, path) });
  } catch (err) {
    return installFailed(facts, err);
  }
  return installFinished(facts);
}

/** The keyed clone's dependency step: it may install. */
const linkKeyed: NonNullable<CheckoutDepsAsync["link"]> = (where) => linkKeyedDependenciesAsync({ ...where, fs: REAL_LINK_FS });

/** The primary's dependency step: it links files and spawns nothing. */
const linkPrimary: NonNullable<CheckoutDepsAsync["link"]> = (where) => linkReviewDependencies(where);

/** {@link import("./reviewer-tokens-and-checkouts.ts").prepareReviewCheckout} over an async `git` and an async dependency step: the same tree, the same calls in the same order, the same answers. */
export async function prepareReviewCheckoutAsync({ pr, session, trust = INSIDE, git = defaultGitAsync, exists = existsSync, root = REVIEW_CHECKOUT_ROOT, repoRoot: given, link }:
  { pr: number; session: string; trust?: ReviewTrust; } & CheckoutDepsAsync): Promise<{ path: string; head: string; note?: string; } | { refusal: string; }> {
  const path = reviewCheckoutPath(session, root);
  const where = reviewTreeLocation(session, given);
  if ("refusal" in where) return where;
  const { repoRoot, ref: refOf } = where;
  const ref = refOf(pr);
  try {
    await git("git", ["-C", repoRoot, ...REVIEW_GIT.fetch(pr, ref)]);
    const head = (await git("git", ["-C", repoRoot, ...REVIEW_GIT.head(ref)])).trim();
    if (exists(path)) await git("git", ["-C", path, ...REVIEW_GIT.detach(head)]);
    // `worktree add` makes the missing parents of `path`, so the first tree needs no directory made for it.
    else await git("git", ["-C", repoRoot, ...REVIEW_GIT.add(path, head)]);
    const at = (await git("git", ["-C", path, ...REVIEW_GIT.at()])).trim();
    const moved = checkoutMismatch({ pr, path, head, at, present: () => exists(path) });
    if (moved !== null) return moved;
    if (trust === OUTSIDE) return { path, head, note: OUTSIDE_CHECKOUT_NOTE };
    const linkDependencies = link ?? (where.keyed ? linkKeyed : linkPrimary);
    return linkedCheckout({ pr, path, head }, await linkDependencies({ path, repoRoot }));
  } catch (err) {
    return checkoutRefusal(pr, path, err);
  }
}

/** {@link import("./reviewer-tokens-and-checkouts.ts").removeReviewCheckout} over an async `git`: the tree and its private ref removed, `null` when nothing is left, else why. */
export async function removeReviewCheckoutAsync({ pr, session, key = "", git = defaultGitAsync, exists = existsSync, root = REVIEW_CHECKOUT_ROOT, repoRoot: given, record = recordRemoval }:
  { pr: number; session: string; key?: string; } & CheckoutDepsAsync): Promise<string | null> {
  const path = reviewCheckoutPath(session, root);
  // #2969: a keyed tree is a worktree of its CLONE, so it is removed from there; the primary's `git worktree remove` would not know it.
  const where = given === undefined ? reviewRepoRootOf(session) : { repoRoot: given };
  if ("refusal" in where) return `could not remove ${path} (${where.refusal})`;
  const { repoRoot } = where;
  try {
    if (exists(path)) await removeLoggedCheckoutAsync({ path, session, git, repoRoot, record });
    if (exists(path)) return `${path} is still there after \`git worktree remove\``;
    await git("git", ["-C", repoRoot, ...REVIEW_GIT.dropRef(reviewRef(pr, key))]);
    return null;
  } catch (err) {
    return `could not remove ${path} (${firstLine(err)})`;
  }
}

/** The one `git worktree remove`, WITH its line: `removing` BEFORE the delete, `removed` or `failed` after. A line that cannot be written is a removal that does not happen. */
async function removeLoggedCheckoutAsync({ path, session, git, repoRoot, record }: { path: string; session: string; git: GitAsync; repoRoot: string; record: typeof recordRemoval; }): Promise<void> {
  const line = removalLine(path, session);
  record({ ...line, event: "removing" });
  try {
    await git("git", ["-C", repoRoot, ...REVIEW_GIT.remove(path)]);
  } catch (cause) {
    record({ ...line, event: "failed", detail: firstLine(cause) });
    throw cause;
  }
  record({ ...line, event: "removed" });
}

/** {@link import("./ci-class-and-spares.ts").uncommittedPathsOf} over an async `git`: it rejects when git cannot read the tree, so a caller that removes a tree never removes one it could not inspect. */
export async function uncommittedPathsOfAsync(path: string, git: GitAsync = defaultGitAsync): Promise<string[]> {
  return uncommittedPathsIn(await git("git", ["-C", path, ...UNCOMMITTED_STATUS]));
}

/** {@link import("./reviewer-tokens-and-checkouts.ts").spawnReviewer} over an async `herdr` and an async token mint: the same pane opened, the same agent started, the same refusals. */
export async function spawnReviewerAsync(order: { session: string; cause?: string; causeKey?: string; reviewDepth?: Depth; trust?: ReviewTrust; }, agents: { label: string; status: string; }[],
  { run = herdrRunAsync, env, cwd, registry, codexConfig, token, tmpBase }: {
    run?: (args: string[]) => Promise<string>; env?: Record<string, string>; cwd: string; tmpBase?: string;
    registry?: Record<string, ReviewerEntry>; codexConfig?: () => string | null; token?: (tree: string) => Promise<string | null>;
  }): Promise<{ label: string; workspace: string; profile: { kind: string; model: string; effort: string; }; } | { refusal: string; }> {
  const start = reviewerToStart(order, agents, registry);
  if ("refusal" in start) return start;
  const reviewer = start;
  const outside = order.trust === OUTSIDE;
  // agent-org#1348: THE TOKEN IS IN THE TREE BEFORE THE PANE OPENS, so the reviewer reads it and never the key. An outside reviewer has no app.
  const minted = outside || token === undefined ? null : await token(cwd);
  if (minted !== null) return mintedRefusal(reviewer.session, minted);
  const pane = await openPaneAsync(run, reviewer.session, paneEnvironment(reviewer.session, order.trust, env, cwd), cwd, { tmpBase });
  if ("refusal" in pane) return pane;
  const invocation = startInvocation(order, reviewer.session, pane.pane);
  if ("refusal" in invocation) return { refusal: `${invocation.refusal}${await closedNoteAsync(run, pane.workspace)}` };
  try {
    await run(invocation.args);
  } catch (err) {
    return { refusal: `${startRefusal(reviewer.session, err, codexConfig)}${await closedNoteAsync(run, pane.workspace)}` };
  }
  return { label: reviewer.session, workspace: pane.workspace, profile: invocation.profile };
}

/** The mint for a reviewer's token in `tree`, async: {@link ensureReviewerTokenAsync}, or the reason it cannot be asked when the app is unknown. */
export function reviewerTokenMinterAsync(app: ReviewerApp): (tree: string) => Promise<string | null> {
  return async (tree) => ("unknown" in app ? app.unknown : await ensureReviewerTokenAsync(tree, app.app));
}

/**
 * {@link import("./reviewer-tokens-and-checkouts.ts").ensureReviewerToken} with the mint run through `realExecAsync`: the token is minted into a scratch directory that is renamed over the old one only when it succeeds,
 * and the key reaches the mint's environment and nothing else's (the mint is given that environment and none of this process's).
 * @returns `null` when the token is good (or there is no app to mint for), else the reason it is not.
 */
export async function ensureReviewerTokenAsync(tree: string, app: AppIdentity | null, { now = Date.now(), script = APP_TOKEN_SCRIPT }: { now?: number; script?: string; } = {}): Promise<string | null> {
  if (app === null) return null;
  const dir = reviewerTokenDir(tree);
  try {
    if (!tokenIsStale(dir, now)) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(dir, "mint-"));
    try {
      const minted = await realExecAsync(process.execPath, [script, "reviewer"], { timeoutMs: APP_TOKEN_MINT_TIMEOUT_MS, ...exactly(mintEnvironment(app, scratch)) });
      if (minted.status !== 0) return mintRefusal(minted.stderr);
      renameSync(join(scratch, "reviewer.token"), join(dir, "reviewer.token"));
      return null;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch (cause) {
    return tokenCacheRefusal(dir, cause);
  }
}

/** The verdict door run through `realExecAsync`: the door is a script executed directly, with a PATH and a HOME and nothing else of this process's environment. It rejects with `status` and `stderr` on the error, as `runDoor` throws. */
export const runDoorAsync: (file: string, args: string[], env: Record<string, string>) => Promise<void> = async (file, args, env) => {
  await runProgram(file, args, exactly({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }));
};
