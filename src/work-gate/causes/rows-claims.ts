import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { READY_LABEL, CLAIM_LABEL } from "../../claim-labels.ts";
import { waitingOn, todayIso, describeWaiting, ANSWER_PREFIX } from "../../waiting-condition.ts";
import { conditionHolds, declaredWaitsOf, waitItemOf, type WaitFacts } from "../../wait-condition.ts";
import { subjectIdentity, subjectMention, subjectRef } from "../../review-attribution.ts";
import { declaredRegionFiles } from "../../region-paths.ts";
import { claimedRegionOverlapReason, claimedRegionsOf, fileOverlapReason } from "../../row-claim/file-overlap-rule.ts";
import { missingTemplateFields } from "../../row-claim/template-fields-rule.ts";
import { isRepoWideResolutionFault, recentClosesSiblings } from "../../closes-mismatch-check.ts";
import { extractClosesDeclaration } from "../../acceptance-commands/acceptance-report-and-closure.ts";
import { BLOCKED_LABEL, SESSION_PREFIX } from "../../project-vocabulary.ts";
import { KEPT_CLAIMS_FILE, readJsonObject } from "../../claim-stall/stall-causes-and-claim-readings.ts";
import { writeJsonObject } from "../../claim-stall.ts";
import { worktreeOwner } from "../../worktree-owner.ts";
import { REPO_CHECKOUT, branchesToReplace } from "../reads.ts";
import { MAX_ROW_ORDERS_PER_TICK, REVIEWER_STATE_DIR, type Yielding, digestOf, isChairmanRow, labelsOf, laneOwnerOf, sessionOf, standingText } from "../vocabulary.ts";

/**
 * Why B4 would refuse this row RIGHT NOW, or `null` when it would not -- and `null` whenever the question
 * cannot be answered from what the gate has already read.
 *
 * NO REGION IS NOT NO OVERLAP, and this must agree with `row-claim.ts` about that or the gate would
 * shelve rows the claim would grant. `declaredRegionFiles` returns `null` for a body with no Region
 * section at all; `sessionEligibilityReason` treats that as CANNOT ASK and skips B4 rather than refusing,
 * so this returns `null` too. A Region naming no path is `[]`, which `fileOverlapReason` itself answers
 * with "no overlap" -- a real comparison, and not this function's to second-guess.
 *
 * #2101: THE ROW'S OWN NUMBER GOES WITH ITS REGION. A pull request declaring `Closes #<this row>` is this
 * row's own work and cannot be a reason to withhold it -- the gate shelved #2076 behind #2077, the PR
 * that WAS #2076, and it and two rows behind the same file went nowhere for 1h41m. This must agree with
 * `row-claim.ts` about that for the same reason the Region read does: a gate that shelves what the claim
 * would grant is a gate nobody can act on.
 *
 * #2493: AND SO DOES THE HELD-PR EXCLUSION, for the same reason: a PR carrying `hold:` whose every closed row is
 * `blockedBy` this row is waiting on it and cannot merge first, so it is no reason to withhold the row -- #2399 was
 * shelved behind #2376, which was waiting on #2399. `blockersOf` is how the gate answers "what blocks that row" from
 * the `blockedBy` it already holds for every open row (`blockersFromRows`), so it makes no call of its own.
 *
 *
 * @param [options] `rootFiles` is
 *   passed to `declaredRegionFiles` so a test can name its own tree rather than needing this repository's
 */
export function blockedOnOpenPr(row: any, prFiles: { number: number; files: string[]; changedFiles: number; closes?: number[]; held?: boolean; }[], options?: { rootFiles?: Set<string>; blockersOf?: (row: number) => number[] | null; }): string | null {
  // NOTHING TO OVERLAP. With no comparable open PR no refusal is possible, and reading the row's Region
  // to discover that would spawn `git ls-tree` for an answer already known.
  if (prFiles.length === 0) return null;
  const mine = declaredRegionFiles(String(row?.body ?? ""), options);
  if (mine === null) return null;
  return fileOverlapReason(mine, prFiles, { rowNumber: Number(row?.number), blockersOf: options?.blockersOf }).reason;
}

/**
 * #3475: why B4 would refuse this row RIGHT NOW because of a row somebody has ALREADY CLAIMED, or `null`. A claimed row holds its Region's
 * files from its claim, and has no open pull request until its first push, so `blockedOnOpenPr` cannot see it -- #3414 was offered and
 * claimed over three files #3423 had held for 27 minutes. The reason names the holder, and it clears when that row closes or is released:
 * the shelving is derived each tick from the `openRows` the gate already read, and writes nothing.
 *
 * FAILS THE WAY THE PULL-REQUEST HALF DOES: no `openRows` read, or a row with no Region section, is "cannot ask" and shelves nothing,
 * and the claim still asks (and refuses on a failed read). `claimed` is {@link claimedRegionsOf}'s output, computed once per call.
 */
export function blockedOnClaimedRow(row: any, claimed: { number: number; files: string[]; }[], options: { rootFiles?: Set<string>; blockersOf?: (row: number) => number[] | null; openPrs?: { closes?: number[]; }[]; }): string | null {
  if (claimed.length === 0) return null;
  const mine = declaredRegionFiles(String(row?.body ?? ""), options);
  if (mine === null) return null;
  return claimedRegionOverlapReason(mine, claimed, { rowNumber: Number(row?.number), blockersOf: options.blockersOf, openPrs: options.openPrs });
}

