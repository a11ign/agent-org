// @ts-check
// module: the branch a stacked run was built on -- where it is recorded, when agent-org merges the blocker's branch into the run, and how the merge is made
//
// A RUN STACKED ON A BLOCKER'S BRANCH HAS THE BLOCKER'S BRANCH MERGED IN BY AGENT-ORG, NEVER BY A REBASE AND NEVER BY A FORCE-PUSH (A11-150). The worker is
// told not to rebase, merge the base in on its own initiative or force-push while it works (`worker-files.ts`). So when the blocker's branch moves, the pool
// does it here: from the run's own branch, it merges the branch's new head in and pushes the run's own branch plainly. A merge that conflicts is aborted,
// and the conflict is the run's worker's to resolve in a conflict round (`pool-watch.ts` `startStackConflictRound`).
//
// THE RECORD IS WRITTEN BY `ticket:worktree --from`, beside the ticket's files: `stack-base.json` says which repository, branch and commit the worktree
// was made from. The pool reads it, and keeps that commit reachable in the clone (`refs/agent-org/stack/...`), so a force-pushed-away commit survives `gc`.
//
// ASYNCHRONOUS git, through the same `Git` the worktrees use, so a test runs it on real repositories in temporary directories.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StackBaseRecord } from "./board-view/view-types-and-filters.ts";
import { find, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { ticketDir } from "./ticket-paths.ts";
import type { TicketSettings } from "./settings.ts";
import { conflictLine } from "./worker-files.ts";
import type { Git } from "./worktree.ts";

/** The file `ticket:worktree --from` writes beside a ticket's files: the repository, branch and commit its worktree was made from. */
export const STACK_BASE_FILE = "stack-base.json";

/** What `stack-base.json` holds. */
export type StackBaseFile = Readonly<{ repo: string; branch: string; sha: string }>;

/** The stacked branch a run carries now, as the queue holds it: a merge writes it back on top of what is there, not on a copy read before it. PURE. */
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
 * Whether a run's stack is due a merge: the blocker's branch is pushed (`head`) at a commit other than the one the run last merged in, and no conflict was
 * found against that head. A conflict is the worker's to resolve, so the same head is not merged again. PURE.
 */
export function mergeDue(record: Pick<StackBaseRecord, "sha" | "conflict">, head: string | null): head is string {
  return head !== null && head !== record.sha && record.conflict?.head !== head;
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
 * The result of merging a blocker's branch into a run's branch: the commit the stack was at and the commit it is at now, or why it was not made. `conflict`
 * lists the files a merge left unmerged, which the run's worker resolves; any other failure (a fetch, a refused push) is tried again on the next sweep. A merge
 * that pushed says which commit the run's branch moved from and to (`pushed`), so a pull request's head moving with it is not read as a person's push (A11-153).
 */
export type MergeResult = Readonly<{ ok: true; from: string; to: string; moved: boolean; pushed?: Readonly<{ from: string; to: string }> }> | Readonly<{ ok: false; reason: string; conflict?: readonly string[] }>;

/**
 * Merge the blocker's branch, `base.branch` on the remote, into the run's branch, `own`, in `worktree`, and push the run's own branch to `own` plainly: no
 * lease and no force, so a branch the remote moved on is refused. A merge that conflicts is aborted and the branch is left as it was, its files named. A
 * refused push puts the branch back where it was before the merge. A merge with nothing to bring in pushes nothing.
 */
export async function mergeBaseIn({ git, worktree, own, base }: {
  git: Git; worktree: string; own: string; base: Pick<StackBaseRecord, "branch" | "sha">;
}): Promise<MergeResult> {
  try {
    await git(worktree, ["fetch", "--quiet", "origin", base.branch]);
  } catch (err) {
    return { ok: false, reason: `could not fetch ${base.branch}: ${firstLine(err)}` };
  }
  const to = (await git(worktree, ["rev-parse", `origin/${base.branch}`])).trim();
  const before = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  // A merge writes its commit with a committer: the one the run's own last commit was made with, so no identity is invented, and a machine with no git identity
  // of its own (a CI runner, the instance's service) can still merge.
  const committer = (await git(worktree, ["log", "-1", "--format=%cn%n%ce", "HEAD"])).split("\n");
  const identity = ["-c", `user.name=${committer[0]}`, "-c", `user.email=${committer[1]}`];
  try {
    await git(worktree, [...identity, "merge", "--no-edit", `origin/${base.branch}`]);
  } catch (err) {
    const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim().split("\n").filter((file) => file !== "");
    await git(worktree, ["merge", "--abort"]).catch(() => undefined);
    return files.length > 0 ? { ok: false, reason: `conflicted in ${files.join(", ")}`, conflict: files } : { ok: false, reason: `could not be merged: ${firstLine(err)}` };
  }
  const merged = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  if (merged === before) return { ok: true, from: base.sha, to, moved: false };
  try {
    await git(worktree, ["push", "origin", `HEAD:${own}`]);
  } catch (err) {
    await git(worktree, ["reset", "--hard", before]).catch(() => undefined);
    return { ok: false, reason: `was refused by the remote: ${firstLine(err)}` };
  }
  return { ok: true, from: base.sha, to, moved: true, pushed: { from: before, to: merged } };
}

/**
 * Whether `head` is already in the run's branch, as a worker's round merged it in by hand (`git merge-base --is-ancestor`). The blocker's branch is fetched
 * first, so `head` is there to ask about; a fetch that fails says no, and the next sweep asks again.
 */
export async function mergedIn({ git, worktree, base, head }: {
  git: Git; worktree: string; base: Pick<StackBaseRecord, "branch">; head: string;
}): Promise<boolean> {
  try {
    await git(worktree, ["fetch", "--quiet", "origin", base.branch]);
    await git(worktree, ["merge-base", "--is-ancestor", head, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The record after a merge attempt: on success the run is branched from the new head, with the merge kept for the board; a conflict is recorded against
 * that head, and `capped` (the board's round cap) when the board's rounds were used up before it; any other failure keeps its branch and is tried again on
 * the next sweep. A record a rebase wrote before is dropped. PURE.
 */
export function afterMerge(record: StackBaseRecord, head: string, result: MergeResult, now: number, capped?: number): StackBaseRecord {
  const { failed: _failed, rebased: _rebased, ...rest } = record;
  if (!result.ok) {
    if (result.conflict === undefined) return { ...rest, seen: head };
    return { ...rest, seen: head, conflict: { head, files: result.conflict, ...(capped === undefined ? {} : { capped }) } };
  }
  const { seen: _seen, conflict: _conflict, ...kept } = rest;
  // A merge that brought nothing in (the worker already merged the head) is not a merge agent-org made: the run is branched from the head, and nothing is claimed.
  return result.moved ? { ...kept, sha: result.to, merged: { from: result.from, to: result.to, at: now } } : { ...kept, sha: result.to };
}

/** The record once its conflicting head is in the run's branch: the run is branched from that head now, and the conflict is no longer named. PURE. */
export function afterConflictCleared(record: StackBaseRecord): StackBaseRecord {
  const { conflict, ...kept } = record;
  return conflict === undefined ? record : { ...kept, sha: conflict.head };
}

/**
 * The feedback a round starts with when a merge of a stacked branch conflicted: a conflict line for each open pull request of the run's repository (which
 * the round's brief reads as a conflict to merge first), then the blocker and the files it conflicted in, named once. PURE.
 */
export function conflictFeedback(urls: readonly string[], record: Pick<StackBaseRecord, "key" | "branch">, files: readonly string[]): string {
  return [...urls.map((url) => conflictLine(url, record.branch)), `Merging ${record.key}'s branch \`${record.branch}\` conflicted in ${files.join(", ")}.`].join("\n");
}
