// module: the review claim -- a commit status on a pull request's head that says which instance is reviewing it (A11-149). Every instance reads it on GitHub,
// so two instances that sweep the same pull request start one reviewer between them. THE PROTOCOL IS PURE over an injected `read` and `write`; the calls that back
// them are the code host's (`readReviewClaims`, `writeReviewClaim`, contract 1.5), which the GitHub plugin makes.

/** The commit status context a claim is written under, and the one the door writes the verdict to. ONE SPELLING WITH `pr-review-verdict.sh`. */
export const REVIEW_CLAIM_CONTEXT = "agent-org/review";

/** How long a claim holds the head with no verdict before another instance may take it over: the reviewer's time limit (A11-149). */
export const REVIEW_LEASE_MINUTES = 60;

const MINUTE_MS = 60_000;

/** The lease in milliseconds: a claim younger than this holds its head, and one at or past it is expired. */
export const REVIEW_LEASE_MS = REVIEW_LEASE_MINUTES * MINUTE_MS;

/** One status under the claim's context: its id (GitHub's order between two of the same second), its description, and when GitHub wrote it, in ms. */
export type ClaimEntry = Readonly<{ id: number; description: string; created: number }>;

/**
 * What a claim's description says, or null for a description that is neither form. A claim reads `claimed by <instance> at <time>, lease <N> min`;
 * the finished form the door writes reads `<verdict> by <instance> at <time>`, with the verdict `convinced` or `not-convinced`.
 */
export type ClaimDescription = Readonly<{ kind: "claim"; instance: string }> | Readonly<{ kind: "finished"; instance: string; verdict: string }>
  | Readonly<{ kind: "released"; instance: string }>;

/** The description a claim is written with, for `instance` at `now`. Within GitHub's 140 characters for any instance name the settings allow (40). */
export function claimDescriptionOf({ instance, now }: { instance: string; now: number }): string {
  return `claimed by ${instance} at ${new Date(now).toISOString()}, lease ${REVIEW_LEASE_MINUTES} min`;
}

/** The description the door writes once the review posts: the verdict, the instance that posted it, and the time. */
export function finishedDescriptionOf({ verdict, instance, now }: { verdict: string; instance: string; now: number }): string {
  return `${verdict} by ${instance} at ${new Date(now).toISOString()}`;
}

/**
 * The description a claim is cancelled with when its instance's reviewer could not start: the instance that gives the head up, and the time. It cancels
 * that instance's most recent claim on the head, so another instance may claim the head now rather than when the lease ends.
 */
export function releasedDescriptionOf({ instance, now }: { instance: string; now: number }): string {
  return `released by ${instance} at ${new Date(now).toISOString()}`;
}

/** Reads a claim's description, a finished one, a release, or null for any other status under the context. */
export function describedClaimOf(description: string): ClaimDescription | null {
  const claim = /^claimed by (\S+) at \S+, lease \d+ min$/.exec(description);
  if (claim !== null) return { kind: "claim", instance: claim[1] };
  const finished = /^(convinced|not-convinced) by (\S+) at \S+$/.exec(description);
  if (finished !== null) return { kind: "finished", instance: finished[2], verdict: finished[1] };
  const released = /^released by (\S+) at \S+$/.exec(description);
  return released === null ? null : { kind: "released", instance: released[1] };
}

/** The step of a claim that failed: the `read` before it, the `write` of the claim itself, or the `readback` that checks it landed (A11-172). */
export type ClaimStep = "read" | "write" | "readback";

/**
 * What a claim attempt answers. `won`: this instance holds the head, and `tookOver` names the expired claim it took over, if one was. `held`: another
 * instance holds it, since `since`. `finished`: the review is already posted, so nothing is started. `unclaimed`: the claim could not be read or written,
 * so nothing is started either, and `step` says which step failed. `alone` (A11-172): GitHub refused the write of the claim after a clean read, no other
 * instance holds the head, and none has been seen within the lease, so the reviewer may start without a claim; `reason` is GitHub's.
 */
export type ClaimAnswer =
  Readonly<{ outcome: "won"; tookOver: string | null }> | Readonly<{ outcome: "held"; instance: string; since: number }>
  | Readonly<{ outcome: "finished"; description: string }> | Readonly<{ outcome: "unclaimed"; reason: string; step: ClaimStep }>
  | Readonly<{ outcome: "alone"; reason: string }>;

/** The claim entries of a head in GitHub's order (oldest first, ties by id), which every instance reads the same way. */
const inOrder = (entries: readonly ClaimEntry[]): ClaimEntry[] => [...entries].sort((a, b) => a.created - b.created || a.id - b.id);

/** A claim: the instance that wrote it and when GitHub did. */
type Claim = Readonly<{ instance: string; created: number }>;

