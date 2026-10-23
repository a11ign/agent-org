import { patchIdOfDiff, evidenceHeads, refusalHeads, refusalLiftedAt } from "../../review-verdict.ts";
import { newestPerName } from "../../newest-check-run.ts";
import { subjectIdentity, subjectMention, subjectRef } from "../../review-attribution.ts";
import { loadLanes, inLane, MANAGERS_APP_LOGINS } from "../../lane-ownership.ts";
import { holdersOf } from "../../pr-hold-state.ts";
import { decidedBy } from "../../decided-by.ts";
import { worktreeOwner } from "../../worktree-owner.ts";
import { HOLD_RED_JOBS, reviewGateOf } from "../pr-orders/pr-gate-readings.ts";
import { checkMarkersOf } from "../review-gate.ts";
import { BLOCKING_REVIEW_STATES, REVIEW_STATE, blockingChecks, checksSettledGreen, draftCandidates, mergeCandidates, reviewStateOf } from "../pr-state.ts";
import { PROJECT_GIT } from "../reads.ts";
import { capturingStderr, defaultRun, defaultSpawn, repoNow } from "../reads/read-memo-and-exit.ts";
import { HOUR_MS, labelsOf, sessionOf } from "../vocabulary.ts";
import { rows } from "../../plugins/rows.ts";

/**
 * PURE. The commit the newest `CHANGES_REQUESTED` review was posted at, or `null` when the payload names none.
 *
 * `reviews` AND NOT `latestReviews` for the reason `readPrs` records (#2365): `latestReviews[].commit.oid` comes
 * back empty. `null` is "the payload cannot say", never "at no commit" -- the order then tells the reader to
 * look rather than asserting a comparison nobody made. The LAST refusal is taken on the assumption that `gh` lists
 * reviews oldest first, as GitHub's API does; that order was NOT confirmed here (the one PR read had a single review).
 */
export function refusalCommitOf(pr: any): string | null {
  if (!Array.isArray(pr?.reviews)) return null;
  const refusals = pr.reviews.filter((r: any) => r?.state === "CHANGES_REQUESTED");
  const oid = refusals.at(-1)?.commit?.oid;
  return oid ? String(oid) : null;
}

/**
 * PURE. #3045: whether a pull request's patch at its current head equals its patch at `oid` -- the head a review was posted at. `null`
 * when `oid` is absent or either patch was not read (`withPatchIds`), because absence of a reading is not a reading of change.
 */
export function patchUnchangedSince(pr: any, oid: string | null): boolean | null {
  const ids = pr?.patchIds ?? {};
  const now = ids[String(pr?.headRefOid ?? "")];
  const then = oid ? ids[oid] : undefined;
  return typeof now === "string" && typeof then === "string" ? now === then : null;
}

/**
 * PURE. #2084: the pull requests that LOOK like they should be merging and that GitHub's review
 * requirement is holding -- plus any whose decision could not be read at all. #3592: A refusal, or a value this gate cannot name; never
 * AWAITING_REVIEW, which is `draftOrder`'s question and starts the reviewer instead.
 *
 * `UNREADABLE` IS EXCLUDED, and `reviewStateOf`'s own note says where its control lives instead.
 *
 * THE POPULATION IS `mergeCandidates`', NOT EVERY OPEN PULL REQUEST, and each exclusion is another cause's
 * subject rather than an oversight: a draft belongs to `draft-awaiting-verdict`, a red one to
 * `pr-checks-failing`, and a held one is not merging BY DECISION. What is left is the state nothing in this
 * repository could see before -- not a draft, not held, green on every required check, and blocked anyway.
 * The one draft admitted (#958) is a refusal at its current head: the author owes the rework whether or not it is ready for review.
 *
 * EACH ENTRY CARRIES THE FACTS ROUTING NEEDS (#2283): the PR's `session:` label (`null` when it has none), the
 * head, and -- for a refusal -- the commit the refusing review was posted at. The label is what lets
 * `reviewBlockedOrders` send a labelled pull request to its own session instead of to `product-manager`;
 * the two commits let the order open with the comparison the #2084 diagnosis turns on.
 *
 *
 * `patchUnchanged` (#3045) is whether the pull request's patch is the one the refusing review was posted at: `true`, or `false`, or `null` when
 * either patch was not read -- unread is not changed, and is not unchanged either.
 *
 * `refusalLifted` (a11ign#3199) is whether the refusal was posted for a check that failed at that commit and fails at none now, at an equal
 * patch (`refusalLiftedAt`, the decider the door asks): a refusal that only a fresh review can lift and that no rework could.
 *
 * @returns ascending by PR number
 */
