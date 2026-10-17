// @ts-check
// module: the tickets' reviewer -- starts the gate's codex reviewer on a ready pull request, once per head, behind a port the pool holds
//
// THE PORT IS THE POOL'S ONLY SEAM: `start` a reviewer for one pull request at one head, and `live`, whether one is running for that head.
// The atomic adapter starts the gate's own reviewer, `spawnReviewer` in `wake.ts` with its trust rules (`review-trust.ts`) and its verdict door,
// in the tickets' herdr session. Nothing here copies that code: it is imported. The reviewer posts as `a11ign-reviewer`, and its verdict is what
// the pool reads back to decide whether the worker goes round again.

import { spawnReviewer, prepareReviewCheckout } from "../wake.ts";
import { reviewerSeat } from "../review-attribution.ts";
import { declaredIdentities, INSIDE, reviewTrustOf, type ReviewTrust } from "../review-trust.ts";
import { ORG_SESSION, readAgents, type ListedAgent } from "../herdr-agents.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { REPO } from "../project-identity.ts";
import { pullRequestFieldsOf } from "../ticket-port/pull-request-fields.ts";
import type { PullFeedback } from "../ticket-port/pull-feedback.ts";

/** The account the gate's reviewer posts as. Its reviews are the reviewer's, never the feedback a worker answers. */
export const REVIEWER_LOGIN = "a11ign-reviewer";

/** The cause the reviewer is started for: the gate's `draft-awaiting-verdict`, the one a ready pull request is reviewed under. */
export const REVIEW_CAUSE = "draft-awaiting-verdict";

/** A pull request at one head: its url, and the commit the reviewer reads and the verdict is on. */
export type ReviewerRef = Readonly<{ pr: string; head: string }>;

/** The port: start a reviewer for a ready pull request at its head, or refuse naming why; and say whether one is live for that head. */
export type ReviewerPort = Readonly<{
  start(ref: ReviewerRef): Readonly<{ label: string }> | Readonly<{ refusal: string }>;
  live(ref: ReviewerRef): boolean;
}>;

/** What the pool reads of a pull request's reviewer: its head, whether the org's own, and the reviews on it. */
export type ReviewState = Readonly<{ head: string; trust: ReviewTrust; reviews: readonly Review[] }>;
type Review = Readonly<{ author: string; state: string; commit: string; at: number }>;

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
function pullOf(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/** The key of a repository the project declares: `""` for the primary's, `null` for one it does not declare, which is no seat at all. */
function repoKeyOf(repository: string): string | null {
  if (repository === REPO) return "";
  return homeProjectDeclaration().code.find((code) => code.repo === repository)?.key ?? null;
}

/** The reviewer's seat for a pull request: `reviewer-<n>` in the primary, `reviewer-<key>-<n>` elsewhere, or a refusal naming why it has none. */
function seatOf(url: string): { label: string; number: number } | { refusal: string } {
  const pull = pullOf(url);
  if (pull === null) return { refusal: `no reviewer for ${url}: it is not a pull request url` };
  const key = repoKeyOf(pull.repository);
  if (key === null) return { refusal: `no reviewer for ${url}: ${pull.repository} is not a repository the project declares` };
  return { label: reviewerSeat({ repoKey: key, number: pull.number }), number: pull.number };
}

/**
 * The pull request's state as the reviewer sees it: its head, whether its author is the org's own (`INSIDE`), and its reviews. Null when GitHub
 * does not say, which the caller reads as no reading rather than as a verdict.
 */
export function readReviewState(url: string, gh: (args: string[]) => string, declared: ReturnType<typeof declaredIdentities> = declaredIdentities()): ReviewState | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const pr = pullRequestFieldsOf({ repo: pull.repository, number: pull.number, fields: "headRefOid,reviews,author,isCrossRepository", run: gh });
  try {
    if (typeof pr?.headRefOid !== "string") return null;
    const reviews: Review[] = (pr.reviews ?? []).map((r: { author?: { login?: string }; state?: string; commit?: { oid?: string }; submittedAt?: string }) => ({
      author: String(r.author?.login ?? ""), state: String(r.state ?? ""), commit: String(r.commit?.oid ?? ""),
      at: Date.parse(String(r.submittedAt ?? "")) || 0,
    }));
    return { head: pr.headRefOid, trust: reviewTrustOf(pr, declared), reviews };
  } catch {
    return null;
  }
}

/**
 * The reviewer's verdict on `head`: the newest review it posted on that commit, `convinced` for an approval and `not-convinced` for requested
 * changes; null while it has not posted one. A review on an earlier head says nothing about this one.
 */