/**
 * #2493: what blocks a row, answered from the open rows the gate has ALREADY READ -- `blockedBy` rides
 * `readOpenRows`'s call -- so the exclusion costs the gate nothing. `null` for a row not among them (closed, or
 * beyond the read's limit), which the rule reads as "not excluded".
 */
export function blockersFromRows(openRows: any[] | null | undefined): (row: number) => number[] | null {
  const byNumber = new Map((openRows ?? []).map((r) => [Number(r?.number), r]));
  return (number) => {
    const found = byNumber.get(number);
    return found ? (found.blockedBy?.nodes ?? []).map((n: any) => Number(n.number)) : null;
  };
}

/**
 * PURE. `readRowBranches`'s flat listing, indexed by row number.
 *
 * An ABSENT or `null` listing yields an EMPTY index, and every caller then behaves exactly as it did
 * before #2031 -- that is the degradation `readRowBranches`'s `null` is for, expressed once here rather
 * than as a branch at each of the two call sites.
 */
function branchIndex(rowBranches: { branch: string; head: string; row: number; }[] | null | undefined): Map<number, { branch: string; head: string; }[]> {
  const byRow: Map<number, { branch: string; head: string; }[]> = new Map();
  for (const found of rowBranches ?? []) {
    const list = byRow.get(found.row) ?? [];
    list.push({ branch: found.branch, head: found.head });
    byRow.set(found.row, list);
  }
  return byRow;
}

/**
 * PURE. What the tick log says about a row whose branches `origin` already holds.
 *
 * IT STATES THE BRANCH AND ITS SHA AND CONCLUDES NOTHING, which is #2031's own "what this will NOT fix":
 * a branch on `origin` for a `ready` row means only that a branch exists. Whether it is finished work
 * awaiting a pull request, or abandoned work, is a reading of the branch -- so this must not assert the
 * row is done, and the wording is the guard against a reader inferring it from a cause that fired.
 */
function branchesText(pushed: { branch: string; head: string; }[]): string {
  const named = pushed.map(({ branch, head }) => `\`${branch}\` at ${head.slice(0, 12)}`).join("; ");
  return `origin already holds ${pushed.length === 1 ? "a branch" : `${pushed.length} branches`} carrying `
    + `this row's number: ${named}. That is NOT a claim that the work is finished -- only that it EXISTS `
    + "and nothing on the board says so";
}

/**
 * The template sections this row's body does not state, `[]` when it is complete OR WHEN THE BODY WAS NOT READ.
 * A row with no string `body` is "not asked", never "asked and empty": `readReadyRows` always requests it, so a
 * caller that lacks it (a fixture, a future read) must not shelve the whole queue on an absence.
 */
function missingFieldsOf(row: any): string[] {
  return typeof row?.body === "string" ? missingTemplateFields(row.body) : [];
}