export function reviewBlocked(prs: any[], required: string[] | null = null): {
    number: number; code: string; why: string; session: string | null; head: string;
    refusedAt: string | null; patchUnchanged: boolean | null; refusalLifted: boolean;
}[] {
  return [
    ...mergeCandidates(prs, required),
    // #958: A DRAFT IS IN THIS POPULATION ONLY WHEN A REVIEWER REFUSED IT AT THE HEAD IT HAS. A draft with no verdict is `draft-awaiting-verdict`'s
    // (asking its reviewer for one), and a draft refused at an OLDER head is outside it as it always was: `withStaleRefusals` reads only `mergeCandidates`.
    ...draftCandidates(prs, required).filter((pr) => reviewStateOf(pr).code === REVIEW_STATE.REFUSED && refusalCommitOf(pr) === String(pr.headRefOid ?? "")),
  ]
    // agent-org#489: A REFUSAL THE GATE HAS RECORDED AS POSTED AT AN OLDER HEAD IS NOBODY'S ORDER (`withStaleRefusals` stamps it, and only after the record landed).
    // The stamp names the commit it was made for, so a newer refusal on the same pull request is not hidden by it.
    .filter((pr) => pr.staleRefusal === undefined || pr.staleRefusal !== refusalCommitOf(pr))
    .map((pr) => ({ number: Number(pr.number), ...subjectIdentity(pr), ...reviewStateOf(pr), session: sessionOf(pr),
      head: String(pr.headRefOid ?? ""), refusedAt: refusalCommitOf(pr), patchUnchanged: patchUnchangedSince(pr, refusalCommitOf(pr)),
      refusalLifted: refusalLiftedAt(pr, refusalCommitOf(pr)) }))
    // #3592: AWAITING_REVIEW IS NOT HERE. `draftOrder` asks `reviewer-<n>` for every one of this population that has no verdict yet (#2176), and
    // `wake.ts` starts the instance, so an order to `product-manager` for the same pull request was sent in the SAME TICK as a start and
    // deferred behind a busy seat (63 of 67 `DEFERRED` lines in 2026-10-04's journal). What stays is what only READING can settle: a refusal,
    // and a decision this gate cannot name. A PULL REQUEST HOLDING AN UNRECOGNISED OR UNATTRIBUTED VERDICT, still REVIEW_REQUIRED, is no
    // longer reported here either (`settledVerdictOrder` leaves it alone on purpose); it is recorded on #3592.
    .filter((r) => BLOCKING_REVIEW_STATES.includes(r.code) && r.code !== REVIEW_STATE.AWAITING_REVIEW)
    .sort((a, b) => a.number - b.number);
}

// --- #1959: A PIPELINE PULL REQUEST WITH NO CODE-OWNER REVIEW ------------------------------------------

/**
 * `docs/lane-ownership.json`'s pipeline lane (`.github/workflows/`, owner `ceo`), or `null` when the file
 * cannot be read.
 *
 * `null` IS CANNOT-ASK, NEVER "NOTHING OWNS THE PIPELINE" -- `loadLanes`'s own rule: a check that answers
 * "clear" because it could not find its own rules is worse than no check, and `pipelineCodeownerReviewMissing`
 * below reads this return the same way.
 */
function pipelineLane(): { owner: string; paths: string[]; except?: string[]; } | null {
  return loadLanes()?.lanes.find((l) => l.lane === "the pipeline") ?? null;
}

/**
 * A lane's role-name owner, spelled as the GitHub login CODEOWNERS names -- `codeowners-lane-sync.test.ts`'s
 * own `ROLE_LOGIN`, deliberately re-asserted here rather than shared: `docs/lane-ownership.json` names the
 * ROLE ("ceo") and never the account, and a shared module would make the mapping look derived from a file
 * that does not carry it.
 *
 * `ceo` HAS NO ENTRY (a11ign#5044 step 2). The login that held it was the `a11ign-ai-leads` App, and an App cannot
 * be a code owner (a11ign#4981), so the review CODEOWNERS asks for can never be given by that account. With no login
 * for the pipeline lane's owner, `pipelineCodeownerReviewMissing` names nothing: the cause is retired, and the
 * owned-path check (`owned-path-signoff.ts`) is what answers for owned paths now. Restoring `ceo` here turns the
 * #1959 retirement test red.
 */
