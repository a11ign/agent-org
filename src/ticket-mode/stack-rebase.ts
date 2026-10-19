// @ts-check
// module: the branch a stacked run was built on -- where it is recorded, when agent-org rebases the run onto it, and how the rebase is made
//
// A RUN STACKED ON A BLOCKER'S BRANCH IS REBASED BY AGENT-ORG, NEVER BY ITS WORKER. The worker is told not to rebase, merge the base in or force-push
// (`worker-files.ts`), because a base rewritten under it would have its own commits replayed twice. So when the blocker's branch moves, the pool does it
// here: from the commit the worktree was branched at (the recorded `sha`, never a merge-base, which after a force-push is an older commit), onto the
// branch's new head, and pushes the run's own branch with a lease. A rebase that conflicts is aborted and left to a person.
//
// THE RECORD IS WRITTEN BY `ticket:worktree --from`, beside the ticket's files: `stack-base.json` says which repository, branch and commit the worktree
// was made from. The pool reads it, and keeps that commit reachable in the clone (`refs/agent-org/stack/...`), so a force-pushed-away commit survives `gc`.
//
// ASYNCHRONOUS git, through the same `Git` the worktrees use, so a test runs it on real repositories in temporary directories.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StackBaseRecord } from "./board-view/view-ticket.ts";
import { find, type Queue } from "./queue/declared-remains.ts";
import { ticketDir } from "./ticket-paths.ts";
import type { TicketSettings } from "./settings.ts";
import type { Git } from "./worktree.ts";

/** The file `ticket:worktree --from` writes beside a ticket's files: the repository, branch and commit its worktree was made from. */
export const STACK_BASE_FILE = "stack-base.json";

/** What `stack-base.json` holds. */
export type StackBaseFile = Readonly<{ repo: string; branch: string; sha: string }>;

/** The stacked branch a run carries now, as the queue holds it: a rebase writes it back on top of what is there, not on a copy read before it. PURE. */
export const stackBaseIn = (queue: Queue, key: string, fallback: StackBaseRecord): StackBaseRecord => find(queue, key)?.stackBase ?? fallback;

/** The first line of an error, which is the one a board row can show. PURE. */
export const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0];

/**
 * The commit a remote branch is at, from `git ls-remote origin refs/heads/<branch>`: its line's sha when the ref is exactly that branch, else null (the branch
 * is not pushed). PURE over that command's output.
 */
