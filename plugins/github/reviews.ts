// module: what the reviewer reads of a pull request -- its head, its reviews, its trust and whether its checks settled, and its state (A11-160)
//
// Moved out of `ticket-mode/reviewer-port.ts` (`readReviewState`, `readPullState`), over the plugin's `gh`. WHAT IS TRUSTED AND WHAT IS SETTLED IS CORE'S: the pull request is read by
// the fields the reviewer's policy names (`policy.review().fields`), and the same policy judges it (`trustOf`, `settledOf`). Asking for the policy THROWS where the reviewer's gate does not
// load, before anything is read, as the read always did.
import type { Review, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import type { Gh } from "./gh.ts";
import { pullRequestFieldsOf } from "./pull-request-fields.ts";

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
export function pullOf(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/**
 * The pull request's state as the reviewer sees it: its head, whether its author is the org's own (`INSIDE`), and its reviews. Null when GitHub does not say, which the caller reads
 * as no reading rather than as a verdict. THROWS the gate's refusal when the gate does not load.
 */
export function readReviewState(url: string, gh: Gh, policy: CodeHostPolicy): ReviewState | null {
  const judge = policy.review();
  const pull = pullOf(url);
  if (pull === null) return null;
  const pr = pullRequestFieldsOf({ repo: pull.repository, number: pull.number, fields: judge.fields, gh });
  try {
    if (typeof pr?.headRefOid !== "string") return null;
    const reviews: Review[] = (pr.reviews ?? []).map((r: { author?: { login?: string }; state?: string; commit?: { oid?: string }; submittedAt?: string }) => ({
      author: String(r.author?.login ?? ""), state: String(r.state ?? ""), commit: String(r.commit?.oid ?? ""),
      at: Date.parse(String(r.submittedAt ?? "")) || 0,
    }));
    const settled = judge.settledOf(pr);
    return { head: pr.headRefOid, trust: judge.trustOf(pr), reviews, settled, view: { ...pr, number: pull.number } };
  } catch {
    return null;
  }
}

/**
 * The pull request's state as GitHub names it, `OPEN`, `MERGED` or `CLOSED`, or null when it does not say. A merged or closed pull request is the one `retire` is for; an unreadable one
 * is nothing to act on.
 */
export function readPullState(url: string, gh: Gh): string | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const state = pullRequestFieldsOf({ repo: pull.repository, number: pull.number, fields: "state", gh })?.state;
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
}