const ROLE_LOGIN: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Does this PR touch a path CODEOWNERS actually assigns to the lane's owner -- inside `paths` and outside
 * every `except` entry, the same last-matching-pattern rule GitHub applies to the file itself. A PR
 * touching ONLY an excepted path (`.github/workflows/consumer-gate.yml`) answers `false`.
 */
function touchesOwnedLanePath(files: string[], lane: { paths: string[]; except?: string[]; }) {
  return files.some((f) => inLane(f, lane.paths) && !inLane(f, lane.except ?? []));
}

/**
 * PURE. #1959: every open pull request CODEOWNERS assigns to the pipeline lane's owner and that owner has
 * not reviewed at the head it has now (`ownerHasReviewed`: an approval or a refusal; a refusal left the pull request
 * here and re-asked for a review already given, a11ign/agent-org#483) -- the gap nothing asked about before this row. `reviewDecision` alone cannot say WHO
 * approved, only that GitHub is satisfied, and measured 2026-09-22: `DanBeckDev` (`ceo`'s login) has never
 * authored a formal GitHub review in this repository, so a pipeline PR could sit indefinitely on an
 * unanswered CODEOWNERS request -- advisory today, a hard merge block the moment #1756's flip lands.
 *
 * EXCLUDES A PR THE OWNER AUTHORED. GitHub will not request a review from a pull request's own author, so
 * no such request is ever outstanding for one, and the bypass allowance #2022 requires covers exactly this
 * case -- checked explicitly rather than left to `reviews` staying empty, so a future change to how GitHub
 * reports self-authored PRs cannot silently start firing this cause on `ceo`'s own work.
 *
 * `prFiles` IS `comparablePrFiles`'S OUTPUT, NOT `pr.files` RE-READ. That function already drops any PR
 * whose file list does not match its `changedFiles` count (`gh pr list --json files` truncates at 100; `readPrs` pages
 * such a PR first since #3365, and one it could not page still drops out), so
 * this cause inherits the same guarantee: it can be silent about a PR the gate cannot see the whole of, but
 * it can never fire on a partial list and miss the path that mattered.
 *
 *
 * @returns ascending by PR number
 */
export function pipelineCodeownerReviewMissing(prs: any[], prFiles: { number: number; files: string[]; repoKey?: string; }[]): { number: number; repoKey?: string; session: string | null; }[] {
  const lane = pipelineLane();
  const login = lane && (ROLE_LOGIN as Record<string, string>)[lane.owner];
  if (!login) return [];
  // #3720: KEYED BY REPOSITORY AND NUMBER. Two repositories' open PRs share a number (`lab#3`, `toolchain#3`), and a number-only map let the
  // later one's files stand for both: a PR touching no owned path was named, and one touching an owned path could go unnamed.
  const filesByRef = new Map(prFiles.map((p) => [subjectRef(p.repoKey, p.number), p.files]));
  return prs
    .filter((pr) => pr.author?.login !== login)
    .filter((pr) => touchesOwnedLanePath(filesByRef.get(subjectRef(pr.repoKey, pr.number)) ?? [], lane))
    .filter((pr) => !ownerHasReviewed(pr, login, lane.owner))
    .map((pr) => ({ number: Number(pr.number), ...subjectIdentity(pr), session: sessionOf(pr) }))
    .sort((a, b) => a.number - b.number);
}

/**
 * The environment variable that puts `pipelineCodeownerReviewMissing` back to counting an `APPROVED` review only. SET TO `1` it is
 * the revert; unset (the ordinary case) a refusal on the pull request's current head settles the cause too.
 */
export const CODEOWNER_REVIEW_APPROVED_ONLY_ENV = "AGENT_ORG_CODEOWNER_REVIEW_APPROVED_ONLY";

/**
 * #796 (`ceo`'s ruling on the row): A REVIEW COUNTS AS THE OWNER'S WHEN ITS AUTHOR IS THE OWNER'S LOGIN, OR IS THE MANAGERS APP AND ITS BODY'S
 * `decided-by` MARKER NAMES THE OWNER'S SEAT. A manager's review is authored by `a11ign-managers[bot]` since #4911's flip, which no comparison
 * with `a11ign-ai-leads` can match, so the cause re-fired on a head `ceo` had approved. The App is shared by `ceo`, `product-manager` and
 * `orchestrator`, so its login alone must NOT clear the cause (a `product-manager` approval is not the code owner's): the marker is the only
 * thing that names the seat, and `decidedBy` reads its LAST one, the line `plugins/github/wrapper/gh` appends, so a quoted marker earlier in the body does not
 * speak for the review. `seat` is the lane's role ("ceo").
 *
 * AUTHORSHIP IS NOT EXTENDED, and `pipelineCodeownerReviewMissing`'s own-PR exemption still compares with `login` alone: the App authors for
 * every manager, so a PR it authored is not "the owner's own".
 */