const templateGapText = (missing: string[]): string => `its body has no ${missing.map((f) => `\`## ${f}\``).join(", ")}`;

/**
 * The unclaimed Ready rows, split into what a session could actually claim right now and what B4 would
 * refuse, with the reason and the row's lane owner.
 *
 * WHY THE GATE ASKS B4 AT ALL, MEASURED 2026-09-18 -- and this is the whole of the change. ALL THREE
 * unclaimed Ready rows (#1452, #1397, #1320) declare `.github/workflows/release.yml`, which open draft
 * #1695 already touches. The gate offered all three every two minutes. `ceo` was woken for #1452, ran
 * sixteen shell commands, rediscovered the refusal, posted it on the row, messaged `product-manager` and
 * stopped -- having re-derived a hold a PRIOR `ceo` session had already recorded. Nothing was wrong with
 * that turn except that it was spent: the refusal is an intersection of two `--json` field lists the
 * gate's own two calls already pay for, knowable before the wake.
 *
 * IT ALSO CORRECTS THE DIAGNOSIS ABOVE. The lane comment in `decide` reads three idle engineers behind
 * laned rows as a LANE problem; re-laning those three rows to `lane:any` would have changed nothing,
 * because an engineer hits the identical B4 refusal. The queue's throughput was one draft's verdict.
 *
 * A BLOCKED ROW IS NOT A DROPPED ROW. The work that frees it is the blocking PR's, and the gate already
 * asks about that PR by its own causes -- so shelving here removes a wake without removing a question.
 * `main` reports every shelving on stderr, and `emptyShelfOrder` names the pool's blocked rows, because a
 * row that vanishes silently is the exact shape of the empty-shelf defect these orders exist to catch.
 *
 *
 *
 *        `rowBranches` is `readRowBranches()`. It DEFAULTS TO ABSENT, which is "not asked or refused":
 *        nothing is shelved for it and every row is offered exactly as it was before #2031, so a tick
 *        that cannot reach `origin` is never worse off than one from before this existed.
 *        `branchPrs` (#3892) is `readBranchPrs()`: a row whose EVERY branch on `origin` has only CLOSED-unmerged pull requests is not shelved for the
 *        branch (see {@link branchesToReplace}) and is offered, with the branches named by `rowOrders`. ABSENT, every such row is shelved as before.
 *        `openRows` (#2493) is every open row the gate read, for the `blockedBy` edges that say whether a HELD PR is
 *        waiting on the row asked about. ABSENT, no held PR is excluded and B4 refuses exactly as before.
 *        It is also where #3475 reads the rows already CLAIMED (`in-progress`), whose Regions hold their files before any pull request
 *        exists: a Ready row sharing a file with one is shelved, naming it. ABSENT, no row is shelved for it.
 *        `chairmanRows` (#4524) is `readChairmanPriority`'s verified set. A row in it is NOT shelved by B4 against a holder that is not itself a chairman row (a claimed
 *        row, or a pull request closing no chairman row): it is offered, and the holder is returned in `yielding` so `decide` can tell it to rebase. Every other
 *        shelving reason binds it as before. ABSENT, no row is the chairman's and B4 refuses exactly as it did.
 *        `clock` is injected the way `partitionFleetBatch` already injects one, and #2113 is why this
 *        path needs one at all: a `Not-before:` may now name an HOUR, so whether a row is offerable can
 *        change within a single day and a test cannot pin that against the host clock.
 */
export function partitionUnclaimed(readyRows: any[], prFiles: { number: number; files: string[]; changedFiles: number; closes?: number[]; held?: boolean; }[], options?: {
        rootFiles?: Set<string>;
        openRows?: any[] | null;
        rowBranches?: { branch: string; head: string; row: number; }[] | null;
        branchPrs?: { branch: string; number: number; state: string; }[] | null;
        clock?: { today?: string; nowMs?: number; };
        chairmanRows?: ReadonlySet<number>;
        waitFacts?: WaitFacts | null;
    }): { offerable: any[]; blocked: { number: number; owner: string | null; reason: string; }[]; yielding: Yielding[]; } {
  const offerable = [];
  const blocked = [];
  const yielding: Yielding[] = [];
  const { today = todayIso(), nowMs = Date.now() } = options?.clock ?? {};
  const onOrigin = branchIndex(options?.rowBranches);
  const replaceable = branchesToReplace(options?.rowBranches, options?.branchPrs);
  const blockersOf = blockersFromRows(options?.openRows);
  const waitFacts = options?.waitFacts;
  const claimed = claimedRegionsOf(options?.openRows, options) ?? [];
  for (const row of readyRows) {
    // #2005's OPEN-CHECK, ANSWERED BY THIS LINE AND NOT BY A NEW RULE. The filer asked whether
    // `answer:<session>` should hold a row against its OWN HOLDER -- #1948 was `in-progress` +
    // `session:worker-tooling` + `answer:worker-tooling`, and a session is not blocked by its own
    // unanswered question the way a stranger is. It never arises here: a claimed row carries
    // `CLAIM_LABEL` and leaves on this line, before anything asks what it is waiting on. So "not offered
    // to a session other than the one already holding it" needed no expression -- a held row is not
    // offered to anybody, which is strictly stronger and was already true.
    if (labelsOf(row).includes(CLAIM_LABEL)) continue;
    // #2791: A ROW THE CLAIM WILL REFUSE FOR A TEMPLATE DEFECT IS NOT STOCK. #2729 and #2730 read `ready` for ~38h
    // with no `## Open-check`, so every offer ended in `NOT CLAIMED: ... is missing Open-check` while the pool
    // counted them and `ready-queue-empty` stayed silent. SHELVED, like every reason here, and the reason
    // names the section: `incompleteRowOrders` is what asks somebody to add it.
    const missing = missingFieldsOf(row);
    if (missing.length > 0) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row),
        reason: `${templateGapText(missing)} -- \`row-claim\` refuses it, and it clears when the section is added` });
      continue;
    }
    // #2031, AND AHEAD OF EVERY OTHER SHELVING REASON. The others say this row cannot be STARTED yet;
    // this one says it may already be FINISHED, and offering it as a fresh start is the one outcome
    // measured to cost a whole session's turn -- #2000 was offered throughout the 20 minutes its branch
    // sat unshipped on `origin`, and a second session was routed into its three Region paths.
    // SHELVED RATHER THAN DROPPED, like every other reason here: the `SHELVED row #N:` line names the
    // branch and its sha, and `rowBranchOrders` sends somebody to read it. A row that vanishes silently
    // is the failure `blocked` already is.
    // #3892: EXCEPT A BRANCH WHOSE PULL REQUEST WAS CLOSED UNMERGED. That is not unshipped work nobody has read (#2000) and the shelving's order cannot
    // reach anyone able to act on it (`product-manager`'s login may be the refused one): the row goes on offer to the pool, whose order names the branch.
    const pushed = onOrigin.get(Number(row.number)) ?? [];
    if (pushed.length > 0 && !replaceable.has(Number(row.number))) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row), reason: branchesText(pushed) });
      continue;
    }
    // A DECLARED WAIT SHELVES THE ROW RATHER THAN HIDING IT. It goes to `blocked` with its reason, so
    // the tick log says why -- a row that vanishes silently is the failure `blocked` already is.
    //
    // SINCE #2005 THAT INCLUDES `answer:<session>`, and nothing here changed to make it so: `waitingOn`
    // gained the kind and this call site inherited it. That is the seam working -- the alternative, a
    // third prefix check written out here beside the one `readPromotableRows` already had, is exactly
    // how the offer path and the promotion path came to disagree in the first place.
    const waiting = waitingOn(row, today, nowMs);
    if (waiting) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row),
        reason: `${describeWaiting(waiting)} -- declared on the row, and it clears itself` });
      continue;
    }
    // #1075: A BODY `Waiting-for:` IS A WAIT TOO. `waitingOn` reads only the fields above, so a Ready row whose body names an open
    // `merged <ref>` was offered on every tick until the wait cleared. A wait whose condition is FALSE is shelved here, read against the
    // same facts the stale-wait order reads. A wait that is UNKNOWN (`null`: an unread reference, `manual`, an unreadable line) and a
    // tick with no facts (`waitFacts` absent or `null`) are offered as before: a failed read never shelves a row.
    const unmet = waitFacts ? declaredWaitsOf(waitItemOf(row, "row")).waits.find((wait) => conditionHolds(wait, waitFacts) === false) : undefined;
    if (unmet) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row),
        reason: `Waiting-for: ${unmet.text} is not true yet -- declared on the row, and it clears itself` });
      continue;
    }
    const { reason, yielded } = overlapVerdict(row, { prFiles, claimed, options: { ...options, blockersOf } });
    if (reason) blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row), reason });
    else offerable.push(row);
    if (!reason && yielded.length > 0) yielding.push({ row: Number(row.number), holders: yielded });
  }
  return { offerable, blocked, yielding };
}