export function reviewVerdict(reviews: readonly Review[], head: string): "convinced" | "not-convinced" | null {
  const newest = reviews.filter((r) => r.author === REVIEWER_LOGIN && r.commit === head).sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) return null;
  return newest.state === "APPROVED" ? "convinced" : newest.state === "CHANGES_REQUESTED" ? "not-convinced" : null;
}

/**
 * A pull request's feedback read without the reviewer's own reviews, which are not feedback a worker answers. `feedbackAt` is the newest of
 * everyone's, and the reviewer's is not separated from it: where a person's feedback is older than the reviewer's verdict, it stays set.
 */
export function withoutReviewer(read: PullFeedback): PullFeedback {
  const authors = read.authors.filter((author) => author !== REVIEWER_LOGIN);
  return { ...read, authors, feedbackAt: authors.length === 0 ? null : read.feedbackAt };
}

/** What the reviewer is asked to do. A stub modelled on the outside reviewer's prompt: the gate's own reviewer prompt is not wired here yet. */
function reviewerPrompt(url: string, head: string): string {
  return `You review the pull request ${url} at commit ${head}. Read the change and its checks, then post one verdict on that commit: convinced (approve) or not-convinced (request changes), and say why in the review.`;
}

/**
 * The atomic adapter: the gate's codex reviewer, started in the tickets' herdr `session`. The gate's functions name the org's session, so the calls
 * they make are retargeted to `session` here, and nothing else about them changes. It refuses a pull request whose author is not the org's own
 * (`review-trust.ts`): the gate's verdict door and pane reader run only in the org's session, so an outside reviewer has no place to post from.
 * The head each reviewer was started for is kept in memory, so a restart of the pool starts a reviewer again for a head it already reviewed.
 */
export function atomicReviewerPort({ session, run, gh, declared = declaredIdentities(), spawn = spawnReviewer, checkout = prepareReviewCheckout }: {
  session: string; run: (args: string[]) => string; gh: (args: string[]) => string; declared?: ReturnType<typeof declaredIdentities>;
  spawn?: typeof spawnReviewer; checkout?: typeof prepareReviewCheckout;
}): ReviewerPort {
  const herdr = (args: string[]) => run(args[0] === "--session" && args[1] === ORG_SESSION ? ["--session", session, ...args.slice(2)] : args);
  const heads = new Map<string, string>();
  const listed = (): ListedAgent[] | null => readAgents(run, { session });

  return {
    live({ pr, head }) {
      const seat = seatOf(pr);
      return !("refusal" in seat) && heads.get(seat.label) === head && (listed()?.some((agent) => agent.label === seat.label) ?? false);
    },
    start({ pr, head }) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return seat;
      const state = readReviewState(pr, gh, declared);
      if (state === null) return { refusal: `no reviewer for ${pr}: the pull request could not be read` };
      if (state.trust !== INSIDE) return { refusal: `no reviewer for ${pr}: its author is outside the org, and the tickets' reviewer starts for the org's own pull requests only` };
      if (state.head !== head) return { refusal: `no reviewer for ${pr}: its head moved to ${state.head}, so ${head} is no longer to be reviewed` };
      const agents = listed();
      if (agents === null) return { refusal: `no reviewer for ${pr}: herdr did not list the ${session} session` };
      // A reviewer still holding the label is one for an earlier head: its workspace is closed before the next one starts under the same label.
      const stale = agents.some((agent) => agent.label === seat.label);
      if (stale) closeWorkspace(run, session, seat.label);
      const tree = checkout({ pr: seat.number, session: seat.label, trust: INSIDE });
      if ("refusal" in tree) return tree;
      const started = spawn({ session: seat.label, cause: REVIEW_CAUSE, causeKey: `${pr}@${head}`, trust: INSIDE },
        agents.filter((agent) => agent.label !== seat.label), { run: herdr, cwd: tree.path });
      if ("refusal" in started) return started;
      try {
        run(["--session", session, "agent", "prompt", seat.label, reviewerPrompt(pr, head)]);
      } catch (err) {
        return { refusal: `no reviewer for ${pr}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
      }
      heads.set(seat.label, head);
      return { label: seat.label };
    },
  };
}

/** Closes the workspace a label holds in the session, if herdr lists it. */
function closeWorkspace(run: (args: string[]) => string, session: string, label: string): void {
  const workspaces = JSON.parse(run(["--session", session, "workspace", "list"]))?.result?.workspaces ?? [];
  const id = workspaces.find((w: { label?: unknown }) => w?.label === label)?.workspace_id;
  if (typeof id === "string") run(["--session", session, "workspace", "close", id]);
}