export function parseRemoteHead(lsRemote: string, branch: string): string | null {
  const line = lsRemote.split("\n").find((text) => text.trim() !== "");
  if (line === undefined) return null;
  const [sha, ref] = line.split("\t");
  return ref === `refs/heads/${branch}` && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** The commit `branch` is at on the remote of `clone`, or null when it is not pushed there. */
export async function remoteHead(git: Git, clone: string, branch: string): Promise<string | null> {
  return parseRemoteHead(await git(clone, ["ls-remote", "origin", `refs/heads/${branch}`]), branch);
}

/**
 * Whether a run's stack is due a rebase: the blocker's branch is pushed (`head`) at a commit other than the one the run was branched from, and no rebase
 * has already failed against that head. Nothing is retried in a loop: a failure is tried again only once the branch is at another head. PURE.
 */
export function rebaseDue(record: Pick<StackBaseRecord, "sha" | "failed">, head: string | null): head is string {
  return head !== null && head !== record.sha && record.failed?.head !== head;
}

/** The path of a ticket's `stack-base.json`, beside its brief. */
export const stackBaseFile = (settings: TicketSettings, key: string): string => join(ticketDir(settings, key), STACK_BASE_FILE);

/** Write a ticket's `stack-base.json`, creating its folder. */
export function writeStackBase(path: string, base: StackBaseFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(base)}\n`);
}

/** Read a ticket's `stack-base.json`, or null when there is none or it is not the record `writeStackBase` writes. */
export function readStackBase(path: string): StackBaseFile | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const { repo, branch, sha } = (value ?? {}) as Record<string, unknown>;
    return typeof repo === "string" && typeof branch === "string" && typeof sha === "string" ? { repo, branch, sha } : null;
  } catch {
    return null;
  }
}

/** The ref that keeps a stack's base commit reachable in its repository's clone, so a force-pushed-away commit survives `gc` (A11-116). PURE. */
export const stackRef = (ticket: string, blocker: string): string => `refs/agent-org/stack/${ticket}/${blocker}`;

/** Point `ref` at `sha` in `clone`. */
export async function protectStack(git: Git, clone: string, ref: string, sha: string): Promise<void> {
  await git(clone, ["update-ref", ref, sha]);
}

/** Delete `ref` in `clone`, once the run it protects has finished and its pull requests have merged or closed. */
export async function releaseStack(git: Git, clone: string, ref: string): Promise<void> {
  await git(clone, ["update-ref", "-d", ref]);
}

/**
 * Why a review round cannot start on its stacked branch: the rebase onto the blocker's branch failed against the head it is at now, so the round would
 * start on a base that conflicts, and a person resolves it instead. PURE.
 */
export function roundHeldBy(record: StackBaseRecord, head: string | null): string | null {
  return record.failed !== undefined && record.failed.head === head ? `Rebase onto ${record.key} ${record.failed.reason}: a person resolves it` : null;
}

/**
 * The result of a rebase onto a blocker's branch: the commit the stack was at, the commit it is at now, or why it was not made. `conflict` is set when the
 * rebase conflicted, which a person resolves; any other failure (a fetch, a refused push) is tried again on the next sweep.
 */
export type RebaseResult = Readonly<{ ok: true; from: string; to: string }> | Readonly<{ ok: false; reason: string; conflict?: true }>;

/**
 * Rebase the run's branch, `own`, in `worktree` onto `base.branch` on the remote, from the commit the worktree was branched at (`base.sha`), and push it with
 * a lease to `own`. A conflict is aborted and the branch is left as it was: its reason names the files. A refused push puts the branch back where it was
 * before the rebase. Never a merge-base: after a force-push the merge-base is an older commit, and replaying from it would repeat the blocker's commits.
 */
export async function rebaseOnto({ git, clone, worktree, own, base }: {
  git: Git; clone: string; worktree: string; own: string; base: Pick<StackBaseRecord, "branch" | "sha">;
}): Promise<RebaseResult> {
  try {
    await git(worktree, ["fetch", "--quiet", "origin", base.branch]);
  } catch (err) {
    return { ok: false, reason: `could not fetch ${base.branch}: ${firstLine(err)}` };
  }
  const to = (await git(worktree, ["rev-parse", `origin/${base.branch}`])).trim();
  const before = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  // The run's own branch, as the remote has it now: the lease expects that commit and no other.
  const expect = (await remoteHead(git, clone, own)) ?? "";
  try {
    await git(worktree, ["rebase", "--onto", `origin/${base.branch}`, base.sha]);
  } catch (err) {
    const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim().split("\n").filter((file) => file !== "");
    await git(worktree, ["rebase", "--abort"]).catch(() => undefined);
    return files.length > 0 ? { ok: false, reason: `conflicted in ${files.join(", ")}`, conflict: true } : { ok: false, reason: `could not be rebased: ${firstLine(err)}` };
  }
  try {
    await git(worktree, ["push", `--force-with-lease=${own}:${expect}`, "origin", `HEAD:${own}`]);
  } catch (err) {
    await git(worktree, ["reset", "--hard", before]).catch(() => undefined);
    return { ok: false, reason: `was refused by the remote: ${firstLine(err)}` };
  }
  return { ok: true, from: base.sha, to };
}

/**
 * The record after a rebase attempt: on success the run is branched from the new head, with the rebase kept for the board; on failure it keeps its branch and
 * records the head and the reason, so nothing is retried until the blocker's branch is at another head. PURE.
 */
export function afterRebase(record: StackBaseRecord, head: string, result: RebaseResult, now: number): StackBaseRecord {
  if (!result.ok) return result.conflict === true ? { ...record, seen: head, failed: { head, reason: result.reason } } : { ...record, seen: head };
  const { seen: _seen, failed: _failed, ...kept } = record;
  return { ...kept, sha: result.to, rebased: { from: result.from, to: result.to, at: now } };
}