/**
 * #4524: B4's verdict for one row, and for a CHAIRMAN row the holders it walked past. The chairman's amendment of 2026-10-09 ("trumps everything else ... I don't want
 * to wait"): an overlap with a holder that is not itself a chairman row does not shelve the row; the holder rebases onto it, and the merge queue already serialises the
 * merges. TWO CHAIRMAN ROWS STILL EXCLUDE EACH OTHER -- the same file edited by two sessions at once is a conflict whichever of them is the chairman's. A holder is a
 * chairman row's own when it is a claimed chairman row, or a pull request declaring `Closes` on one.
 * @param {any} row @param {{ prFiles: Parameters<typeof partitionUnclaimed>[1], claimed: { number: number, files: string[] }[], options: Parameters<typeof blockedOnClaimedRow>[2] }} ask
 * @returns {{ reason: string | null, yielded: Yielding["holders"] }}
 */
function overlapVerdict(row: any, { prFiles, claimed, options }: { prFiles: Parameters<typeof partitionUnclaimed>[1]; claimed: { number: number; files: string[]; }[]; options: Parameters<typeof blockedOnClaimedRow>[2] & { chairmanRows?: ReadonlySet<number>; }; }): { reason: string | null; yielded: Yielding["holders"]; } {
  const refusal = (prs: typeof prFiles, rows: typeof claimed) => blockedOnOpenPr(row, prs, options) ?? blockedOnClaimedRow(row, rows, { ...options, openPrs: prs });
  const full = refusal(prFiles, claimed);
  if (full === null || !isChairmanRow(row, options.chairmanRows)) return { reason: full, yielded: [] };
  const holdsChairmanRow = (n: number) => options.chairmanRows?.has(n) === true;
  const remaining = refusal(prFiles.filter((pr) => (pr.closes ?? []).some(holdsChairmanRow)), claimed.filter((holder) => holdsChairmanRow(holder.number)));
  if (remaining !== null) return { reason: remaining, yielded: [] };
  return { reason: null, yielded: [
    ...claimed.filter((holder) => refusal([], [holder]) !== null).map((holder) => ({ kind: "row" as const, number: holder.number })),
    ...prFiles.filter((pr) => refusal([pr], []) !== null).map((pr) => ({ kind: "pr" as const, number: pr.number })),
  ] };
}

// --- #2845: A READY ROW THE CLAIM REFUSES, TICK AFTER TICK -------------------------------------------------------------------
//
// MEASURED 2026-10-01 from `a11ign-work-tick.service`'s journal: #2824 was offered every tick for 7.5 hours and refused at the
// claim every time (`--worktree=../wt-2824 ALREADY EXISTS`) -- 211 `UNDELIVERED` lines, and `product-manager` was never
// woken, because `ready-queue-empty` fires only on an EMPTY pool and the pool held that one row. A refusal that only logs
// is read by nobody. THE GATE CANNOT SEE THE SPAWNER'S REFUSAL (a derived cause is not in the ledger and `wake.ts` prints
// it to stderr), so it asks the claim's own question itself and keeps its own streak: not a new "everyone is idle" probe, which
// would have fired on a legitimately empty org too.

/**
 * N, THE TICKS A REFUSAL MUST REPEAT BEFORE IT IS REPORTED: 15, which is about 30 minutes at the tick's 2-minute cadence (the
 * 211 lines over 7.5 hours above are ~28 a tick-hour). Long enough that the ordinary transient -- a claim that has just
 * been declined and whose tree is on its way out, a release whose kept tree is about to be adopted -- clears first; short
 * enough that a stuck row costs half an hour rather than the 7.5 it did.
 */
export const UNCLAIMABLE_AFTER_TICKS = 15;

/** The streak memory, beside `claim-stalls.json` and the wake ledger: `{ "<row>": { reason, ticks } }`. */
export const CLAIM_REFUSALS_FILE = "claim-refusals.json";

/**
 * The refusal the claim would give this row for a reason that does NOT depend on who claims: its target worktree already
 * exists. The words are `row-claim.ts`'s `worktreeTargetReason`, which this file cannot import (`row-claim` imports
 * `wake`, which imports this), so a test pins the two to the same text. WHAT IT DOES NOT PREDICT: the exact-branch and
 * origin-branch refusals (the second is `rowBranchOrders`' already) -- a row refused for one of those is not reported
 * here, and says so by being offered without ever being reported.
 *
 * A TREE A RELEASE KEPT FOR THIS ROW IS NOT A REFUSAL: the spawner adopts it (`--adopt`, #2470), so the claim lands.
 */
