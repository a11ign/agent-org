// @ts-check
// module: the pure pieces of a reviewer's start and end, shared by the synchronous forms (`reviewer-tokens-and-checkouts.ts`, row mode's) and the async ones (`reviewer-start-async.ts`, the reviewer port's) (A11-379)
//
// Only what both forms read lives here: the `git` calls that make and remove a review tree, the texts of their refusals, the mint's environment and its refusals. No program is run here. The sequencing of the calls
// stays in each form, and `reviewer-start-async.test.ts` holds the two to the same calls in the same order and the same answers.
import { tokenNeedsRefresh } from "../app-token-cache.ts";
import type { AppIdentity } from "../host-config.ts";
import { firstLine } from "../herdr-agents.ts";
import { REVIEWER_TOKEN_REFRESH_SECONDS } from "./pull-request-spawn-orders.ts";
import type { LinkResult } from "./reviewer-tokens-and-checkouts.ts";

/** How long one `git` call of a review tree may run. */
export const GIT_TIMEOUT_MS = 30_000;

/** How long a tree's install may run: the tick waits on it, so a registry that hangs must end in a refusal, not a stalled tick. */
export const TREE_INSTALL_TIMEOUT_MS = 300_000;

/**
 * What an outside reviewer's checkout says in its prompt in place of the dependencies line: nothing is linked and nothing is run, so the
 * Acceptance is read for what it asks, and not run (#1311).
 */
export const OUTSIDE_CHECKOUT_NOTE = "Nothing is linked in this checkout and nothing in it is run: the pull request is read, so the Acceptance is read for what it asks and is not run.";

/**
 * The `git` calls that make and remove a review tree, spelled once for the synchronous forms (`reviewer-tokens-and-checkouts.ts`) and the async ones (`reviewer-start-async.ts`). Each is what FOLLOWS `-C <checkout>`: the
 * call sites write the `-C` and the checkout themselves, so each names the repository it asks (`git-reads-name-their-checkout.test.ts` reads them as text).
 */
export const REVIEW_GIT = {
  fetch: (pr: number, ref: string) => ["fetch", "--quiet", "origin", `+refs/pull/${pr}/head:${ref}`],
  head: (ref: string) => ["rev-parse", "--verify", ref],
  detach: (head: string) => ["checkout", "--quiet", "--detach", head],
  add: (path: string, head: string) => ["worktree", "add", "--quiet", "--force", "--detach", path, head],
  at: () => ["rev-parse", "HEAD"],
  remove: (path: string) => ["worktree", "remove", "--force", path],
  dropRef: (ref: string) => ["update-ref", "-d", ref],
};

/** The refusal when the tree is not at the head asked for or is not there, else `null`. PURE. */
export function checkoutMismatch({ pr, path, head, at, present }: { pr: number; path: string; head: string; at: string; present: () => boolean; }): { refusal: string; } | null {
  return at !== head || !present() ? { refusal: `no review checkout: ${path} is at ${at || "nothing"}, not PR #${pr}'s head ${head}` } : null;
}

/** The refusal when a git call of the checkout threw. PURE. */
export const checkoutRefusal = (pr: number, path: string, err: unknown): { refusal: string; } => ({ refusal: `no review checkout for PR #${pr} at ${path} (${firstLine(err)})` });

/** What the checkout answers once its dependency step answered `unlinked`: the tree, with the note the step gave, or the refusal naming the step's reason. PURE. */
export function linkedCheckout({ pr, path, head }: { pr: number; path: string; head: string; }, unlinked: LinkResult): { path: string; head: string; note?: string; } | { refusal: string; } {
  if (typeof unlinked === "string") return { refusal: `no review dependencies for PR #${pr} at ${path} (${unlinked})` };
  return unlinked === null ? { path, head } : { path, head, note: unlinked.note };
}

/** What every ledger line of one removal says about it. PURE. */
export const removalLine = (path: string, session: string) => ({ path, caller: "wake.ts removeReviewCheckout", reason: `the reviewer instance ${session} ended (#2401)` });

/** Does the token cache in `dir` need a new mint at `now` (ms)? */
export const tokenIsStale = (dir: string, now: number): boolean => tokenNeedsRefresh({ cacheDir: dir, role: "reviewer", now: now / 1000, marginSeconds: REVIEWER_TOKEN_REFRESH_SECONDS });

/** The mint's whole environment: a PATH and the app's identity, with the scratch directory it writes the token into. The key is named here and nowhere else. PURE. */
export const mintEnvironment = (app: AppIdentity, scratch: string): Record<string, string> => ({ PATH: process.env.PATH ?? "", A11Y_APP_ID: app.appId, A11Y_APP_KEY_PATH: app.keyPath, A11Y_APP_TOKEN_DIR: scratch,
  ...(app.installationId === undefined ? {} : { A11Y_APP_INSTALLATION_ID: app.installationId }) });

/** The refusal when the mint exited non-zero, from what it printed on stderr or why it could not start. PURE. */
export const mintRefusal = (reason: unknown): string => `the reviewer's app token could not be minted: ${firstLine(reason || "no reason was given")}`;

/** The refusal when the token cache could not be written (a checkout that is a file, a read-only disk). PURE. */
export const tokenCacheRefusal = (dir: string, cause: unknown): string => `the reviewer's token cache at ${dir} could not be refreshed: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`;


/** The refusal when the reviewer's token could not be put in its tree. PURE. */
export const mintedRefusal = (session: string, reason: string): { refusal: string; } => ({ refusal: `no reviewer spawn for "${session}": ${reason}` });