function isOwnersReview(review: any, login: string, seat: string): boolean {
  const author = review?.author?.login;
  if (author === login) return true;
  return MANAGERS_APP_LOGINS.includes(author) && decidedBy(review?.body) === seat;
}

/**
 * Has the code owner already given this pull request the review CODEOWNERS asks for? `APPROVED` or `CHANGES_REQUESTED` on the head the
 * pull request has NOW: a push after a refusal is new work the owner has not seen, so it is asked again, and `COMMENTED` and `DISMISSED`
 * settle nothing (a comment is not a review and does not satisfy CODEOWNERS). `reviews[].commit.oid` is the sha the review was posted
 * against; `latestReviews[]` carries it as the empty string, which is why `readPrs` asks for `reviews`.
 *
 * A REVIEW IS STALE ONLY WHEN BOTH SHAS ARE KNOWN AND DIFFER. A review with no `commit.oid`, or a pull request the read gave no
 * `headRefOid`, cannot be shown to be on an older head (absence is not proof): an `APPROVED` there settles the cause exactly as it did
 * before this row (`#1959 (c)` pins it), and a `CHANGES_REQUESTED` there does not, because it is the NEW settling state and is counted
 * only on evidence that it is on the head the pull request has.
 */
function ownerHasReviewed(pr: any, login: string, seat: string): boolean {
  const approvedOnly = process.env[CODEOWNER_REVIEW_APPROVED_ONLY_ENV] === "1";
  const head = typeof pr.headRefOid === "string" ? pr.headRefOid : "";
  return (pr.reviews ?? []).some((r: any) => {
    if (!isOwnersReview(r, login, seat)) return false;
    if (approvedOnly) return r?.state === "APPROVED";
    const at = typeof r?.commit?.oid === "string" ? r.commit.oid : "";
    if (at !== "" && head !== "") return (r?.state === "APPROVED" || r?.state === "CHANGES_REQUESTED") && at === head;
    return r?.state === "APPROVED";
  });
}

/**
 * ONE ORDER NAMING EVERY PULL REQUEST STILL MISSING ITS CODE-OWNER REVIEW -- `greenUnarmedOrders`'s shape
 * and for its reason: the set is what makes the cause self-clearing, keyed on WHICH pull requests are
 * still waiting rather than on any one push, so a review that clears one leaves it out of the next key.
 *
 * `ceo` ALWAYS, WHOEVER OPENED THE PULL REQUEST -- unlike `pr-review-blocked`'s owned/unowned split, the
 * act this order asks for (`ceo` posting a formal review) is never a labelled session's to do; the label,
 * when there is one, is named in the prompt only so `ceo` knows whose branch it is.
 */
export function pipelineCodeownerReviewOrders(missing: { number: number; repoKey?: string; session: string | null; }[]): {
    session: string; cause: string; subject: string; discriminator: string; prompt: string;
    causeKey: string;
}[] {
  if (missing.length === 0) return [];
  const key = missing.map((m) => subjectRef(m.repoKey, m.number)).join(".");
  const named = missing.map((m) => `${subjectMention(m)}${m.session ? ` (${m.session})` : ""}`).join(", ");
  return [{
    session: "ceo",
    cause: "pr-codeowner-review-missing",
    subject: "pr-codeowner-review-missing",
    discriminator: key,
    prompt: `${missing.length} open pull request(s) touch a \`.github/workflows/\` path CODEOWNERS `
      + `assigns to you and carry NO APPROVED or CHANGES_REQUESTED review from you on their current head: ${named}.\n`
      + "Nothing asked for this review before #1959: `reviewDecision` alone cannot say the approval came "
      + "from the code owner, and you have never authored a formal GitHub review in this repository. It is "
      + "advisory today -- #1756 (still open) is what turns it into a hard merge block.\n"
      + "Review each and post a formal GitHub review (approve or request changes) -- a comment on the "
      + "pull request is not a review and does not satisfy CODEOWNERS.",
    causeKey: `ceo/pr-codeowner-review-missing/${key}`,
  }];
}