export function claimRefusalOf(row: { number: number; repoKey?: string; }, { worktreesDir, kept = {}, exists = existsSync, owner = worktreeOwner }: {
        worktreesDir: string; kept?: Record<string, { worktree?: string; }>; exists?: (path: string) => boolean;
        owner?: typeof worktreeOwner;
    }): string | null {
  const keptTree = kept[String(row.number)]?.worktree;
  if (keptTree !== undefined && exists(keptTree)) return null;
  // agent-org#819: a KEYED row is claimed into `wt-<key>-<n>` (`claimNames`, `row-claim.ts`), which this file cannot import; a test pins the two.
  const tree = `wt-${row.repoKey ? `${row.repoKey}-` : ""}${row.number}`;
  const path = join(worktreesDir, tree);
  if (!exists(path)) return null;
  const who = owner(path);
  return `--worktree=../${tree} ALREADY EXISTS, ${who ? `stamped by \`${who}\`` : "UNSTAMPED (nobody recorded an owner, which is not the same as free)"}. `
    + "Refusing before any write: a claim that went on would act inside a tree it did not create.";
}

/**
 * The streaks after one more tick. KEYED ON THE ROW AND THE REFUSAL TEXT: the same refusal extends the streak, a CHANGED
 * one starts it again at 1, and a row with no refusal this tick (claimed, withdrawn, or its tree gone) is simply not carried.
 *
 * @param readings row -> this tick's refusal, or `null` for none
 */
export function nextRefusalStreaks(before: Record<string, { reason: string; ticks: number; }>, readings: Record<string, string | null>): Record<string, { reason: string; ticks: number; }> {
  const after: Record<string, { reason: string; ticks: number; }> = {};
  for (const [row, reason] of Object.entries(readings)) {
    if (reason === null) continue;
    after[row] = { reason, ticks: before[row]?.reason === reason ? before[row].ticks + 1 : 1 };
  }
  return after;
}

/**
 * THE WHOLE OF THIS CAUSE'S MEMORY FOR ONE TICK: read each offered row's refusal, advance the streaks on disk, and return them.
 * NEVER THROWS, and says so on stderr: a broken detector must not stop the orders behind it, and it returns NO streaks rather
 * than stale ones, so nothing is reported on a tick that could not be read.
 * @param offerable the rows `partitionUnclaimed` judged offerable this tick
 * @param [host] every one a seam
 */
export function claimRefusalStreaksNow(offerable: any[], { stateDir = REVIEWER_STATE_DIR, worktreesDir = dirname(REPO_CHECKOUT),
  log = (line) => process.stderr.write(line), ...seams }: {
        stateDir?: string; worktreesDir?: string; log?: (line: string) => void; exists?: (path: string) => boolean;
        owner?: typeof worktreeOwner;
    } = {}): Record<string, { reason: string; ticks: number; }> {
  try {
    const path = `${stateDir}/${CLAIM_REFUSALS_FILE}`;
    const before = readJsonObject(path);
    const kept = readJsonObject(`${stateDir}/${KEPT_CLAIMS_FILE}`);
    const readings: Record<string, string | null> = {};
    for (const row of offerable) readings[subjectRef(row.repoKey, row.number)] = claimRefusalOf(row, { worktreesDir, kept, ...seams });
    const after = nextRefusalStreaks(before, readings);
    if (JSON.stringify(after) !== JSON.stringify(before)) writeJsonObject(path, after);
    return after;
  } catch (err: any) {
    log(`claim-refusals: could not run (${String(err?.message ?? err).split("\n")[0]}) -- no ready-row-unclaimable order this tick.\n`);
    return {};
  }
}

/**
 * `claimRefusalStreaksNow` over the rows `decide` will OFFER -- the same `partitionUnclaimed` reading, so the streaks advance on
 * those rows and on no others (a row shelved for B4 or a branch on `origin` is not being refused by the claim, it is not offered).
 */
export function offeredRefusalStreaks(rows: Parameters<typeof partitionUnclaimed>[0], prFiles: Parameters<typeof partitionUnclaimed>[1], options: Parameters<typeof partitionUnclaimed>[2]) {
  return claimRefusalStreaksNow(partitionUnclaimed(rows, prFiles, options).offerable);
}

/**
 * One order to `product-manager` per offered row whose claim has been refused `UNCLAIMABLE_AFTER_TICKS` ticks running, QUOTING
 * the refusal. THE DISCRIMINATOR CARRIES THE REFUSAL'S DIGEST, which is what `emptyShelfOrder`'s count is for it: the order
 * stops repeating while the answer is unchanged, and a refusal that changes (a different owner stamped the tree) is a new
 * question and re-fires. It stops altogether when the row is claimed or leaves the shelf, because `offerable` no longer holds it.
 * `streaks` ABSENT MEANS NOT ASKED and carries no default here, for `rowBranches`'s reason: `decide` sits on its complexity limit.
 */
export function unclaimableRowOrders(offerable: any[], streaks: Record<string, { reason: string; ticks: number; }> | undefined): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  return offerable.flatMap((row) => {
    const ref = subjectRef(row.repoKey, row.number);
    const seen = streaks?.[ref];
    if (seen === undefined || seen.ticks < UNCLAIMABLE_AFTER_TICKS) return [];
    const discriminator = `${ref}-${digestOf(seen.reason)}`;
    return [{
      session: "product-manager",
      cause: "ready-row-unclaimable",
      subject: `row-${ref}`,
      discriminator,
      prompt: `Ready row ${subjectMention(row)} CANNOT BE CLAIMED: the gate has offered it to the engineers and the claim has `
        + `refused it on ${seen.ticks} consecutive ticks. The refusal, quoted:\n\n> ${seen.reason}\n\n`
        + "Nobody can act on this but whoever stocks the queue, and nothing else will tell you: an offer the claim refuses is "
        + "logged and retried, and `ready-queue-empty` stays silent while the row sits in the pool.\n"
        + "Find out whose tree it is (`pnpm run worktree:whose <path>`) and whether that session still holds the row. A "
        + "live holder whose row lost its claim label needs the label back; a leftover tree whose work is merged and clean "
        + "goes with `pnpm run worktrees:prune` (never `rm -rf`), which names and leaves any dirty one; a tree with unpushed "
        + "work is that session's to finish. If none of that fits, take the row off the shelf (`" + BLOCKED_LABEL + "`, with what would "
        + "clear it) so the engineers stop being offered it.",
      causeKey: `product-manager/ready-row-unclaimable/${discriminator}`,
    }];
  }).slice(0, MAX_ROW_ORDERS_PER_TICK);
}

/**
 * A READY ROW WHOSE WORK IS ALREADY ON `origin`, SAID OUT LOUD -- #2031.
 *
 * #2014 bought the interception at CLAIM time: a session that tries to claim such a row is refused and
 * told where the work is. IT SAYS NOTHING TO ANYONE WHO NEVER ATTEMPTS A CLAIM, and this gate -- which is
 * what actually offers rows to the org -- was one of those readers. Measured 2026-09-22 on #2000: the
 * branch was pushed at 21:02:36Z, the row read `ready` with no `session:` label until 21:22Z, and
 * `gh pr list --head <branch> --state all` returned `[]` throughout. The gate offered it as
 * `ready-row-unclaimed` every two minutes, because `ready` with no `session:` label was the entire
 * question it asked.
 *
 * IT NAMES THE BRANCH AND ITS SHA AND CONCLUDES NOTHING ELSE. A branch on `origin` whose name ends in
 * this row's number means the work EXISTS; it cannot tell finished work from abandoned work, and #2031's
 * own "what this will NOT fix" says so rather than leaving it implied. So the prompt sends the reader to
 * the branch with two commands that spend no pool, and names the three exits rather than asserting one.
 *
 * ROUTED TO THE LANE OWNER, ELSE `product-manager`. This is a QUEUE-STATE fact -- a row the board
 * advertises as startable that is not -- and `product-manager` is this org's first reader for rows, the
 * queue and holds (the chairman's 2026-09-14 routing direction). It is deliberately NOT routed to
 * `engineers`: the pool's answer to a row is to CLAIM it, which is the one action #2014 already refuses.
 *
 * A JUDGMENT CAUSE (`JUDGMENT_CAUSES`), because its answer is durable. "This branch is abandoned, leave
 * it" does not change the row, the branch or the sha, so an ACTION cause's twenty-minute expiry would
 * re-offer the identical question until the STUCK cap stopped it -- the cost `lane-backlog-unpromoted`
 * paid on #1564. The key carries the sha, so a PUSH to that branch is a new question and reaches the
 * owner immediately.
 *
 * @param readyRows the `ready` rows (`readReadyRows`)
 *
 *        `readRowBranches`'s answer. `null` (the default) is "not asked or refused" and emits NOTHING:
 *        a tick that could not reach `origin` must not invent this condition, and must not report a
 *        false all-clear either -- it simply says nothing new, which is what it did before #2031.
 * @param [openPrs] the open pull requests the tick already
 *        read (#3010). A branch one of them is on is NOT unshipped, so its order names the PR and `--adopt` instead of
 *        advising "open its pull request". Absent is none, and the order is exactly what #2031 wrote.
 * @param [branchPrs] `readBranchPrs`'s answer (#3892). A row whose branches
 *        are all closed-unmerged is OFFERED by `rowOrders` and gets no order here: asking `product-manager` to read a branch that was closed on purpose is the dead end this fixes.
 */
export function rowBranchOrders(readyRows: any[], rowBranches: { branch: string; head: string; row: number; }[] | null = null, openPrs: { number: number; headRefName?: string; labels?: any[]; }[] = [], branchPrs: { branch: string; number: number; state: string; }[] | null = null): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  if (!Array.isArray(rowBranches)) return [];
  const byRow = branchIndex(rowBranches);
  const replaceable = branchesToReplace(rowBranches, branchPrs);
  const orders = [];
  // OLDEST FIRST AND CAPPED, `rowOrders`'s shape: a queue that hands out its newest rows first starves
  // its oldest, and the number is a row number, so ascending IS oldest.
  const oldestFirst = [...readyRows].sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of oldestFirst) {
    // UNCLAIMED IS THE POPULATION, and `session:` is the label the done-when names. A claimed row
    // already has a session that knows about its own branch, and `claimed-row-amended` is the cause
    // that speaks to a holder. `CLAIM_LABEL` goes with it because the two are written together by
    // `row-claim.ts` and a row carrying either is not a fresh start.
    if (sessionOf(row) || labelsOf(row).includes(CLAIM_LABEL)) continue;
    const pushed = byRow.get(Number(row.number)) ?? [];
    if (pushed.length === 0 || replaceable.has(Number(row.number))) continue;
    orders.push(unshippedOrder({ row, pushed, openPr: openPrOnBranch(pushed, openPrs) }));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * #3010: THE OPEN PULL REQUEST, IF ANY, THAT ONE OF THESE BRANCHES IS ON. Read off the `pr list` the tick already made,
 * so it spends no pool -- `readRowBranches` is API-free on purpose and a per-row `gh pr list --head` would undo that.
 */
function openPrOnBranch(pushed: { branch: string; head: string; }[], openPrs: { number: number; headRefName?: string; labels?: any[]; }[] | null | undefined): { number: number; branch: string; holder: string | null; } | null {
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    const found = pushed.find(({ branch }) => branch === pr.headRefName);
    if (found) return { number: pr.number, branch: found.branch, holder: sessionOf(pr) };
  }
  return null;
}

/**
 * The order itself, split out so `rowBranchOrders` stays a walk over rows (the Stepdown Rule, and the
 * same seam `claimedRowAmendedOrders`/`amendedOrder` already use).
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * measured 2026-09-22 on #2000: its branch sat pushed for 20 minutes while the row read `ready`, and a second session was routed into the
 * same three Region paths.
 */
function unshippedOrder({ row, pushed, openPr }: { row: any; pushed: { branch: string; head: string; }[]; openPr: { number: number; branch: string; holder: string | null; } | null; }) {
  const owner = laneOwnerOf(row) ?? "product-manager";
  // THE PR IS PART OF THE KEY: an order already spent for the bare branch must not suppress the one that says a PR exists.
  const key = pushed.map(({ branch, head }) => `${branch}@${head}`).sort().join("+") + (openPr ? `#pr${openPr.number}` : "");
  const first = pushed[0].branch;
  return {
    session: owner,
    cause: "row-branch-unshipped",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: key,
    prompt: `Row ${subjectMention(row)} reads \`${READY_LABEL}\` and unclaimed, but ${branchesText(pushed)}.\n`
      + "THE BOARD IS SAYING SOMETHING THAT IS NOT TRUE, and until this is settled the gate has STOPPED "
      + `offering ${subjectMention(row)} as a fresh start -- so nobody will be routed into work that may already exist.\n`
      + (openPr ? openPrSentence({ row, openPr }) : unpushedSentence(first))
      + "IF IT NEEDS A WAIT INSTEAD, that goes in a FIELD and not a comment: `Not-before: YYYY-MM-DD` in "
      + `the body, \`gh issue edit ${row.number} --add-blocked-by <n>\`, or \`${ANSWER_PREFIX}<session>\`. `
      + "Each clears itself.",
    causeKey: `${owner}/row-branch-unshipped/row-${subjectRef(row.repoKey, row.number)}/${key}`,
  };
}