/**
 * The claims standing among `entries`, in GitHub's order. A claim is standing until its instance releases it: a release cancels that instance's most
 * recent standing claim before it. A status that is neither (a verdict, or another context's) is none.
 */
function claimsIn(entries: readonly ClaimEntry[]): Claim[] {
  const standing: Claim[] = [];
  for (const { description, created } of inOrder(entries)) {
    const described = describedClaimOf(description);
    if (described?.kind === "claim") standing.push({ instance: described.instance, created });
    if (described?.kind === "released") {
      const index = standing.findLastIndex((claim) => claim.instance === described.instance);
      if (index !== -1) standing.splice(index, 1);
    }
  }
  return standing;
}

const minutesOf = (ms: number): string => `${Math.floor(ms / MINUTE_MS)} min`;

/** The most of GitHub's words a reason keeps: it is said on a pull request's line, in the board's one warning and in the log, and a long body would crowd all three. */
const MAX_REASON_CHARACTERS = 200;

const firstLineOf = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

/**
 * Why a `gh` call failed (A11-172): the first line `gh` printed on stderr, which is GitHub's own reason (`gh: Resource not accessible by integration (HTTP 403)`), and only
 * when it printed none the first line of the error's message (`Command failed: gh api ...`, which names the command and tells a reader nothing of why).
 */
export function reasonOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const printed = firstLineOf(typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "");
  const reason = printed !== "" ? printed : firstLineOf(String((err as Error)?.message ?? err));
  return reason.length > MAX_REASON_CHARACTERS ? `${reason.slice(0, MAX_REASON_CHARACTERS)}...` : reason;
}

/** What `action` returns, or the unclaimed answer for an action that threw at `step`. */
function attempt<T>(step: ClaimStep, action: () => T): Readonly<{ value: T }> | Readonly<{ unclaimed: Extract<ClaimAnswer, { outcome: "unclaimed" }> }> {
  try {
    return { value: action() };
  } catch (err) {
    return { unclaimed: { outcome: "unclaimed", reason: reasonOf(err), step } };
  }
}

/**
 * What a re-review of a head that already has its verdict claims over: the entries after the newest verdict, or all of them when there is none. A newest verdict that is an approval is
 * the end of the head, a re-review's included: the answer is then `finished`, since there is no block left for a re-review to answer.
 */
function afterNewestVerdict(entries: readonly ClaimEntry[]): Listing {
  const ordered = inOrder(entries);
  const last = ordered.findLastIndex((entry) => describedClaimOf(entry.description)?.kind === "finished");
  const verdict = last === -1 ? null : describedClaimOf(ordered[last].description);
  if (verdict?.kind === "finished" && verdict.verdict === "convinced") return { answer: { outcome: "finished", description: ordered[last].description } };
  return { entries: ordered.slice(last + 1) };
}

/** What a listing of a head's claim entries came to: the entries to decide on, or the answer that ends the claim. */
type Listing = Readonly<{ entries: readonly ClaimEntry[] }> | Readonly<{ answer: ClaimAnswer }>;

/**
 * The statuses `read` lists, or the answer that ends the claim before anything is written: `finished` when a verdict is among them, `unclaimed` when the
 * read failed.
 */
function listingOf(read: () => readonly ClaimEntry[], step: ClaimStep): Listing {
  const listed = attempt(step, read);
  if ("unclaimed" in listed) return { answer: listed.unclaimed };
  const finished = listed.value.find((entry) => describedClaimOf(entry.description)?.kind === "finished");
  return finished === undefined ? { entries: listed.value } : { answer: { outcome: "finished", description: finished.description } };
}

/**
 * The listing a re-review (A11-156) decides on: the one claim that starts after a verdict. The verdict it answers is not its end, and the claims before that verdict
 * are the first review's, so only the entries after the newest verdict are read.
 */
function listingAfterVerdict(read: () => readonly ClaimEntry[], step: ClaimStep): Listing {
  const listed = attempt(step, read);
  return "unclaimed" in listed ? { answer: listed.unclaimed } : afterNewestVerdict(listed.value);
}

/**
 * What a write GitHub refused comes to (A11-172): `alone` when nobody else can be reviewing the head, else the refusal as it was. The head is read AGAIN first, so a claim another instance wrote while this
 * one was being refused is seen (`held`); a read that fails then says nothing of who holds the head, so the refusal stands. Only after that read is `otherSeen` asked, which the reads record into.
 */