/**
 * Is this pull request's red made ONLY of the hold's own manufactured jobs? A `hold:` label reddens
 * exactly `HOLD_RED_JOBS` on purpose (`work-gate/pr-orders.ts`'s own header), and the REVIEW question
 * does not care who placed the hold -- unlike `redOnlyFromHoldOf`, which asks whether a hold answers a
 * SPECIFIC session and is used to decide whether that session gets a "fix your build" order. Here the
 * question is only "is this red manufactured or real", so any `hold:` label counts.
 *
 * A hold must keep stopping a MERGE (`armabilityOf`/`greenUnheldPrs`, unaffected -- neither calls this).
 * It must stop blocking a REVIEW, which is the defect #2709 was filed for: PR #2649 carried a release
 * condition needing a verdict, and the hold's own red checks made `reviewableHead` return `null` before
 * anyone was ever asked for one.
 *  @param onHead every check on the head, narrowed by `newestPerName`
 */
function redOnlyFromAnyHold(pr: any, onHead: any[]) {
  if (holdersOf(labelsOf(pr)).length === 0) return false;
  const red = onHead.filter((c) => checksSettledGreen([c]) === false);
  return red.length > 0 && red.every((c) => HOLD_RED_JOBS.includes(String(c?.name ?? c?.context)));
}

/**
 * The head this pull request's review question is asked at, or `null` when it is not asked: red, still
 * running, or headless. Shared by `draftOrder` and the enrichment that decides which pull requests are
 * worth a commit read, so the two can never disagree about who is being asked.
 *
 * RED AND RUNNING MEAN THE REQUIRED CHECKS' (a11ign#3597), the set `failingChecksOrder` reads. This read took EVERY check, so a head
 * green on `gate` and red on a check `main` does not require (agent-org#211, #212, #213: `typecheck`) was no pull request's work to
 * `failingChecksOrder` and no review's question to this: it earned no order at all, and waited for a reviewer nobody was sent for.
 * `required` is `null` when the list could not be read, and `blockingChecks` then counts every check -- the answer before #3597.
 * `redOnlyFromAnyHold` still reads the whole head: a hold's manufactured jobs are named, not required, and it asks about its own red.
 */
export function reviewableHead(pr: any, required: string[] | null = null): string | null {
  const onHead = newestPerName(pr?.statusCheckRollup);
  // a11ign#5528: a review-gated red is asked at its head too, so the reviewer it names is ordered there
  if (checksSettledGreen(blockingChecks(onHead, required)) !== true && reviewGateOf(pr, required) === null && !redOnlyFromAnyHold(pr, onHead)) return null;
  return String(pr.headRefOid ?? "") || null;
}

/** The statuses GitHub gives a commit or compare path for "this sha resolves to nothing in this repository" (a head force-pushed away, or mistyped). */
const SHA_RESOLVES_TO_NOTHING = [404, 422];

/** What each refusal already told this tick, so a fault met on every head of a pull request is one line. */
const refusalsTold = new Set();

/** @returns the HTTP status `gh` printed (`gh: Not Found (HTTP 404)`), or null when it printed none */
function refusalStatus(error: any): number | null {
  const found = /\(HTTP (\d{3})\)/.exec(`${error?.stderr ?? ""}\n${error?.message ?? ""}`);
  return found ? Number(found[1]) : null;
}

/**
 * #3724: WHAT A HANDLED, REFUSED READ SAYS. The reader returns `null` for the refusal, which is right; this decides what the journal hears.
 *
 * A STALE EVIDENCE HEAD SAYS NOTHING. A sha named in a review that was force-pushed away (or mistyped) resolves to nothing, 404 or 422 on a
 * commit or compare path: the review's text is the author's, the pull request is intact, and the question falls back to the head alone. Silence
 * is not "could not determine" here: the status says the sha is not in the repository, and the repository was just read for its pull request.
 *
 * ANYTHING ELSE IS A FAULT AND STAYS VISIBLE (403, 5xx, a timeout, a 404 of a pull request), ONCE PER TICK per repository, path and status
 * -- the path elides the sha, so a fault met on every head is one line. Before this, `gh`'s own stderr was inherited and a bare
 * `gh: Not Found (HTTP 404)` repeated for 30 ticks naming no repository, pull request or sha.
 */