/** The #2031 body of the order, for a branch with NO pull request: read it, then one of three exits. */
function unpushedSentence(first: string) {
  return "READ THE BRANCH FIRST. Both of these spend NO API pool: "
    + `\`git fetch origin && git log --oneline origin/main..origin/${first}\` and `
    + `\`git diff origin/main...origin/${first}\`.\n`
    + "THEN ONE OF THREE, and this gate deliberately does not guess which: if the work is FINISHED, "
    + "open its pull request (that is the act that makes the row look claimed, and it is what was "
    + "missing); if it is ABANDONED, delete the branch on `origin` and the row goes back on offer "
    + "unchanged; if the trailing number is a COINCIDENCE rather than this row's work, rename or "
    + "delete that branch -- the match is on the name, which is all `ls-remote` can see.\n";
}

/**
 * #3010: the body of the order when the branch ALREADY HAS an open pull request. "Open its pull request" is wrong advice
 * there and "delete the branch" is worse -- it closes the PR. Measured on #2981: PR #2987 was open for 4h while the row
 * was re-offered the three exits above, and the only way to finish it, `claim --adopt`, was named nowhere.
 * `claim`'s own refusal (#2014) is unchanged: it still refuses a row whose branch is on `origin`, and `--adopt` is the exit it leaves.
 */