function aloneOrRefused({ refused, instance, now, read, otherSeen }: {
  refused: Extract<ClaimAnswer, { outcome: "unclaimed" }>; instance: string; now: number; read: () => Listing; otherSeen: () => number | null;
}): ClaimAnswer {
  const again = read();
  if ("answer" in again) return again.answer.outcome === "finished" ? again.answer : refused;
  const holder = claimsIn(again.entries).find((claim) => now - claim.created < REVIEW_LEASE_MS);
  if (holder !== undefined && holder.instance !== instance) return { outcome: "held", instance: holder.instance, since: holder.created };
  const seen = otherSeen();
  return seen === null || now - seen >= REVIEW_LEASE_MS ? { outcome: "alone", reason: refused.reason } : refused;
}

/**
 * Claims a head for `instance` (A11-149), or says why it cannot. PURE: `read` returns the claim's entries, and `write` posts a claim with the description it
 * is given, and throws when GitHub refuses it. In order:
 *
 * 1. A finished entry (a verdict) means the review is posted: `finished`, and nothing is started. A `rereview` is the exception (A11-156): it claims the head again
 *    after the verdict that stands, and only the entries after that verdict are read.
 * 2. The live claims (under the lease) are read in GitHub's order. When the earliest of them is another instance's, it holds the head: `held`. When it is
 *    this instance's own, the head is its own already (a restart): `won`, and nothing new is written.
 * 3. Otherwise (no live claim, or only expired ones) this instance writes its claim, reads the entries again, and takes the earliest live claim. A claim
 *    that expired with no verdict before this one is taken over, and `tookOver` says so.
 *
 * Two instances that both see no claim both write one; both then read the same ordered list and agree on one winner, because GitHub orders the entries and
 * no instance needs a clock that agrees with another's. A read or write that fails is `unclaimed`, and says at which `step`: a reviewer that cannot claim does not
 * start, because the second review it risks is the cost this removes.
 *
 * ONE EXCEPTION (A11-172): a write GitHub refused, after a read that showed no live claim, is `alone` when the head read again still shows no live claim of another instance
 * and `otherSeen` says no other instance has been seen within the lease. `otherSeen` is when any other instance's status under the claim's context was last seen on any head
 * (asked after that second read, which the caller's `read` may record), or null for none. A read that failed cannot show a claim, and a write that landed but was not read back
 * may hold the head, so neither is `alone`. With no `otherSeen` given, nothing is `alone`.
 */
export function claimHead({ instance, now, read, write, rereview = false, otherSeen = () => now /* none given: another instance is taken to be seen, so nothing is `alone` */ }: {
  instance: string; now: number; read: () => readonly ClaimEntry[]; write: (description: string) => void; rereview?: boolean; otherSeen?: () => number | null;
}): ClaimAnswer {
  const listingOfHead = rereview ? listingAfterVerdict : listingOf;
  const first = listingOfHead(read, "read");
  if ("answer" in first) return first.answer;
  const claims = claimsIn(first.entries);
  const live = claims.filter((claim) => now - claim.created < REVIEW_LEASE_MS);
  if (live[0]?.instance === instance) return { outcome: "won", tookOver: null };
  if (live[0] !== undefined) return { outcome: "held", instance: live[0].instance, since: live[0].created };
  // The expired claim this takes over: the most recent one of another instance, with no verdict after it (a verdict would have answered `finished` above).
  const expired = claims.filter((claim) => now - claim.created >= REVIEW_LEASE_MS && claim.instance !== instance).at(-1);
  const written = attempt("write", () => write(claimDescriptionOf({ instance, now })));
  if ("unclaimed" in written) return aloneOrRefused({ refused: written.unclaimed, instance, now, read: () => listingOfHead(read, "write"), otherSeen });
  const second = listingOfHead(read, "readback");
  if ("answer" in second) return second.answer;
  const after = second.entries;
  // Our own claim was written a moment ago, so it is on the list unless GitHub's clock says it is older than the lease: then nothing can be said.
  const winner = claimsIn(after).find((claim) => now - claim.created < REVIEW_LEASE_MS);
  if (winner === undefined) return { outcome: "unclaimed", reason: "the claim was not on the head after it was written", step: "readback" };
  if (winner.instance !== instance) return { outcome: "held", instance: winner.instance, since: winner.created };
  const tookOver = expired === undefined ? null : `took over the claim of ${expired.instance}, ${minutesOf(now - expired.created)} old with no verdict`;
  return { outcome: "won", tookOver };
}

/**
 * The other instances seen among `entries`, each with the latest `created` of a status it wrote under the claim's context: a claim, a verdict or a release (A11-172). Any of the three says
 * the instance is there, and counting all three can only find more instances, so it can only make the lone-instance fallback happen less often.
 */
export function othersSeenIn({ entries, instance }: { entries: readonly ClaimEntry[]; instance: string }): Map<string, number> {
  const seen = new Map<string, number>();
  for (const { description, created } of entries) {
    const described = describedClaimOf(description);
    if (described !== null && described.instance !== instance) seen.set(described.instance, Math.max(seen.get(described.instance) ?? created, created));
  }
  return seen;
}