export function noteRefusedRead(error: any, { path, ofASha }: { path: string; ofASha: boolean; }, log: (line: string) => void = (line) => process.stderr.write(line)) {
  const status = refusalStatus(error);
  if (ofASha && status !== null && SHA_RESOLVES_TO_NOTHING.includes(status)) return;
  const answered = status === null ? String(error?.code ?? "no HTTP status") : `HTTP ${status}`;
  const key = `${repoNow()} ${path} ${answered}`;
  if (refusalsTold.has(key)) return;
  refusalsTold.add(key);
  log(`REFUSED READ in ${repoNow()}: \`gh api ${path}\` answered ${answered}. The pull request is read without it (the patch is not known); `
    + "this is a fault of the read, not a stale head, and is told once per tick.\n");
}

/**
 * #3045: THE PATCH ID OF ONE HEAD -- what the pull request changes relative to its base, hashed -- or `null` when the read was refused.
 *
 * THE COMPARE API'S DIFF, `base...head`, because that is `merge-base(base, head)..head` and the gate holds no checkout. Reading it
 * as a diff (not the JSON's per-file `patch`) is what keeps a large change whole: the JSON truncates a file's patch silently, and a
 * truncated patch would hash two different changes to one id. A refusal -- including GitHub's own "diff too large" -- is `null`,
 * which every caller reads as "the patch is not known", never as "the patch is empty".
 *
 * `head` MAY BE AN ABBREVIATION (a verdict's `at <head8>`): the compare API resolves it.
 */
export function readPatchId(head: string, base: string, run: (args: string[]) => string = defaultRun): string | null {
  try {
    return patchIdOfDiff(rows().compareDiffOf({ repo: repoNow(), base, head, run: capturingStderr(run) }));
  } catch (error) {
    noteRefusedRead(error, { path: `repos/${repoNow()}/compare/${base}...<sha>`, ofASha: true });
    return null;
  }
}

/**
 * #3045: The shas of one pull request's commits, oldest first, or `null` when the read was refused. REST, not the list call: `commits`
 * on `gh pr list --limit 100` is refused outright by GraphQL ("requesting up to 1,000,000 possible nodes which exceeds the maximum
 * limit of 500,000", 2026-09-24), and REST returns every commit rather than the first hundred.
 */
export function readCommitShas(number: number, run: (args: string[]) => string = defaultRun): string[] | null {
  try {
    const shas = rows().commitShasOf({ repo: repoNow(), number, run: capturingStderr(run) });
    return shas.length > 0 ? shas : null;
  } catch (error) {
    // A REFUSED READ LEAVES THE PULL REQUEST UNENRICHED: the gate then reads the current head alone. Never an empty list, which would claim "no commits".
    // The path is of a pull request and not of a sha, so even a 404 is a fault here and is told.
    noteRefusedRead(error, { path: `repos/${repoNow()}/pulls/${number}/commits`, ofASha: false });
    return null;
  }
}

/**
 * #3045: HOW THE REVIEW QUESTION STANDS FOR A PULL REQUEST -- `"settled"` (green, so a reviewer is asked now), `"running"` (checks not
 * finished, which an update-branch causes on a head with no new work), or `null` (red or headless: not this question's). The one place
 * the two readers of it, `withPatchIds` and `draftOrder`, can agree. The `awaiting-evidence` label is NOT read here: `draftOrder` still
 * reads a verdict somebody posted on a labelled pull request, and only `withPatchIds` declines to spend calls on one.
 *
 * A REQUIRED check still running is `"running"`; a check outside the required set is not read at all (a11ign#3597), so one still running
 * beside a settled-green required set asks the review now, as it does for a red one -- `required` is `null` for an unread list, which
 * counts every check as before.
 */
export function reviewWait(pr: any, required: string[] | null = null): "settled" | "running" | null {
  if (!pr?.headRefOid) return null;
  if (reviewableHead(pr, required)) return "settled";
  return checksSettledGreen(blockingChecks(newestPerName(pr?.statusCheckRollup), required)) === null ? "running" : null;
}