function openPrSentence({ row, openPr }: { row: any; openPr: { number: number; branch: string; holder: string | null; }; }) {
  const holder = openPr.holder ?? `<the session on the PR's \`${SESSION_PREFIX}\` label>`;
  return `THE WORK IS NOT UNSHIPPED: \`${openPr.branch}\` already has OPEN pull request #${openPr.number}. `
    + "DO NOT delete the branch (that closes the PR) and do not open another.\n"
    + `TO FINISH IT, take the previous holder's worktree in place, from inside it: \`pnpm run row-claim claim ${row.number} `
    + `--session=<you> --branch=${openPr.branch} --worktree=<that worktree> --adopt=${holder}\`. `
    + "A plain claim is refused for as long as the branch is on `origin` (#2014), and that refusal is right: `--adopt` is the one "
    + "claim that resumes a tree and its pull request rather than starting over.\n";
}

/**
 * One order per unclaimed Ready row whose body lacks a required template section (#2791) -- the SPOKEN half of
 * what `partitionUnclaimed` withholds, so a shelved row is never a silent one.
 *
 * THE ROW IS THE STATE. The key carries the missing sections, so the order stops the moment the section is
 * added and a second one appears if a different section is later removed. Routed to the lane owner, else
 * `product-manager`, who owns filing, amendments and promotion: the remedy is one `## <Field>` heading
 * with real content under it, and the claim refuses until it exists.
 *
 * A JUDGMENT CAUSE for `row-branch-unshipped`'s reason -- the answer is durable, so an action cause's expiry
 * would re-ask an unchanged row.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * measured 2026-09-30 on #2729 and #2730: both sat `ready` for ~38h behind exactly that refusal while the queue read as stocked and
 * `ready-queue-empty` never fired.
 *
 * @param readyRows the `ready` rows (`readReadyRows`)
 */
