// module: the review claim -- a commit status on a pull request's head that says which instance is reviewing it (A11-149). Every instance reads it on GitHub,
// so two instances that sweep the same pull request start one reviewer between them. THE PROTOCOL IS PURE over an injected `read` and `write`; the `gh`
// calls that back them are below it, in this port, where the gh-call ratchet allows them.

/** Runs the GitHub CLI with `args` and answers what it printed; it throws when the call fails. */
export type Gh = (args: string[]) => string;

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

/**
 * What a claim attempt answers. `won`: this instance holds the head, and `tookOver` names the expired claim it took over, if one was. `held`: another
 * instance holds it, since `since`. `finished`: the review is already posted, so nothing is started. `unclaimed`: the claim could not be read or written,
 * so nothing is started either.
 */
export type ClaimAnswer =
  Readonly<{ outcome: "won"; tookOver: string | null }> | Readonly<{ outcome: "held"; instance: string; since: number }>
  | Readonly<{ outcome: "finished"; description: string }> | Readonly<{ outcome: "unclaimed"; reason: string }>;

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

const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0];

/** What `action` returns, or the unclaimed answer for an action that threw: a write GitHub refused. */
function attempt<T>(action: () => T): Readonly<{ value: T }> | Readonly<{ unclaimed: ClaimAnswer }> {
  try {
    return { value: action() };
  } catch (err) {
    return { unclaimed: { outcome: "unclaimed", reason: firstLine(err) } };
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
function listingOf(read: () => readonly ClaimEntry[]): Listing {
  const listed = attempt(read);
  if ("unclaimed" in listed) return { answer: listed.unclaimed };
  const finished = listed.value.find((entry) => describedClaimOf(entry.description)?.kind === "finished");
  return finished === undefined ? { entries: listed.value } : { answer: { outcome: "finished", description: finished.description } };
}

/**
 * The listing a re-review (A11-156) decides on: the one claim that starts after a verdict. The verdict it answers is not its end, and the claims before that verdict
 * are the first review's, so only the entries after the newest verdict are read.
 */
function listingAfterVerdict(read: () => readonly ClaimEntry[]): Listing {
  const listed = attempt(read);
  return "unclaimed" in listed ? { answer: listed.unclaimed } : afterNewestVerdict(listed.value);
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
 * no instance needs a clock that agrees with another's. A read or write that fails is `unclaimed`: a reviewer that cannot claim does not start, because the
 * second review it risks is the cost this removes.
 */
export function claimHead({ instance, now, read, write, rereview = false }: {
  instance: string; now: number; read: () => readonly ClaimEntry[]; write: (description: string) => void; rereview?: boolean;
}): ClaimAnswer {
  const listingOfHead = rereview ? listingAfterVerdict : listingOf;
  const first = listingOfHead(read);
  if ("answer" in first) return first.answer;
  const claims = claimsIn(first.entries);
  const live = claims.filter((claim) => now - claim.created < REVIEW_LEASE_MS);
  if (live[0]?.instance === instance) return { outcome: "won", tookOver: null };
  if (live[0] !== undefined) return { outcome: "held", instance: live[0].instance, since: live[0].created };
  // The expired claim this takes over: the most recent one of another instance, with no verdict after it (a verdict would have answered `finished` above).
  const expired = claims.filter((claim) => now - claim.created >= REVIEW_LEASE_MS && claim.instance !== instance).at(-1);
  const written = attempt(() => write(claimDescriptionOf({ instance, now })));
  if ("unclaimed" in written) return written.unclaimed;
  const second = listingOfHead(read);
  if ("answer" in second) return second.answer;
  const after = second.entries;
  // Our own claim was written a moment ago, so it is on the list unless GitHub's clock says it is older than the lease: then nothing can be said.
  const winner = claimsIn(after).find((claim) => now - claim.created < REVIEW_LEASE_MS);
  if (winner === undefined) return { outcome: "unclaimed", reason: "the claim was not on the head after it was written" };
  if (winner.instance !== instance) return { outcome: "held", instance: winner.instance, since: winner.created };
  const tookOver = expired === undefined ? null : `took over the claim of ${expired.instance}, ${minutesOf(now - expired.created)} old with no verdict`;
  return { outcome: "won", tookOver };
}

/** The claim entries of `sha` in `repo` under the claim's context, read through `gh`. Throws when GitHub does not answer. */
export function claimEntriesOf({ repo, sha, gh }: { repo: string; sha: string; gh: Gh }): ClaimEntry[] {
  // Read as one tab-separated line per status, so a page of statuses reads as lines and no page is joined to the next.
  const lines = gh(["api", "--paginate", `repos/${repo}/commits/${sha}/statuses?per_page=100`, "--jq", `.[] | select(.context == "${REVIEW_CLAIM_CONTEXT}") | [.id, .created_at, .description] | @tsv`])
    .split("\n").filter((line) => line !== "");
  return lines.map((line) => {
    const [id, created, ...description] = line.split("\t");
    return { id: Number(id), description: description.join("\t"), created: Date.parse(created) };
  });
}

/** Writes a status under the claim's context on `sha` in `repo`, state `success`: the state says nothing, the description says whose and when. Throws on refusal. */
export function writeClaimStatus({ repo, sha, description, gh }: { repo: string; sha: string; description: string; gh: Gh }): void {
  gh(["api", "--method", "POST", `repos/${repo}/statuses/${sha}`, "--silent", "-f", "state=success", "-f", `context=${REVIEW_CLAIM_CONTEXT}`, "-f", `description=${description}`]);
}