/**
 * #3045: THE PULL REQUESTS, each with `patchIds` (oid -> patch id) WHERE THE REVIEW QUESTION NEEDS THEM, so a verdict, a review and a
 * refusal can stand for the PATCH rather than for the head they were posted at. Everything else is returned untouched, so a red or
 * labelled pull request pays no call.
 *
 * A `"settled"` pull request is read at its head and at every older head a review or verdict names (`evidenceHeads`). A `"running"`
 * one is read at its head and its PREDECESSOR only: the question is whether the checks now running are for a head that adds nothing
 * (an update-branch), and if so `draftOrder` keeps the order it already had instead of dropping it for the minutes CI takes -- which
 * is what wrote a `RESET` and re-armed the order after each of #3033's four merges. A refused read leaves a pull request unenriched.
 *
 * `required` is the list `draftOrder` reads the question against (a11ign#3597): the patch is read for the pull request the question is
 * open for, so the two must not disagree about whether a non-required red check closes it.
 */
export function withPatchIds(prs: any[], run: (args: string[]) => string = defaultRun, required: string[] | null = null) {
  return prs.map((pr) => {
    const wait = awaitingEvidence(pr) ? null : reviewWait(pr, required);
    if (wait === null) return pr;
    const base = String(pr.baseRefName ?? "main");
    const head = String(pr.headRefOid);
    const others = wait === "settled" ? evidenceHeads(pr) : predecessorOf(pr, run);
    const entries = [head, ...others].map((oid) => ([oid, readPatchId(oid, base, run)] as const));
    const known = entries.filter(([, id]) => id !== null);
    return known.length > 0 ? withFailingChecks({ ...pr, patchIds: Object.fromEntries(known) }, run) : pr;
  });
}

/**
 * a11ign#5528: the check runs at one commit as the REST API gives them, each with its `output.summary` (where a check says what clears it), or `null`
 * when the read was refused. The list is read per red pull request only (`withCheckMarkers`), so a green one pays nothing.
 */
function readCheckRunSummaries(commit: string, run: (args: string[]) => string = defaultRun): { id: number; name: string; summary: unknown }[] | null {
  try {
    return rows().checkRunSummariesAt({ repo: repoNow(), commit, run: capturingStderr(run) });
  } catch (error) {
    noteRefusedRead(error, { path: `repos/${repoNow()}/commits/<sha>/check-runs`, ofASha: true });
    return null;
  }
}

/**
 * a11ign#5528, agent-org#1538: THE MARKERS OF A RED PULL REQUEST'S CHECKS, read at its head: `checkMarkers` (name -> `review` | `human`, from the
 * `Cleared-by:` line of each newest run's summary) and `checkMarkersHead` (the head they were read at, which `reviewGateOf` compares). Only a
 * pull request whose blocking set is settled red pays the read; a refused read leaves it unmarked, which is red, as it was before the marker.
 */
export function withCheckMarkers(prs: any[], run: (args: string[]) => string = defaultRun, required: string[] | null = null) {
  return prs.map((pr) => {
    const head = String(pr?.headRefOid ?? "");
    if (!head || checksSettledGreen(blockingChecks(newestPerName(pr?.statusCheckRollup ?? []), required)) !== false) return pr;
    const runs = readCheckRunSummaries(head, run);
    return runs === null ? pr : { ...pr, checkMarkers: checkMarkersOf(runs), checkMarkersHead: head };
  });
}

/**
 * a11ign#3199: THE NAMES OF THE CHECK RUNS THAT CONCLUDED `failure` AT ONE COMMIT, or `null` when the read was refused. `[]` is a real answer
 * (nothing failed there) and `null` is "not known": a refusal is never read as green, because a refusal lifted on an unread check would
 * hand a refused pull request back to a reviewer on a guess.
 *
 * `commit` MAY BE AN ABBREVIATION (a verdict's `at <head8>`): the commits endpoint resolves it, as the compare API does.
 */
export function readFailingChecks(commit: string, run: (args: string[]) => string = defaultRun): string[] | null {
  try {
    return rows().failingCheckNamesAt({ repo: repoNow(), commit, run: capturingStderr(run) });
  } catch (error) {
    noteRefusedRead(error, { path: `repos/${repoNow()}/commits/<sha>/check-runs`, ofASha: true });
    return null;
  }
}

/**
 * a11ign#3199: A PULL REQUEST WITH `failingChecks` (oid -> names of the check runs that concluded `failure` there) FOR THE ONE QUESTION THAT NEEDS
 * THEM: does a refusal at an older head with an equal patch still apply (`refusalLifted`, the decider the door asks too)? Only a pull request
 * with such a refusal pays anything, and then one read per commit compared: each refusal head, and the current head only when one of those
 * had a failure, since a refusal at an all-green commit is the #3033 shape and stays standing whatever the head looks like. A refused read
 * leaves the commit out, and absent is not green.
 */
