// agent-org#1501: the claim record's reader, moved out of `claim-stall.ts` unchanged so `closes-mismatch-check.ts` can read a claim without loading the
// stall clock, whose imports reach `arm-pr.ts` (account-limit -> pr-ejected -> arm-pr): `arm-pr` asks `closes-mismatch-check` now, and that was a cycle.
// `claim-stall.ts` re-exports every name below, so nobody else's import moved.
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";

const CLAIMED_BRANCH = /^Claimed-branch:\s*(.+)$/m;
const CLAIMED_WORKTREE = /^Claimed-worktree:\s*(.+)$/m;
const CLAIMED_NOTHING = /^Claimed-nothing:\s*(.+)$/m;
const CLAIMED_BY = /-- claimed by `/;

export type RowComment = { body?: string, createdAt?: string, author?: { login?: string } | null, id?: string };
/**
 * `nothing` is #3407's `Claimed-nothing:` claim: a claim that names no git object on purpose, which is evaluated by the clock and never released
 */
export type ClaimRecord = { at: number, author: string | null, branch: string | null, worktree: string | null, nothing: boolean };

/**
 * The newest claim record on a row, or `null` when none is a CLAIM: no record at all (a dispatch, or a claim that named
 * neither a branch nor a worktree), or the newest one is a RELEASE. `row-claim.ts` owns the format
 * (`claimRecordComment`) and is unimportable from a tick, so this reads it by the same marker and the same three field
 * names, and the test round-trips the real writer through it. A `Claimed-nothing:` record (#3407) IS a claim, with a null
 * branch and worktree; a release has no field and is "released by", so the two never share a spelling.
 *
 * `at` is the record's own time and `author` its account -- which is how "a row comment BY THAT SESSION" is answered
 * without a session-to-account table: the claim was made under the account the claimant runs as.
 *
 * @param {RowComment[]} comments oldest first, the order `gh issue list --json comments` returns
 * @returns {ClaimRecord | null}
 */
export function claimRecordOf(comments: RowComment[]): ClaimRecord | null {
  const newest = comments.filter((c) => String(c.body ?? "").includes(CLAIM_RECORD_MARKER)).at(-1);
  if (newest === undefined || !CLAIMED_BY.test(String(newest.body))) return null;
  const body = String(newest.body);
  const at = Date.parse(String(newest.createdAt ?? ""));
  if (Number.isNaN(at)) return null;
  return { at, author: newest.author?.login ?? null,
    branch: CLAIMED_BRANCH.exec(body)?.[1].trim() ?? null, worktree: CLAIMED_WORKTREE.exec(body)?.[1].trim() ?? null,
    nothing: CLAIMED_NOTHING.test(body) };
}