export function incompleteRowOrders(readyRows: any[]): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const orders = [];
  const oldestFirst = [...readyRows].sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of oldestFirst) {
    if (sessionOf(row) || labelsOf(row).includes(CLAIM_LABEL)) continue;
    const missing = missingFieldsOf(row);
    if (missing.length === 0) continue;
    const owner = laneOwnerOf(row) ?? "product-manager";
    const subject = `row-${subjectRef(row.repoKey, row.number)}`;
    orders.push({
      session: owner,
      cause: "ready-row-incomplete",
      subject,
      discriminator: missing.join("+"),
      prompt: `Row ${subjectMention(row)} reads \`${READY_LABEL}\` and unclaimed, but ${templateGapText(missing)}, `
        + "so `row-claim` REFUSES every claim on it (`NOT CLAIMED: ... is missing <section>`). The gate has "
        + "STOPPED offering it and no longer counts it as Ready stock, so a row stuck behind this "
        + "refusal cannot make the queue read as stocked.\n"
        + "ADD THE SECTION, or take the label off: a `## <Field>` heading with real content under it "
        + "(`Region`, `Acceptance`, `Open-check`). This order stops by itself once the body is complete.",
      causeKey: `${owner}/ready-row-incomplete/${subject}/${missing.join("+")}`,
    });
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The open pull requests that declare a `Closes` number and that GitHub resolved NOTHING for -- but only while that is
 * REPO-WIDE, by `isRepoWideResolutionFault`'s own three-sibling rule (#2823). `[]` when the condition does not hold,
 * and a PR whose `closingIssuesReferences` was not read (a fixture, a refused field) is neither declared-and-unresolved
 * nor a sibling: an absent field is "not asked", never "resolved nothing".
 */
export function closesUnresolvedPrs(prs: any[] | null): any[] {
  const candidates = (prs ?? [])
    .filter((pr) => Array.isArray(pr.closingIssuesReferences) && typeof pr.body === "string")
    .map((pr) => ({ pr, declaration: extractClosesDeclaration(pr.body) }))
    .flatMap(({ pr, declaration }) => declaration.kind === "closes" && declaration.numbers.length > 0
      ? [{ pr, declared: declaration.numbers,
        resolved: pr.closingIssuesReferences.map((issue: { number: number; }) => Number(issue.number)) }]
      : []);
  const newestFirst = [...candidates].sort((a, b) => Number(b.pr.number) - Number(a.pr.number));
  const asLookup = newestFirst.map(({ pr, resolved }) => ({ number: Number(pr.number), body: pr.body, resolved }));
  const held = newestFirst.filter(({ pr, declared, resolved }) =>
    isRepoWideResolutionFault({ declared, resolved }, recentClosesSiblings(asLookup, Number(pr.number))));
  return held.map(({ pr }) => pr).sort((a, b) => Number(a.number) - Number(b.number));
}

/**
 * ONE order, to `product-manager`, while GitHub resolves no closing reference for the open pull requests that declare one
 * (#2823). `closes-mismatch-check.ts` used to print "Tell `product-manager`" into a CI log for this and nothing reads a
 * CI log for an instruction: all 8 open PRs failed `gate` for ~2h on 2026-09-30 before the chairman noticed idle agents.
 * It now PASSES with a warning (#2822), which is quieter still, so the gate says it. NOT `pr-checks-failing`: that tells an
 * AUTHOR to fix a branch, and this fault is on no branch.
 *
 * KEYED ON THE SET OF PULL REQUESTS, so it is asked once per condition and stops the moment a PR resolves (the rule then
 * no longer holds). JUDGMENT: the answer is durable, and an action cause's expiry would re-ask an unchanged set.
 */
export function closesUnresolvedOrders(prs: any[] | null, now: number = Date.now()): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const held = closesUnresolvedPrs(prs);
  if (held.length === 0) return [];
  const numbers = held.map((pr) => Number(pr.number)).sort((a, b) => a - b);
  const oldestMs = Math.min(...held.map((pr) => Date.parse(pr.createdAt)).filter((t) => Number.isFinite(t)));
  const standing = Number.isFinite(oldestMs) ? `, the oldest open ${standingText(now - oldestMs)}` : "";
  const discriminator = numbers.join("+");
  return [{
    session: "product-manager",
    cause: "closes-unresolved-repo-wide",
    subject: "closes-resolution",
    discriminator,
    prompt: `GitHub resolves NO closing reference for ${numbers.length} open pull requests that each declare a \`Closes\` `
      + `row (${held.map((pr) => subjectMention(pr)).join(", ")}${standing}). `
      + "GitHub resolved nothing for these, nor for the three newest siblings of each, so the fault is GitHub's or the "
      + "repo's and is on no branch -- do NOT send their authors to fix a body.\n"
      + "`closes-mismatch-check.ts` PASSES them with a warning and the post-merge closer closes the declared rows from "
      + "the body, so nothing is blocked; the reader is needed for the rest: check whether GitHub is degraded, that the "
      + "closer ran for each merge since, and file a row if it persists. This order stops by itself when any of them "
      + "resolves.",
    causeKey: `product-manager/closes-unresolved-repo-wide/${discriminator}`,
  }];
}