function withFailingChecks(pr: any, run: (args: string[]) => string) {
  const refused = refusalHeads(pr);
  if (refused.length === 0) return pr;
  const failing: Record<string, string[]> = {};
  for (const oid of refused) {
    const names = readFailingChecks(oid, run);
    if (names !== null) failing[oid] = names;
  }
  const head = String(pr.headRefOid);
  const now = Object.keys(failing).length > 0 && Object.values(failing).some((names) => names.length > 0) ? readFailingChecks(head, run) : null;
  if (now !== null) failing[head] = now;
  return Object.keys(failing).length > 0 ? { ...pr, failingChecks: failing } : pr;
}

/**
 * The commit before a pull request's head, as a one-element list, or none when the commits could not be read or do not end at the
 * head (a push landed between the list and the commits).
 */
function predecessorOf(pr: any, run: (args: string[]) => string): string[] {
  const shas = readCommitShas(Number(pr.number), run);
  return shas && shas.length >= 2 && shas[shas.length - 1] === String(pr.headRefOid) ? [shas[shas.length - 2]] : [];
}

/** #2416: the PR label meaning "my done-when needs an external run, and the evidence is not posted yet". */
export const AWAITING_EVIDENCE_LABEL = "awaiting-evidence";

/** #2416: how long a PR may carry the label with nobody saying what it waits on before `product-manager` is asked. */
export const AWAITING_EVIDENCE_QUIET_HOURS = 48;

export const AWAITING_EVIDENCE_QUIET_MS = AWAITING_EVIDENCE_QUIET_HOURS * HOUR_MS;

export function awaitingEvidence(pr: any) {
  return labelsOf(pr).includes(AWAITING_EVIDENCE_LABEL);
}

/**
 * When the label was LAST applied to this pull request (ISO string), or `null` when it could not be read.
 *
 * THE EVENTS LIST, NOT THE TIMELINE: `issues/{n}/events` answers "when was this label applied" with a
 * `created_at` on each `labeled` event and is a strict subset of the timeline, so it is the cheaper of the two
 * reads that can answer it. THE LAST `labeled` EVENT, because a label removed (the evidence posted) and
 * applied again is a new wait. `null` is refused-or-never-applied, and neither becomes an order: an order
 * naming a PR whose label age is unknown would be a claim the gate never measured.
 */
export function readEvidenceLabelledAt(number: number, run: (args: string[]) => string = defaultRun): string | null {
  try {
    const applied = rows().labeledEventTimesOf({ repo: repoNow(), number, label: AWAITING_EVIDENCE_LABEL, run });
    return applied.length > 0 ? applied[applied.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * The pull requests, each one carrying the label with `awaitingSince` attached. A queue where nothing carries the
 * label pays NO call, and a labelled one pays one per labelled pull request -- the condition is answered from
 * the list already in hand, which is what makes the read affordable on every tick.
 */
export function withEvidenceLabelAges(prs: any[], run: (args: string[]) => string = defaultRun) {
  return prs.map((pr) => {
    if (!awaitingEvidence(pr)) return pr;
    const awaitingSince = readEvidenceLabelledAt(Number(pr.number), run);
    return awaitingSince ? { ...pr, awaitingSince } : pr;
  });
}

/**
 * `{ branch -> stamped session }` for every worktree on this host, from ONE local `git worktree list --porcelain` and a file read
 * per stamped tree. `null` when git refused: a refused read names nobody, which is a fall to `ceo`, never a guess. Spends no pool.
 */
export function readWorktreeStamps(run: (cmd: string, args: string[]) => string = defaultSpawn, owner: typeof worktreeOwner = worktreeOwner): Map<string, string> | null {
  try {
    const stamps = new Map();
    for (const block of run("git", [...PROJECT_GIT, "worktree", "list", "--porcelain"]).split(/\n\s*\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      const stamped = path && branch ? owner(path) : null;
      if (stamped) stamps.set(branch, stamped);
    }
    return stamps;
  } catch {
    return null;
  }
}

/**
 * The lazy, once-per-tick stamp lookup `withNamedOwners` takes: the first call reads the host, every later one reuses it.
 */
export function stampLookup(read: () => Map<string, string> | null = readWorktreeStamps): (branch: string) => string | null {
  let stamps: Map<string, string> | null | undefined;
  return (branch) => {
    if (stamps === undefined) stamps = read();
    return stamps?.get(branch) ?? null;
  };
}
