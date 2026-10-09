// module: the org-health facts and orders -- what the tick reads and says about whether the org is landing work (#2898)
//
// MOVED OUT OF `work-gate.ts`, NOT REWRITTEN (#2898, the second split of #928's lever 2a, after #2542): the readings
// `orgHealthNow` hands to `org-health.mjs` (red pull requests, the fleet's captures, the wait facts and the rulings
// the tick re-reads) and the orders built from them. Measured on #2898 over the pairs of pull requests that waited
// on B4: six rows waited behind fixes to exactly these definitions and nothing else in the file.
//
// THE BOUNDARY, as `work-gate/pr-orders.mjs` states it: what only this family uses lives here, and what a family
// that stayed behind also uses (`readPrs`, `shouldBeMerging`, `partitionUnclaimed`, `holdExcused`'s callers) stays in
// `work-gate.ts` and is IMPORTED from it. That import is a cycle with the entry point, safe only while nothing
// here reads an imported binding at load time; the one top-level `const` here (`MAX_WAIT_READS`) is a literal.
// `redPrFacts` STAYED in `work-gate.ts`: it is the one place the gate asks `red-pr.ts`'s `isBrokenRed`, and
// `org-health.test.ts`'s #2956 guard accepts a file that reads the rollup only if it imports that decider, so the
// import and its one caller stay together. `work-gate.ts` re-exports every name this file exports that it exported before.
import { TSX_IMPORT } from "../tsx-import.ts";
import { REPO_CHECKOUT, HOUR_MS, fleetBatchRows, defaultRun, repoNow, MAX_ROW_ORDERS_PER_TICK,
  shouldBeMerging, scopesOf, labelsOf, sessionOf, REVIEWER_STATE_DIR, dispatchedLabJobsOrSay, redPrFacts, partitionUnclaimed, openBlockers, rowKind, productRegionsOf } from "../work-gate.ts";
import { declaredRegionFiles, regionCovers, splitRegionEntry } from "../region-paths.ts";
import { ORG_TRACKER_REPO } from "../row-tracker.ts";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.ts";
import { claimRecordOf } from "../claim-stall.ts";
import { idleClaimantReading } from "../idle-claimant.ts";
import { familyNumber } from "../arm-pr.ts";
import { readAgents } from "../herdr-agents.ts";
import { boardTruthAudit, readBoardFacts, postDaysTable, proseAudit, readProseFacts } from "../board-truth-audit.ts";
import { editionDay } from "../board-discussion.ts";
import { idleWithOpenRowsReading, IDLE_REASONS } from "../idle-with-open-rows.ts";
import { roleBriefPath } from "../project-roles.ts";
import { waitingOn, fleetWaitingOn, notBeforeDate, todayIso } from "../waiting-condition.ts";
import { ANSWER_PREFIX, NEEDS_CHAIRMAN_LABEL, SESSION_PREFIX, LANE_PREFIX } from "../project-vocabulary.ts";
import { FLEET_IDLE_HOURS, PRIMARY_MILESTONE_LINE, readLatestMerge, orgHealthTick,
  primaryStandingSince, readTeamAccess, SIGNALS, MILESTONE_CLOCK_MINUTES, milestoneClockReading, orgHealthOrders, shelvedCircles } from "../org-health.ts";
import { declaredClosedRows } from "../row-claim/file-overlap-rule.ts";
import { holdersOf, holdExcused } from "../pr-hold-state.ts";
import { withoutHold } from "../red-pr.ts";
import { subjectRef, subjectMention } from "../review-attribution.ts";
import { readRulings, unreadableLine, rulingTick } from "../ruling-record.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { readReleaseFacts, registryDistTags, remoteTagExists, splitHeldOnSatisfied, heldOnSatisfiedOrders, umbrellaEdges, umbrellaEdgeOrders } from "./held-on-satisfied-orders.ts";
import { referencesOf, releaseReferencesOf, waitItemOf, staleWaits, bareWaits, manualWaits, parseWaits, liftableHolds, isItemWait } from "../wait-condition.ts";
import { stallReasonOf, ownerOfPr } from "./pr-orders.ts";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Where the fleet watch writes the capture ledger (#2979), under the project checkout: `packages/control/src/fleet-watch.mjs`'s `DEFAULT_CAPTURES_STATE_PATH`. */
export const FLEET_CAPTURES_LEDGER = "runs/fleet-captures-state.json";

type LedgerWorker = { rises: { at: number; by: number }[]; lastRoseAt: number | null };

const isLedgerWorker = (worker: any) => Boolean(worker) && Array.isArray(worker.rises)
  && (worker.lastRoseAt === null || Number.isFinite(worker.lastRoseAt))
  && worker.rises.every((rise: any) => Boolean(rise) && Number.isFinite(rise.at) && Number.isFinite(rise.by));

/**
 * #2980: WHAT THE FLEET CAPTURED IN THE LAST `FLEET_IDLE_HOURS`, read from the ledger `fleet-watch.mjs` keeps (#2979), as
 * `{ captures24h, lastCaptureAt }`.
 *
 * READ HERE, NOT IMPORTED: `readCaptureTimes` lives in `packages/control`, and `agent-org-outward-edges.test.ts` (#2658) forbids the
 * tool importing the product tree. The ledger's field names are therefore a contract between two files, and
 * `org-health-fleet-wiring.test.ts` runs both over the same ledger so a rename on either side is red.
 *
 * THREE ANSWERS, AND THE TWO NON-VALUES ARE NOT THE SAME. `null` is a stated unknown: the file is missing or corrupt (one bad worker
 * entry makes the whole file null, as in the writer, because an empty ledger would answer "zero captures", a claim about the fleet nobody
 * read). `undefined` is NO READING: the ledger is YOUNGER than the window and holds no capture, and a zero from a ledger started a
 * minute ago is not a day of idleness -- but it is not a fault either, and `orgHealthReadings` reads an omitted fleet as silent, so
 * the first day does not log an UNKNOWN every tick for `repeating-lines.ts` to offer at 30 ticks (`copiesToCompare`'s reason). A capture
 * inside a young ledger is still a capture.
 */
export function readFleetCaptures({ now, path = join(REPO_CHECKOUT, FLEET_CAPTURES_LEDGER), read = readFileSync }: { now: number; path?: string; read?: (path: string, encoding: "utf8") => string; }): { captures24h: number; lastCaptureAt: number | null; } | null | undefined {
  try {
    const ledger = JSON.parse(read(path, "utf8"));
    const workers = ledger?.workers;
    if (!Number.isFinite(ledger?.since) || !workers || typeof workers !== "object" || Array.isArray(workers)
      || !Object.values(workers).every(isLedgerWorker)) return null;
    const windowMs = FLEET_IDLE_HOURS * HOUR_MS;
    const all = Object.values(workers) as LedgerWorker[];
    const captures24h = all.flatMap((w) => w.rises).filter((rise) => now - rise.at < windowMs).reduce((sum, rise) => sum + rise.by, 0);
    const rose = all.flatMap((w) => (w.lastRoseAt === null ? [] : [w.lastRoseAt]));
    if (captures24h === 0 && now - ledger.since < windowMs) return undefined;
    return { captures24h, lastCaptureAt: rose.length ? Math.max(...rose) : null };
  } catch {
    return null;
  }
}

/**
 * #2980: WHAT WAITS FOR THE FLEET, for `fleetIdleReading`: the open `fleet-gated` rows nothing else stops -- `fleetBatchRows`' own
 * selection, so this and `fleet-batch-due` cannot disagree about which rows are waiting. `openRows` is the RAW read, `null` for a
 * refusal, and that is `null` here: an empty list would read as "nobody is waiting".
 *
 * #3007: `labJobs` IS THE LAB JOBS DISPATCHED AND NOT YET ENDED (`dispatchedLabJobsOrSay`), `null` for a refused read. It was always `[]` while
 * the gate read only the jobs that ENDED, so a fleet idle with only a lab job waiting never tripped. A refused job read is not "no
 * jobs": with rows waiting the answer is still known (they trip alone, and the jobs are not claimed empty), and with none it is `null`,
 * unknown. OMITTED is `[]`, the one-argument form the row-only callers use.
 */
export function fleetWaitingFacts(openRows: any[] | null, labJobs: string[] | null = []): { rows: number[]; labJobs: string[]; } | null {
  if (openRows === null) return null;
  const rows = fleetBatchRows(openRows).map((row) => Number(row.number));
  return labJobs === null && rows.length === 0 ? null : { rows, labJobs: labJobs ?? [] };
}

/**
 * #3486: EVERY OPEN PR AS A CANDIDATE FOR THE OUTCOME CLOCK, whatever state it is in -- held, drafted, armed, red, conflicted: NOTHING IS FILTERED OUT,
 * which is the point (the classifier's two "not a stall" answers used to drop exactly the PRs whose reason had gone). THE REASON IS `stallReasonOf`'s,
 * the same function that decides who is ordered, and it is only a LABEL on the alarm. The clock starts at the PR's `createdAt` and costs NO read:
 * `pr list` already carries it, where the quiet-time version it replaced asked one `gh api` call per quiet PR for the head commit's date. A PR with
 * no `createdAt` is `since: null`, an unknown and not an age.
 */
export function stalledPrFacts(prs: any[], required: string[] | null, { now }: { now: number; }): import("../org-health.ts").OverdueCandidate[] {
  return prs.map((pr) => {
    const owner = ownerOfPr(pr);
    return { kind: "pr", number: pr.number, reason: stallReasonOf(pr, required, now), owner: owner.source === "ceo" ? null : owner.session,
      since: epochOrNull(pr.createdAt) };
  });
}

/**
 * #3486 (slice 2b): HOW LONG A HOLDER MAY SIT IDLE ON A CLAIM THAT HAS MOVED NOTHING before the row is NAMED for it (`never-started`, `wait-premise-gone`).
 * MEASURED 2026-10-04 (a reading at a moment: re-derive before quoting), and read as the LAST commit a holder that is going to move still makes, not as a
 * multiple of a median: the median is 4 minutes, so "3 x median" would be 12 minutes, and a bound that short names a holder between two turns.
 *   POPULATION  33 rows closed by a merged pull request, the newest 45 merged of the project's own repository (`gh pr list --state merged --limit 45
 *               --json number,createdAt,mergedAt,commits,closingIssuesReferences`, a larger page is refused by GitHub's node limit), each with the
 *               newest `claimed by` record before its first commit (`gh issue list --state closed --limit 300 --json number,closedAt,comments`).
 *   THE GAP     claim record to the pull request's FIRST COMMIT: p50 / p75 / p90 / p95 / max = 4.0 / 8.3 / 50.4 / 77.0 / 101.4 min; claim to the pull
 *               request OPENING, for comparison: 26.7 / 43.8 / 62.9 / 103.4 / 133.6 (`IDLE_CLAIMANT_MINUTES`'s own 27-42 reading agrees).
 *   RESULT      77.0 is the p95, plus one tick (about 2 minutes) of margin, rounded to 80.
 * WHAT THIS DOES NOT PROVE: that 33 rows are the distribution (the thinnest of this file's three readings), nor that a holder was `idle` throughout
 * (`herdr` keeps no history). **IT IS BELOW `OVERDUE_ROW_MINUTES` (135) AND THE CLOCK DOES NOT YET READ IT AS A BOUND**: `boundOf` is in `org-health.mjs`,
 * a file #3533 declares, so today it only decides whether a row the 135-minute clock raises is NAMED for the shape. #3495's 100 minutes is therefore
 * NOT raised by it (`outcome-clock.test.ts` says so), and the follow-up is `boundOf` reading a per-item bound.
 */
export const OVERDUE_IDLE_CLAIM_MINUTES = 80;
const IDLE_CLAIM_MS = OVERDUE_IDLE_CLAIM_MINUTES * 60_000;

/**
 * The reasons an idle claimed row is NAMED for, besides `claimed` and `held`. A LABEL on the alarm and never a condition for raising it. `NO_WAIT` (#3569) is
 * the general one: the holder is idle, nothing has moved for the bound, and it declares NO wait the gate can read (a row field, or a kind on a pull request
 * it owns), whether or not it once moved -- the two named shapes are the cases where the CAUSE is known.
 */
export const IDLE_CLAIM_REASON = Object.freeze({ NEVER_STARTED: "never-started", WAIT_PREMISE_GONE: "wait-premise-gone", NO_WAIT: "idle-no-wait" });

/**
 * `moves` is the claim-stall tick's reading of every claimed row (`ClaimFactsOfTick.moves`; `null` when that tick evaluated none), `agents` herdr's own
 * workspace listing (`null` when herdr could not be asked).
 */
export type Holders = { moves: Map<number, ClaimMoves> | null, agents: {label: string, status: string}[] | null, now: number };
export type ClaimMoves = import("./claim-stall-tick.ts").ClaimMoves;

/**
 * The wait kinds a claimed row DECLARES as fields, which `idleClaimantReading` counts: `claim-stall-tick.mjs`'s `declaredWaitOf` plus its open `blockedBy`
 * edges, restated because that function is not exported and the file is not this row's Region. `answer:<the holder>` is not the holder's wait.
 * THE TICK'S `now` DECIDES WHETHER A `Not-before:` HOLDS, never the wall clock (`waitingOn` defaults to it), or a clock handed a time reads another day's wait.
 */
function waitKindsOf(row: any, holder: string | null, now: number): string[] {
  const today = todayIso(new Date(now));
  const waiting = waitingOn({ ...row, blockedBy: { nodes: [] } }, today, now) ?? fleetWaitingOn(row, today, now);
  const kind = waiting === null || (waiting.kind === "answer" && waiting.session === holder) ? [] : [waiting.kind === "date" ? "not-before" : waiting.kind];
  return [...kind, ...(labelsOf(row).includes(NEEDS_CHAIRMAN_LABEL) ? ["chairman"] : []), ...(openBlockers(row).length > 0 ? ["blocked-by"] : [])];
}

/**
 * The moves of a claimed row that is IN QUESTION for the idle shapes: read, not merged and untouched for `OVERDUE_IDLE_CLAIM_MINUTES`. A row owning a pull
 * request IS in question since #3569 (it used to be `pr-owned` and so never read): the holder's wait on that pull request is a fact `idleClaimantReading`
 * can read, and a holder idle on one with none is the stall. `null` for any row outside that, so neither the herdr listing nor a reading is spent on it.
 */
function untouchedMoves(number: number, holders: Holders): { moves: ClaimMoves; lastMove: number; } | null {
  const moves = holders.moves?.get(Number(number));
  if (moves === undefined || moves.mergedAt !== null) return null;
  const lastMove = Math.max(...[moves.claimedAt, moves.comment, moves.commit, moves.push].filter((at) => at !== null));
  return holders.now - lastMove >= IDLE_CLAIM_MS ? { moves, lastMove } : null;
}

/**
 * WHY AN IDLE HOLDER WITH NO READABLE WAIT IS NAMED: `wait-premise-gone` when the row still carries a `Not-before:` that `waitingOn` no longer holds (the
 * field is in the past, and it names the CAUSE, so it is asked first), `never-started` for a claim with no commit, push, comment or pull request of the
 * holder's, and `idle-no-wait` for every other holder that has moved before and then stopped with nothing declared.
 */
function idleReasonOf(row: any, { commit, push, comment, openPrs }: ClaimMoves): string {
  if (notBeforeDate(row.body) !== null) return IDLE_CLAIM_REASON.WAIT_PREMISE_GONE;
  return commit === null && push === null && comment === null && openPrs.length === 0 ? IDLE_CLAIM_REASON.NEVER_STARTED : IDLE_CLAIM_REASON.NO_WAIT;
}

/**
 * ONE CLAIMED ROW'S IDLE SHAPE: `{ reason }` when its holder is idle on a row nothing has moved, with NO wait the gate can read, naming why; `{ unknown }` when
 * the listing could not say whether the holder is idle (a refused or partial one -- never a clear and never a trip); `null` when the row is not in
 * question or its holder is working, waiting on a declared field, gone, or A STANDING SEAT (`familyNumber` is `null` for it: a standing seat idle between
 * orders is waiting for its next one, the normal state and not a stall, #3569). `idleSince` is the row's last move, so `idleClaimantReading`'s stall is "idle
 * NOW and nothing has moved for the bound": herdr keeps no history, so the real idle run is at least as short, and a holder that is BUSY now is never named.
 * THE HOLDER'S PULL REQUESTS ARE PASSED (#3569), so a review requested, checks pending, an approval the queue owns, `awaiting-evidence` and a `hold:` read as
 * the wait they are rather than as `pr-owned` silence; the two clocks stay separate (the pull request is its own item at its own bound).
 */
function idleShapeOf(row: any, holders: Holders): { reason: string; } | { unknown: string; } | null {
  const touched = untouchedMoves(row.number, holders);
  const holder = sessionOf(row);
  if (touched === null || holder === null || familyNumber(holder) === null) return null;
  const reading = idleClaimantReading({ session: holder, waitKinds: waitKindsOf(row, holder, holders.now), prs: touched.moves.openPrs },
    { now: holders.now, agents: holders.agents, idleSince: touched.lastMove });
  if (reading.kind === "unknown") return { unknown: reading.why };
  return reading.kind === "stall" ? { reason: idleReasonOf(row, touched.moves) } : null;
}

/**
 * #3486: EVERY CLAIMED ROW AS A CANDIDATE FOR THE OUTCOME CLOCK: the age runs from the NEWEST claim record (`claimRecordOf`, which is the claim and
 * not a release) and nothing but the row closing stops it. `claimedComments` is `readClaimedRowComments`'s page; a claimed row it does not carry, or
 * one with no claim record, is `since: null` -- an unknown, never young. The reason is `held` for a row carrying a `hold:` label and `claimed` otherwise,
 * and, when `holders` is given (slice 2b), the idle shape the row is in (`idleShapeOf`), which also gives the row ITS OWN bound, `OVERDUE_IDLE_CLAIM_MINUTES`
 * (#3569). `unknown` is why a shape could not be told, for `unread`.
 */
function claimedRowReadings(openRows: any[], claimedComments: any[], holders?: Holders): { items: import("../org-health.ts").OverdueCandidate[]; unknown: string[]; } {
  const commentsOf = new Map(claimedComments.map((row) => [Number(row.number), row.comments ?? []]));
  const unknown: string[] = [];
  const items = openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL)).map((row) => {
    const shape = holders === undefined ? null : idleShapeOf(row, holders);
    if (shape !== null && "unknown" in shape) unknown.push(shape.unknown);
    const base = labelsOf(row).some((label) => label.startsWith("hold:")) ? "held" : "claimed";
    const item = { kind: "row" as const, number: row.number, reason: base, owner: sessionOf(row), since: claimRecordOf(commentsOf.get(Number(row.number)) ?? [])?.at ?? null };
    return shape !== null && "reason" in shape ? { ...item, reason: shape.reason, boundMinutes: OVERDUE_IDLE_CLAIM_MINUTES } : item;
  });
  return { items, unknown };
}

export function claimedRowFacts(openRows: any[], claimedComments: any[], holders?: Holders): import("../org-health.ts").OverdueCandidate[] {
  return claimedRowReadings(openRows, claimedComments, holders).items;
}

/**
 * Whether the herdr listing is NEEDED: some claimed row is in question for the idle shapes. A quiet org, and a tick whose claims are all moving or own a
 * pull request, makes no herdr call (`work-gate.ts` pays for a read only when a condition derived from rows in hand asks for it).
 */
export function needsHolderAgents(openRows: any[], moves: Map<number, ClaimMoves> | null, now: number) {
  return openRows.some((row) => labelsOf(row).includes(CLAIM_LABEL) && untouchedMoves(row.number, { moves, agents: null, now }) !== null);
}

/**
 * #3486: THE OUTCOME CLOCK'S FACTS: the PRs and, when the tick holds the claimed rows' comments, the rows. `claimedComments` is `undefined` for a caller
 * that does not ask (silent: the rows are not clocked), and `null` for a refused read (a stated unknown). An open list that was refused clocks
 * nothing and says so; a refused PR list is `items: null`. `holders` (slice 2b) is whom the rows are held by: omitted, the rows are named `claimed`/`held`
 * only; `moves: null` is a claim-stall tick that read no claim, and a listing herdr could not give is `unread` -- said when some row needed it.
 */
export function overdueFacts({ prsRead, openRowsRead, claimedComments, required, now, holders }: { prsRead: any[] | null; openRowsRead: any[] | null; claimedComments?: any[] | null; required: string[] | null; now: number; holders?: Holders; }): { items: import("../org-health.ts").OverdueCandidate[] | null; unread: string[]; } {
  if (prsRead === null) return { items: null, unread: [] };
  const prs = stalledPrFacts(prsRead, required, { now });
  if (claimedComments === undefined) return { items: prs, unread: [] };
  if (openRowsRead === null) return { items: prs, unread: ["the open rows"] };
  if (claimedComments === null) return { items: prs, unread: ["the claimed rows' comments"] };
  const rows = claimedRowReadings(openRowsRead, claimedComments, holders);
  const unread = holders !== undefined && holders.moves === null && rows.items.length > 0 ? ["the claim-stall tick's reading of the claimed rows"] : [];
  return { items: [...prs, ...rows.items], unread: rows.unknown.length > 0 ? [...unread, "the herdr listing"] : unread };
}

/**
 * #3486: WHOM THE CLAIMED ROWS ARE HELD BY, for `overdueFacts`: the claim-stall tick's moves (`decideArgs.claimFacts`; `undefined` is a caller that did not
 * ask, so the rows are named `claimed`/`held` only) and, only when some row is in question for the idle shapes, herdr's listing.
 */
function holdersForClock({ openRowsRead, claimFacts, now, readHolderAgents }: {
        openRowsRead: any[] | null; claimFacts: import("./claim-stall-tick.ts").ClaimFactsOfTick | null | undefined; now: number;
        readHolderAgents: typeof readAgents;
    }): Holders | undefined {
  if (claimFacts === undefined) return undefined;
  const moves = claimFacts?.moves ?? null;
  return { moves, now, agents: openRowsRead !== null && needsHolderAgents(openRowsRead, moves, now) ? readHolderAgents() : null };
}

/**
 * How many referenced items one tick reads that the open lists do not already hold. A BOUND ON THE API SPEND, NOT A TARGET: a wait cites a
 * few anchors, and the incident that filed #2996 had about ten. A reference past the bound is simply unread -- an unknown, never closed.
 */
export const MAX_WAIT_READS = 30;

const epochOrNull = (iso: unknown): number | null => {
  const at = Date.parse(String(iso ?? ""));
  return Number.isFinite(at) ? at : null;
};

/**
 * One item as `gh api repos/<r>/issues/<n>` states it, as a `RefFact`, or `null` for a state it does not know. `merged_at` is on a PULL
 * REQUEST's issue record only, and it is what tells a merge from a close.
 */
export function refFactOf(raw: any): import("../wait-condition.ts").RefFact | null {
  const labels = (raw?.labels ?? []).map((l: any) => String(l?.name ?? l));
  const changedAt = epochOrNull(raw?.updated_at);
  if (raw?.state === "open") return { state: "open", labels, resolvedAt: null, changedAt };
  if (raw?.state !== "closed") return null;
  return { state: raw.merged_at ? "merged" : "closed", labels, resolvedAt: epochOrNull(raw.merged_at) ?? epochOrNull(raw.closed_at), changedAt };
}

/** ONE REFERENCED ITEM'S STATE, or `null` when it could not be read: NEVER "closed" -- a refused read says nothing about the item. */
export function readWaitRef(ref: { repo: string | null; number: number; }, run: (args: string[]) => string = defaultRun) {
  try {
    return refFactOf(JSON.parse(run(["api", `repos/${ref.repo ?? repoNow()}/issues/${ref.number}`, "--jq",
      "{state, closed_at, updated_at, merged_at: .pull_request.merged_at, labels: [.labels[].name]}"])));
  } catch {
    return null;
  }
}

/**
 * WHAT THE WAITS' CONDITIONS REFER TO. An item in the open lists the tick already holds is read from them (open, with its labels); any other is
 * one `gh api` call, up to `MAX_WAIT_READS`. A reference neither held nor read is left OUT of the facts, which `conditionHolds` calls unknown.
 */
export function readWaitFacts({ items, open, run, limit = MAX_WAIT_READS }: { items: import("../wait-condition.ts").WaitItem[]; open: any[]; run: (args: string[]) => string; limit?: number; }): import("../wait-condition.ts").WaitFacts {
  return readRefFacts({ refs: referencesOf(items), open, run, limit });
}

/**
 * #2997: THE FACTS FOR A LIST OF REFERENCES, whoever named them -- a wait (#2996) or a ruling's check. The lookup is `readWaitFacts`'s own: the open lists first,
 * then one `gh api` call each up to `limit`; a reference neither held nor read is left OUT, which `conditionHolds` calls unknown.
 */
export function readRefFacts({ refs, open, run, limit = MAX_WAIT_READS }: { refs: { key: string; repo: string | null; number: number; }[]; open: any[]; run: (args: string[]) => string; limit?: number; }): import("../wait-condition.ts").WaitFacts {
  const known: Record<string, import("../wait-condition.ts").RefFact> = {};
  // An item of another repository is held under `owner/repo#n`, so `#148` of `agent-org` cannot answer for `#148` of the first repository (#3479).
  for (const raw of open) known[raw.repoKey && raw.repo ? `${raw.repo}#${Number(raw.number)}` : `#${Number(raw.number)}`] = { state: "open", labels: (raw.labels ?? []).map((l: any) => String(l?.name ?? l)),
    resolvedAt: null, changedAt: epochOrNull(raw.updatedAt) };
  const items_: Record<string, import("../wait-condition.ts").RefFact> = {};
  let spent = 0;
  for (const ref of refs) {
    const held = Object.hasOwn(known, ref.key) ? known[ref.key] : null;
    const fact = held ?? (spent++ < limit ? readWaitRef(ref, run) : null);
    if (fact) items_[ref.key] = fact;
  }
  return { items: items_ };
}

/**
 * #2996: EVERY WAIT THE OPEN ROWS AND PULL REQUESTS DECLARE, RE-READ AGAINST WHAT THEY WAIT FOR: the facts, the waits that stand although
 * their condition is true, the ones that name no reason, and the count that say `manual`. `null` when either list was refused.
 * #4005: THE RELEASE FACTS a wait names (a dist-tag, a tag) ARE READ HERE TOO, once each, and `umbrella` is the `ready` rows held by an edge onto a multi-done-when row that
 * names no condition. `readers` is the test's seam for the registry and the remote.
 */
export function waitTickFacts({ prsRead, openRowsRead, now, run = defaultRun, readers = { distTags: registryDistTags, tagExists: (tag) => remoteTagExists(tag, { run, repo: repoNow }) } }: {
        prsRead: any[] | null; openRowsRead: any[] | null; now: number; run?: (args: string[]) => string;
        readers?: import("./held-on-satisfied-orders.ts").ReleaseReaders;
    }) {
  if (prsRead === null || openRowsRead === null) return null;
  const items = [...prsRead.map((pr) => waitItemOf(pr, "pr")), ...openRowsRead.map((row) => waitItemOf(row, "row"))];
  const facts = { ...readWaitFacts({ items, open: [...prsRead, ...openRowsRead], run }), releases: readReleaseFacts({ items, readers }) };
  return { facts, stale: staleWaits({ items, facts, now }), bare: bareWaits({ items, now }), manual: manualWaits({ items, now }), umbrella: umbrellaEdges({ items }) };
}

/**
 * THE SETTER'S ORDER, one per stale wait (capped like every row order): the item, the condition that is now true, and the exact fields to
 * remove. IT IS THE `org-health` CAUSE, addressed to the setter and not to `ceo`: a cause of its own would be declared in
 * `cause-declaration.ts`, outside #2996's Region, and the profile (judgment, high) is the right one for an order to look and remove.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * chairman, 2026-10-02: a freeze ended at 06:50Z and the waits it caused stood four hours.
 */
export function staleWaitOrders(stale: import("../wait-condition.ts").StaleWait[]) {
  return stale.slice(0, MAX_ROW_ORDERS_PER_TICK).map(({ item, wait, setter, remove }) => {
    const discriminator = `${subjectRef(item.repoKey, item.number)}:${wait.key}`;
    return { session: setter, cause: "org-health", subject: `stale-wait-${subjectRef(item.repoKey, item.number)}`, discriminator,
      prompt: `A WAIT YOU SET HAS OUTLIVED ITS REASON. ${subjectMention(item)} declares \`Waiting-for: ${wait.text}\` and that condition is now TRUE, `
        + `so nothing is being waited for -- and the wait still stands. REMOVE: ${remove.join("; ")}. A wait whose reason is gone is a stall, not `
        + "proof of health. If the wait should stand for "
        + "a different reason, say so by writing the new `Waiting-for:` condition on it. Unanswered, `ceo` is told after 30 minutes.",
      causeKey: `${setter}/org-health/stale-wait-order@${discriminator}` };
  });
}

const PR_HOLD_ENTRY = fileURLToPath(new URL("../pr-hold.ts", import.meta.url));

/**
 * #3364: RELEASE ONE SESSION'S HOLD THROUGH THE MODULE THAT OWNS IT, `pr-hold.ts --release`, which removes the label AND re-arms a pull request that carried
 * `rearm-on-release` (a bare label removal leaves it unarmed: "Lifting a hold does not arm"). A child process rather than an import, because the module is a
 * CLI whose `main` runs on load. Exit `0` is DONE; `2` (released but the re-arm could not be proven) is NOT done, so the order still goes to a session.
 * #3479: `repoKey` AIMS IT at the pull request's repository, and the first repository's call is exactly what it was (no flag).
 * @returns whether the release reported done
 */
export function releaseHoldViaModule(number: number, session: string, repoKey?: string): boolean {
  const aim = repoKey ? [`--repo-key=${repoKey}`] : [];
  const result = spawnSync(process.execPath, [...TSX_IMPORT, PR_HOLD_ENTRY, String(number), `--session=${session}`, "--release", ...aim], { encoding: "utf8" });
  if (result.status !== 0) process.stderr.write(`COULD NOT lift hold:${session} on pr-${subjectRef(repoKey, number)} (exit ${result.status}): ${String(result.stderr).trim()}\n`);
  return result.status === 0;
}

/** #3479: the keys of the repositories the project declares for code, the first's empty key left out. */
const declaredRepoKeys = (): Set<string> => new Set(homeProjectDeclaration().code.map((entry) => entry.key).filter((key) => key !== ""));

/**
 * #3364: THE GATE LIFTS A HOLD WHOSE `Waiting-for: merged|closed` IS TRUE, instead of ordering a session to remove one label. Returns the stale waits that STILL
 * need a session: those `liftableHolds` leaves, and those whose release failed (so a failure falls back to today's order, as `performActions` does for a
 * refused `gh pr ready`, and says so on stderr). A lifted hold carries no label, so the next tick finds no stale wait for it.
 * #3479: a pull request of a repository the project declares is lifted too, released WITH its key; `declared` is the test's seam for which keys those are.
 */
export function liftResolvedHolds(stale: import("../wait-condition.ts").StaleWait[], { now, release = releaseHoldViaModule, log = (line) => process.stderr.write(line), declared = declaredRepoKeys() }: { now: number; release?: typeof releaseHoldViaModule; log?: (line: string) => void; declared?: ReadonlySet<string>; }): import("../wait-condition.ts").StaleWait[] {
  const { lifts, remaining } = liftableHolds(stale, now, declared);
  const failed = lifts.filter(({ item, holders }) => !holders.map((session) => release(item.number, session, item.repoKey)).every(Boolean));
  for (const { item, holders } of lifts.filter((l) => !failed.includes(l))) log(`DID lift-hold pr-${subjectRef(item.repoKey, item.number)} (${holders.join(", ")}) -- its Waiting-for is true; no session woken\n`);
  return [...remaining, ...failed.flatMap((l) => l.stale)];
}

/** #2996: THE GREEN PULL REQUESTS, counting a PR whose hold has stopped excusing as the mergeable PR it would be with the hold lifted. */
function greenCountWithLapsedHoldsLifted(prs: any[], required: string[] | null, holdStands: (pr: any) => boolean) {
  return shouldBeMerging(prs.map((pr) => (holdersOf(labelsOf(pr)).length > 0 && !holdStands(pr) ? withoutHold(pr) : pr)), required).length;
}

/**
 * #2997: THE RULINGS THE TICK RE-READS. Cheap first: no unresolved ruling means NO read at all, so a quiet record costs the tick nothing. A ruling's single-reference
 * checks are read through `readRefFacts` (the open lists, then `gh api`), its population checks from the two lists the tick already holds; a refused list is `null`, which
 * a check reads as unknown and never as a pass. The line posted on the ruling's issue is the tick's one write besides the record.
 */
export function rulingOrdersNow({ prsRead, openRowsRead, now }: { prsRead: any[] | null; openRowsRead: any[] | null; now: number; }, { stateDir = REVIEWER_STATE_DIR, run = defaultRun, log = (line) => process.stderr.write(`${line}\n`) }: { stateDir?: string; run?: (args: string[]) => string; log?: (line: string) => void; } = {}) {
  const record = readRulings(stateDir);
  if (record.status === "unreadable") { log(unreadableLine(stateDir)); return []; } // never "no rulings": a record that cannot be read abandons every ruling in it
  const pending = record.rulings.filter((r) => !r.resolved);
  if (pending.length === 0) return [];
  const refs = pending.flatMap((r) => r.checks.flatMap((text) => parseWaits(`Waiting-for: ${text}`)))
    .filter(isItemWait).map((w) => ({ key: w.key, repo: w.repo, number: w.number }));
  const facts = readRefFacts({ refs, open: [...(prsRead ?? []), ...(openRowsRead ?? [])], run });
  const world = { rows: openRowsRead && openRowsRead.map((row) => waitItemOf(row, "row")), prs: prsRead && prsRead.map((pr) => waitItemOf(pr, "pr")), facts };
  return rulingTick({ stateDir, world, now, log, comment: (issue, line) => { run(["issue", "comment", String(issue), "--body", line]); } });
}

/**
 * Every repository the tick reads pull requests for (#4047): the project's own, then each keyed code repository the declaration lists.
 * The org's work lands in all of them (a row's code merges in `agent-org`), so its last merge is the latest of them.
 */
const mergeRepositories = (): string[] => [repoNow(), ...scopesOf([homeProjectDeclaration()]).flatMap((scope) => (scope.key !== "" && scope.code !== null ? [scope.code.repo] : []))];

/** The facts a last-merge read becomes: a bare time (what a caller that names no repository hands back) or `{ at, repo }`. */
const lastMerge = (read: number | { at: number; repo: string; } | null): { lastMergedAt: number | null; lastMergedIn: string | null; } => (read !== null && typeof read === "object" ? { lastMergedAt: read.at, lastMergedIn: read.repo } : { lastMergedAt: read, lastMergedIn: null });

/**
 * #2936: THE ORG-HEALTH TICK over what `main` already holds. Reads ONE new thing, the last merge (`GH_READS`); every other fact is a
 * value the tick computed for `decide`: the PRs with their owners, `required`, the offered rows, the #2845 streaks and the primary's
 * drift. `prsRead`/`readyRead` are the RAW reads, `null` for a refusal, because `decideArgs` carries them coalesced to `[]` and
 * a refused read must reach the detector as an unknown. A refusal of the streak read is the counter's own stderr line
 * (`claim-refusals: could not run`), which `repeating-lines.ts` offers if it persists; it reaches here as no streaks.
 *
 * #2980: THE FLEET FACTS ARE PASSED, because `orgHealthReadings` reads an OMITTED `fleet` as "this caller does not ask" -- silent -- so
 * a gate that never passed them had the idle-fleet signal dead for as long as nobody noticed. `openRowsRead` is the raw read for the
 * same reason as `prsRead`. `io` is for the test: the clock, the last merge, the ledger and the log, so nothing here needs a token.
 * #3486: `claimedComments` IS THE CLAIMED ROWS' COMMENTS (`readClaimedRowComments`), `undefined` WHEN THE CALLER DOES NOT ASK, so the claimed rows are not clocked (see `overdueFacts`).
 * #3731: `held` IS THE ORDERS THE GATE WITHHELD THIS TICK FOR A RUNNER START (`holdForGithubIncident`'s `held`), and a pull request one of them names is NOT COUNTED as red: `decided` is
 * the list from BEFORE the hold, so without it the red the gate chose not to wake anyone for tripped `red-pr-unattended` two hours later, a second alarm for a failure the org had
 * decided not to act on. NOTHING IS RECORDED: the next tick with the incident gone holds nothing, so the same red counts again by itself. `undefined` is a caller with no hold.
 * #3448: `pools` IS THE API BUDGETS THIS TICK'S OWN READS NAMED (`readRowsOffBoard` leaves the GraphQL one); EMPTY IS A REFUSED READ AND THE SIGNAL SAYS IT WAS NOT READ, never clear.
 * #4189: `keyedPrsRead` IS THE OPEN PULL REQUESTS OF THE DECLARED REPOSITORIES BESIDE THE FIRST, tagged `repoKey`/`repo`, and it feeds THE WAIT READ ONLY: `prsRead` is the first repository's own list and every other
 * reading here (red, overdue, idle) is about it. Absent, a keyed pull request's hold is never read, so no `Waiting-for` of it is ever lifted or ordered.
 * #4295: `readMilestoneMoves` is the seam for THE EXACT START OF THE MILESTONE CLOCK, called only when the proxy trips it (`exactMilestoneClock`). IT IS THE REAL READ EXACTLY WHEN THE MERGE READ IS: a caller that
 * passes its own `lastMergedAt` reaches no remote (every test does), so it gets no exact read unless it passes one, and the gate's call site passes neither.
 * @param [io] `readBoardTruth` (#4045) is `undefined` WHEN THE CALLER DOES NOT ASK, which is every test; the gate's call site passes `boardTruthNow`, which reads the closed rows, the merged PRs and herdr (a fixed three calls a tick) and posts the day's table, so no test reaches a remote; `readReleaseRuns` (#4001) is `undefined` WHEN THE CALLER DOES NOT ASK, which is every test; the gate's call site passes the real one (ONE `gh api` call a tick, three while the newest release is a failure), so no test reaches a remote; `teamAccess` (#3634) is the team-level read, ONE `gh api` call per declared team each tick (the 2-minute tick is 30 calls an hour of a 5,000-an-hour core pool, 0.6% per team, the same price as `lastMergedAt`), and NO CALL AT ALL for a project that declares no `teamAccess`; a test that must reach no remote passes `() => undefined` `readToolAgreement` (#3533) is `undefined` WHEN THE CALLER DOES NOT ASK, which is every test
 *           and the gate's call site passes the real one, so no test reaches a remote; `readWaits` (#2996) is the test's seam for the
 *           referenced items, so nothing here needs a token; `release` (#3364) is its seam for the hold release, so nothing here runs `pr-hold.ts`
 */
export function orgHealthNow({ prsRead, keyedPrsRead = [], readyRead, openRowsRead, claimedComments, decideArgs, decided, held, pools }: { prsRead: any[] | null; keyedPrsRead?: any[]; readyRead: any[] | null; openRowsRead: any[] | null; claimedComments?: any[] | null; decideArgs: any; decided: any[]; held?: { subject: string; }[]; pools?: import("../org-health.ts").PoolReading[]; },
  io: {
      now?: number; lastMergedAt?: () => number | { at: number; repo: string; } | null; readCaptures?: (now: number) => ReturnType<typeof readFleetCaptures>;
      log?: (line: string) => void; readCopies?: () => null; readLabJobs?: () => string[] | null; readWaits?: typeof waitTickFacts;
      release?: typeof releaseHoldViaModule; readHolderAgents?: typeof readAgents; readToolAgreement?: typeof import("../org-health.ts").readToolAgreement; readNodeStrips?: typeof import("../node-strips-types.ts").readNodeStrips;
      readMilestoneMoves?: typeof readMilestoneMoves;
      readReleaseRuns?: () => import("../org-health.ts").ReleaseRuns | null | undefined;
      readReleaseBehind?: () => import("../release-behind-main.ts").RepoFact[] | null | undefined;
      readClassRepeat?: () => import("../class-repeat.ts").ClassRepeatFact | null | undefined;
      teamAccess?: () => import("../org-health.ts").TeamAccessFact | undefined;
      readBoardTruth?: (input: BoardTruthInput) => ReturnType<typeof boardTruthAudit> | null | undefined;
  } = {}) {
  const { now = Date.now(), lastMergedAt = () => readLatestMerge(defaultRun, mergeRepositories()), readCaptures = (at) => readFleetCaptures({ now: at }), log, readCopies,
    readLabJobs = dispatchedLabJobsOrSay, readWaits = waitTickFacts, release, readHolderAgents = readAgents, readToolAgreement = () => undefined, readNodeStrips = () => undefined, readReleaseRuns = () => undefined, readReleaseBehind = () => undefined, readClassRepeat = () => undefined,
    teamAccess = () => readTeamAccess(defaultRun), readBoardTruth = () => undefined,
    readMilestoneMoves: readMoves = io.lastMergedAt === undefined ? readMilestoneMoves : undefined } = io; // #4295: the real exact-start read exactly when the merge read is real
  const { prs, required, primaryDrift, claimRefusals, claimFacts } = decideArgs;
  // #2996: THE WAITS ARE READ BEFORE THE READINGS, because a hold's excuse is now a question about its condition. `null` is a refused
  // list: the hold then keeps its label-only excuse (the old behaviour) and the two wait readings say unknown.
  const waits = liftedWaits(readWaits({ prsRead: prsRead === null ? null : [...prsRead, ...keyedPrsRead], openRowsRead, now }), { now, release });
  const { holdStands, stale } = waitStanding(waits, now);
  const shelved = prsRead === null || readyRead === null ? null : shelvingListOf(decideArgs); // ONCE: `partitionUnclaimed` reads each ready row's Region from the tree
  const milestoneClock = openRowsRead === undefined ? undefined : milestoneClockFact({ openRowsRead, prsRead, keyedPrsRead, now, declaration: homeProjectDeclaration() });
  const facts = {
    now,
    ...lastMerge(lastMergedAt()),
    work: prsRead !== null && readyRead !== null ? workThatCouldLand(decideArgs, { holdStands, stale }) : null,
    redPrs: prsRead === null ? null : redPrFacts(withoutHeld(prs, held), decided, { holdStands }),
    overdue: overdueFacts({ prsRead, openRowsRead, claimedComments, required, now,
      holders: holdersForClock({ openRowsRead, claimFacts, now, readHolderAgents }) }),
    refusals: claimRefusals ?? null,
    drift: primaryDrift ?? null,
    primarySince: primaryStandingSince(primaryDrift ?? null, { root: REPO_CHECKOUT }),
    fleet: readCaptures(now),
    waiting: fleetWaitingFacts(openRowsRead, readLabJobs()),
    waits,
    ...(openRowsRead !== undefined && { stateRows: openRowsRead }), // #3942: the rows this tick already read, so the signal costs no call
    ...(openRowsRead !== undefined && { idle: idleFact({ openRowsRead, prsRead, readyRead, shelved, now }) }), // #3943: the same rows, and the gate's own shelving list
    ...(openRowsRead !== undefined && { shelvedCircle: shelvedCircleFact({ openRowsRead, prsRead, keyedPrsRead, shelved }) }), // #4401: the same rows, PRs and shelving list, and no call of its own
    ...(milestoneClock !== undefined && { milestoneClock }), // #4231: the same rows and PRs, and no call of its own
    ...(pools !== undefined && { pools: pools.length > 0 ? pools : null }),
    ...toolAgreementFact(readToolAgreement()),
    ...nodeStripsFact(readNodeStrips()), // #4390
    ...releaseRunsFact(readReleaseRuns()), // #4001
    ...releaseBehindFact(readReleaseBehind()), // #4128
    ...classRepeatFact(readClassRepeat()), // #4126
    ...teamAccessFact(teamAccess()),
    ...boardTruthFact({ openRowsRead, claimedComments, waitFacts: waits?.facts ?? null, now }, readBoardTruth), // #4045
  };
  const proxyReadings = orgHealthTick(facts, { ...(log && { log }), ...(readCopies && { readCopies }) });
  const readings = exactMilestoneClock({ orders: proxyReadings, fact: milestoneClock, now, merge: facts, readMoves, log });
  const { held: heldOnSatisfied, rest } = splitHeldOnSatisfied(stale);
  const cap = { limit: MAX_ROW_ORDERS_PER_TICK };
  return [...readings, ...staleWaitOrders(rest), ...heldOnSatisfiedOrders(heldOnSatisfied, cap), ...umbrellaEdgeOrders(waits?.umbrella ?? [], cap)];
}

const MS_PER_MINUTE = 60_000;
/** How many pages of 100 the exact-start read takes before it says it cannot see far enough (#4295). */
const MOVE_PAGES = 3;
const MOVE_PAGE_SIZE = 100;

/**
 * #4295: THE NEWEST-FIRST LIST OF `path`, PAGE BY PAGE, UNTIL IT REACHES BACK TO `since`. `jq` projects each item to `{ at, ... }` (epoch-able ISO `at`, the field the list is sorted on). Returns the items, or `null`
 * when a page was refused, unparseable, or the pages ran out before the list reached `since`: an item older than the window cannot matter, but one the pages never reached might, so that is UNKNOWN and not "nothing".
 */
function newestSince(run: (args: string[]) => string, { path, jq, since }: { path: string; jq: string; since: number; }): any[] | null {
  const items = [];
  for (let page = 1; page <= MOVE_PAGES; page++) {
    let rows;
    try {
      rows = JSON.parse(run(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=${MOVE_PAGE_SIZE}&page=${page}`, "--jq", jq]));
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    items.push(...rows);
    const oldest = rows.length === 0 ? NaN : Date.parse(rows[rows.length - 1].at);
    if (rows.length < MOVE_PAGE_SIZE || oldest <= since) return items;
  }
  return null;
}

/**
 * #4295: WHEN THE PRIMARY MILESTONE LAST HAD A CLAIM END, A ROW CLOSE OR A PULL REQUEST CLOSE, from GitHub's own event stream and no ledger of ours. Three reads, none of them on a healthy tick (`exactMilestoneClock`):
 * the tracker's issue events (a `closed` event of a milestone row, or an `unlabeled` of `session:*` or the claim label: a claim released with NO merge), and each declared repository's recently updated closed pull requests
 * (one that declares it closes an OPEN row of the milestone, merged or not: a PR closed unmerged leaves its row open, so no event of the row carries it). `at` is the latest of them inside the window, `null` when
 * nothing happened in it (the caller's start then stays the proxy); the whole answer is `null` when any read was refused or did not reach back to `since`, which is UNKNOWN and never a clear one.
 * @param input `since` is the earliest instant that could still matter: `now` minus the clock's bound
 */
export function readMilestoneMoves({ primary, openRows, since }: { primary: number; openRows: number[]; since: number; }, { run = defaultRun, tracker = repoNow(), repos = mergeRepositories() }: { run?: (args: string[]) => string; tracker?: string; repos?: string[]; } = {}): { at: number | null; } | null {
  const events = newestSince(run, { since, path: `repos/${tracker}/issues/events`,
    jq: "[.[] | {at: .created_at, event: .event, label: (.label.name // \"\"), milestone: (.issue.milestone.number // 0), pr: (.issue.pull_request != null)}]" });
  if (events === null) return null;
  const moves = events.filter((e) => !e.pr && e.milestone === primary
    && (e.event === "closed" || (e.event === "unlabeled" && (e.label.startsWith(SESSION_PREFIX) || e.label === CLAIM_LABEL)))).map((e) => Date.parse(e.at));
  const owned = new Set(openRows);
  for (const repo of repos) {
    const closed = newestSince(run, { since, path: `repos/${repo}/pulls?state=closed&sort=updated&direction=desc`,
      jq: "[.[] | {at: .updated_at, closedAt: .closed_at, body: (.body // \"\")}]" });
    if (closed === null) return null;
    for (const c of closed) if (declaredClosedRows(c.body, { prRepo: repo, trackerRepo: tracker }).some((n) => owned.has(n))) moves.push(Date.parse(c.closedAt));
  }
  const inWindow = moves.filter((at) => Number.isFinite(at) && at >= since);
  return { at: inWindow.length === 0 ? null : Math.max(...inWindow) };
}

/** #4295: THE `ALSO TRIPPED` LINE `orgHealthOrders` ends a prompt with, read and rewritten here because the exact start can change whether the milestone clock is among them. */
const ALSO_TRIPPED = /\nALSO TRIPPED \(\d+\): ([^\n]*)\.$/;
const alsoTrippedOf = (prompt: string) => ALSO_TRIPPED.exec(prompt)?.[1].split(", ") ?? [];
const withAlsoTripped = (prompt: string, signals: string[]) =>
  prompt.replace(ALSO_TRIPPED, "") + (signals.length === 0 ? "" : `\nALSO TRIPPED (${signals.length}): ${signals.join(", ")}.`);

/**
 * #4295: THE MILESTONE CLOCK STARTS AT THE REAL LAST MOVE, not at the last merge. The tick's proxy (`lastMergedAt`) is later than the milestone's own last claim or pull request ending whenever
 * anything else merged, and EARLIER than it when a claim was released or a pull request closed with no merge: it then trips an idle milestone that moved 30 minutes ago. So when the proxy has
 * ALREADY tripped (the only path that would alarm) ONE conditional read (`readMilestoneMoves`) takes the later of the proxy and the milestone's latest move and the reading is made again.
 * A HEALTHY TICK MAKES NO EXTRA CALL: a clear or unknown proxy reading returns the orders untouched. A refused or too-short read is UNKNOWN (said on `log`, no order), never clear.
 */
function exactMilestoneClock({ orders, fact, now, merge, readMoves, log = (line) => process.stderr.write(line) }: {
        orders: ReturnType<typeof orgHealthOrders>; fact: ReturnType<typeof milestoneClockFact> | undefined; now: number; merge: { lastMergedAt: number | null; };
        readMoves: typeof readMilestoneMoves | undefined; log?: (line: string) => void;
    }) {
  const signal = SIGNALS.MILESTONE_CLOCK;
  const proxied = orders.filter((order) => order.subject === signal);
  if (readMoves === undefined || proxied.length === 0 || !fact || merge.lastMergedAt === null) return orders;
  let moves = null;
  try {
    moves = readMoves({ primary: fact.primaries[0].number, openRows: fact.rows.map((r) => r.number), since: now - MILESTONE_CLOCK_MINUTES * MS_PER_MINUTE });
  } catch { /* an unreadable result is UNKNOWN, said below */ }
  const reading = moves === null ? null : milestoneClockReading({ now, fact: { ...fact, endedAt: Math.max(merge.lastMergedAt, moves.at ?? 0) } });
  if (reading === null) log(`org-health: ${signal} UNKNOWN -- the milestone's own last claim, row and pull request moves could not be read, so the proxy's start (the last merge) is not trusted; it is not read as clear.\n`);
  else if (reading.status === "unknown") log(`org-health: ${signal} UNKNOWN -- ${reading.detail}; it is not read as clear.\n`);
  const renewed = reading?.status === "tripped" ? orgHealthOrders([reading]) : [];
  const also = alsoTrippedOf(proxied[0].prompt);
  return orders.flatMap((order) => {
    if (order.subject !== signal) return renewed.length > 0 ? [order] : [{ ...order, prompt: withAlsoTripped(order.prompt, alsoTrippedOf(order.prompt).filter((s) => s !== signal)) }];
    return order === proxied[0] ? renewed.map((o) => ({ ...o, prompt: withAlsoTripped(o.prompt, also) })) : [];
  });
}

export type BoardTruthInput = { openRowsRead: any[], claimedComments?: any[] | null, waitFacts: import("../wait-condition.ts").WaitFacts | null, now: number };

/**
 * #4045: THE `boardTruth` FACT, from the rows the tick already read. OMITTED when the caller passes no open rows (it does not ask), `null` when the open-row read was
 * refused (unknown, never "nothing disagrees"), else the audit `read` makes.
 */
export function boardTruthFact({ openRowsRead, ...rest }: Omit<BoardTruthInput, "openRowsRead"> & { openRowsRead: any[] | null | undefined; }, read: (input: BoardTruthInput) => ReturnType<typeof boardTruthAudit> | null | undefined): { boardTruth?: ReturnType<typeof boardTruthAudit> | null; } {
  if (openRowsRead === undefined) return {};
  const audit = openRowsRead === null ? null : read({ openRowsRead, ...rest });
  return audit === undefined ? {} : { boardTruth: audit };
}

/**
 * #4045: THE OPEN ROWS AS THE AUDIT READS THEM: the tick's list has no `state` and no `comments`, and `claimedComments` (`readClaimedRowComments`) holds the comments of the
 * claimed rows only. `liveSessions` is read only when every claimed row has its comments: a claimed row without them would read as "no claim record", so a refused or
 * capped page would call a live claim dead.
 */
export function boardRowsOf(openRowsRead: any[], claimedComments: any[] | null | undefined): { openRows: any[]; commentsComplete: boolean; } {
  const byNumber = new Map((claimedComments ?? []).map((r) => [r.number, r.comments]));
  const openRows = openRowsRead.map((row) => ({ ...row, state: "OPEN", comments: byNumber.get(row.number) ?? [] }));
  const claimed = openRows.filter((row) => row.labels.some((l: { name: string; }) => (l.name ?? l) === CLAIM_LABEL));
  return { openRows, commentsComplete: claimed.every((row) => byNumber.has(row.number)) };
}

/**
 * #4250: THE FLAG SENDS THE ORDER. A handoff written as a sentence (`handoff-in-prose`) or a reading with no `Defect-row:` line moves nobody from a table read once a day, so each finding's
 * row gets `answer:<route>` (`proseAudit` raises exactly those two questions; the session the comment's first words name, else the row's owner), ONCE per row and route however many comments name it. This wraps `readProseFacts` because
 * `postDaysTable` calls it exactly once per edition day, after its ask finds the table absent: a second tick that finds the table posted reads no comments and labels nothing. THE LABEL GOES
 * BEFORE THE TABLE and `POST /issues/{n}/labels` is idempotent (and creates a label that does not exist yet, which `--add-label` refuses), so a table that fails to post is retried
 * without a second label. An unreadable comment list is `null` and labels nothing, as it posts no table. One label that is refused is said on `log` and the rest still go.
 */
function readProseAndOrder({ repo, log }: { repo: string; log: (line: string) => void; }): typeof readProseFacts {
  return (input) => {
    const prose = readProseFacts(input);
    if (prose === null) return null;
    const audited = proseAudit(prose);
    const owed = new Map(audited.findings.map((f) => [`${f.number} ${f.route}`, f]));
    for (const { number, route } of owed.values()) {
      try {
        input.run(["api", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${ANSWER_PREFIX}${route}`]);
      } catch (error) {
        log(`board-truth: ${ANSWER_PREFIX}${route} was not added to #${number} (${error instanceof Error ? error.message.split("\n")[0] : error})`);
      }
    }
    return prose;
  };
}

/**
 * #4045: READ THE BOARD AGAINST REALITY AND POST THE DAY'S TABLE: the gate's `readBoardTruth`. The closed rows, the merged PRs and the herdr listing are read here (each a
 * refused read is `null`, unread); everything else is the tick's. THE POST IS BEST EFFORT AND NEVER STOPS THE TICK: a failure is said on stderr (the next tick asks again,
 * since the record is the state) and the audit is returned all the same, because the signal does not depend on the post.
 */
export function boardTruthNow({ openRowsRead, claimedComments, waitFacts, now }: BoardTruthInput, { repo = repoNow(), run = defaultRun, agents = readAgents, post = postDaysTable, log = (line) => process.stderr.write(`${line}\n`) }: { repo?: string; run?: (args: string[]) => string; agents?: typeof readAgents; post?: typeof postDaysTable; log?: (line: string) => void; } = {}) {
  const { openRows, commentsComplete } = boardRowsOf(openRowsRead, claimedComments);
  const read = readBoardFacts(repo, { run, agents, now, openRows, waitFacts });
  const audit = boardTruthAudit(commentsComplete ? read : { ...read, liveSessions: null });
  try {
    post({ audit, day: editionDay(new Date(now)), repo, run, now, readProse: readProseAndOrder({ repo, log }) });
  } catch (error) {
    log(`board-truth: the day's table was not posted (${error instanceof Error ? error.message.split("\n")[0] : error}); the next tick asks again`);
  }
  return audit;
}

/**
 * #3943: THE ENGINEER SEATS: the standing roles `sessions.json` marks `engineer` and every spawned `worker-<n>` a row names (a spawned seat exists only while it
 * holds one, so the rows are where it is read from). `null` is a roster that could not be read, which is unknown and never "no engineer".
 */
export function engineerSeats(openRows: any[], path: string = roleBriefPath("sessions.json").absolute): string[] | null {
  try {
    const { live } = JSON.parse(readFileSync(path, "utf8"));
    const standing = live.filter((s: any) => s.role === "engineer" && s.family === undefined).map((s: any) => s.name);
    const spawned = openRows.flatMap((row) => labelsOf(row).filter((l) => l.startsWith(SESSION_PREFIX)).map((l) => l.slice(SESSION_PREFIX.length)))
      .filter((name) => familyNumber(name) !== null);
    return [...new Set([...standing, ...spawned])];
  } catch {
    return null;
  }
}

/**
 * The gate's own B4 / branch shelving list, `number -> reason`: what `partitionUnclaimed` withholds from the ready rows this tick. Read once per tick and shared by the idle reading (#3943) and the circle reading (#4401).
 */
function shelvingListOf({ readyRows, prFiles, rowBranches, openRows }: { readyRows: any[]; prFiles: any[]; rowBranches: any; openRows: any; }): Map<number, string> {
  return new Map(partitionUnclaimed(readyRows, prFiles, { rowBranches, openRows }).blocked.map((b) => [b.number, b.reason]));
}

/**
 * #3943: THE IDLE READING over the rows and the gate's own offer, both already in hand. A tick whose pull-request or Ready read was refused cannot say which
 * rows the gate shelves, so it says UNREAD (`shelved` is `null`): every ready row would otherwise read as `READY_UNOFFERED`, a false defect.
 */
function idleFact({ openRowsRead, prsRead, readyRead, shelved, now }: { openRowsRead: any[] | null; prsRead: any[] | null; readyRead: any[] | null; shelved: Map<number, string> | null; now: number; }) {
  if (openRowsRead === null) return idleWithOpenRowsReading({ now, engineers: null, openRows: null });
  if (prsRead === null || readyRead === null || shelved === null) return { kind: "unread" as const, why: "the gate's own offer could not be read, so which ready rows it withholds is not known" };
  return idleWithOpenRowsReading({ now, engineers: engineerSeats(openRowsRead), openRows: openRowsRead, shelved });
}

/**
 * #4401: THE CIRCLE READING over the same shelving list, the open pull requests of every declared repository (`keyedPrsRead` is the others', tagged `repo`) and the open rows. `null` is a refused read of any of them: unknown, never clear.
 * A keyed pull request carries no check rollup here, so it is read as red only if it is held or parked too.
 */
function shelvedCircleFact({ openRowsRead, prsRead, keyedPrsRead, shelved }: { openRowsRead: any[] | null; prsRead: any[] | null; keyedPrsRead: any[]; shelved: Map<number, string> | null; }) {
  if (openRowsRead === null || prsRead === null || shelved === null) return null;
  return shelvedCircles({ shelved, prs: [...prsRead, ...keyedPrsRead], rows: openRowsRead });
}

/**
 * #4231: WHAT AN IDLE REASON IS CALLED IN THE MILESTONE ALARM, and who owes the row's next move when the reason alone says. A `lane:<owner>` label outranks both (`ceo`'s epic is `ceo`'s),
 * and an answer owed names its session. Every reason this table lacks is printed as `IDLE_REASONS` spells it, and owed by `product-manager`, the first reader for rows.
 */
const CLOCK_STATE: Readonly<Record<string, string>> = Object.freeze({ [IDLE_REASONS.READY_UNOFFERED]: "ready, unclaimed", [IDLE_REASONS.SHELVED]: "ready, shelved by the gate" });
const CLOCK_OWES: Readonly<Record<string, (suffix: string) => string>> = Object.freeze({
  [IDLE_REASONS.BLOCKED_BY]: (suffix) => `the owner of ${suffix}, the blocking row`,
  [IDLE_REASONS.ANSWER_OWED]: (suffix) => suffix,
  [IDLE_REASONS.WAITING_FOR]: () => "the session that set the wait",
});

/**
 * #4231: ONE OPEN ROW OF THE PRIMARY MILESTONE AS THE CLOCK READS IT. Claimed is `session:*` OR a bare `in-progress`: an unnamed holder is not proof of an idle milestone (`idle-with-open-rows` reads
 * it the same way). The state is `idleWithOpenRowsReading`'s own, asked of this one row with no engineer roster: a row's reason for not being built is decided once, there.
 */
function clockRowOf(row: any, now: number): import("../org-health.ts").ClockRow {
  return { ...clockRowState(row, now), epic: labelsOf(row).includes("epic") }; // the epic flag is for the NAMING (`milestoneClockReading` skips epics), not for the state
}

function clockRowState(row: any, now: number): Omit<import("../org-health.ts").ClockRow, "epic"> {
  const labels = labelsOf(row);
  const createdAt = epochOrNull(row.createdAt);
  const claimed = labels.some((l) => l.startsWith(SESSION_PREFIX)) || labels.includes(CLAIM_LABEL);
  if (claimed) return { number: row.number, createdAt, claimed, state: "claimed", owes: "its claimant" };
  const idle = idleWithOpenRowsReading({ now, engineers: [], openRows: [row] });
  const lane = labels.filter((l) => l.startsWith(LANE_PREFIX)).map((l) => l.slice(LANE_PREFIX.length)).find((owner) => owner !== "any");
  const finding = idle?.kind === "idle" ? idle.findings[0] : undefined;
  if (finding === undefined) {
    const date = notBeforeDate(row.body);
    return { number: row.number, createdAt, claimed, state: date === null ? "date-held" : `date-held until ${date}`, owes: lane ?? "product-manager, who decides whether another row can start meanwhile" };
  }
  const suffix = finding.reason.slice(finding.kind.length);
  const state = `${CLOCK_STATE[finding.kind] ?? finding.kind.toLowerCase().replace(/_/g, " ")}${CLOCK_STATE[finding.kind] === undefined ? suffix : ""}`;
  return { number: row.number, createdAt, claimed, state, owes: lane ?? CLOCK_OWES[finding.kind]?.(suffix.trim()) ?? "product-manager" };
}

/**
 * #4378: WHETHER THE PROJECT HAS SAID WHICH OF ITS REPOSITORIES REACH AN ADOPTER. The primary-milestone rule below is dormant until a `dora` entry names `adopterFacing` (either value): a project that has
 * declared nothing is read exactly as before, because without the key #3820's `rowKind` is the only fact and it calls a docs-only Region org, which would take a real row out of the count.
 */
export const adopterFacingDeclared = (declaration: { dora: { repo: string; releasablePaths: string[]; adopterFacing?: boolean; }[]; }): boolean => declaration.dora.some((entry) => entry.adopterFacing !== undefined);

/**
 * #4378: WHY A REGION ENTRY IS NOT ADOPTER-FACING, in the words a filer can act on: the entry, and either the `adopterFacing: false` repository it lies under, the tool itself, or the plain absence of
 * a releasable path. The `adopterFacing: false` reading wins over the others because it is the one #3820's `rowKind` alone would have called product.
 */
function orgEntryReason(entry: string, declaration: { code: { key: string; repo: string; }[]; dora: { repo: string; releasablePaths: string[]; adopterFacing?: boolean; }[]; }): string {
  const { key, path } = splitRegionEntry(entry);
  const repo = declaration.code.find((code) => code.key === key)?.repo;
  const dora = declaration.dora.find((candidate) => candidate.repo === repo);
  if (dora?.adopterFacing === false && dora.releasablePaths.some((releasable) => regionCovers(releasable, path))) {
    return `\`${entry}\` lies under a releasable path of ${repo}, which is declared \`adopterFacing: false\` in the project declaration`;
  }
  if (repo === ORG_TRACKER_REPO) return `\`${entry}\` is in ${repo}, the tool itself, which is released but is not what the project ships`;
  return `\`${entry}\` lies under no releasable path of an adopter-facing repository`;
}

/**
 * #4378: IS THIS ROW ADOPTER-FACING -- #3820's `rowKind`, said back as `adopter` or `org` with the entry that made it org. `unreadable` is
 * `rowKind`'s own word for a Region it found no entries in: such a row is `org` here and the CALLER decides what that means (`row-file` refuses it, the clock counts it unknown). WHICH repositories are
 * adopter-facing is decided in ONE place, `productRegionsOf`, which the #3820 product share reads too (#4399), so the two cannot disagree.
 * @param entries what `declaredRegionFiles` read
 */
export function adopterRowKind(entries: string[] | null, declaration: { code: { key: string; repo: string; }[]; dora: { repo: string; releasablePaths: string[]; adopterFacing?: boolean; }[]; }): { kind: "adopter" | "org"; unreadable: boolean; because: string | null; } {
  const { kind, unreadable } = rowKind(entries, productRegionsOf(declaration));
  if (kind === "product") return { kind: "adopter", unreadable, because: null };
  if (unreadable) return { kind: "org", unreadable, because: "its Region names no path, so it cannot be read as adopter-facing" };
  const reasons = (entries ?? []).map((entry) => orgEntryReason(entry, declaration));
  return { kind: "org", unreadable, because: reasons.find((reason) => reason.includes("adopterFacing: false")) ?? reasons[0] };
}

/**
 * #4378: ONE OPEN ROW OF THE PRIMARY MILESTONE AS THE CLOCK COUNTS IT -- `[]` for a row that reads as org (it neither holds the alarm quiet nor makes it fire), the row for an adopter-facing one, and for a row
 * whose Region cannot be read a row with NO creation time, which is how `milestoneClockReading` already says unknown: it is never counted as product. An `epic` is the milestone's own container and carries no Region, so
 * it is not classified. Dormant (`declaration` omitted, or no `adopterFacing` declared) it is the row as before.
 */
function countedClockRows(row: any, now: number, declaration: Parameters<typeof adopterRowKind>[1] | undefined): import("../org-health.ts").ClockRow[] {
  const counted = clockRowOf(row, now);
  if (declaration === undefined || !adopterFacingDeclared(declaration) || counted.epic) return [counted];
  const { kind, unreadable } = adopterRowKind(declaredRegionFiles(String(row.body ?? "")), declaration);
  if (kind === "adopter") return [counted];
  return unreadable ? [{ ...counted, createdAt: null, state: "Region unreadable, so not known to be adopter-facing" }] : [];
}

/**
 * #4231: THE PRIMARY MILESTONE'S CLOCK FACT, from the open rows and pull requests the tick already read. THE MILESTONE IS DATA: the one whose description carries the `Primary: yes` line, found through
 * the `milestone` field of the open-row read, so a milestone with no open row is not seen here and reads as "no open row belongs to a primary milestone". A refused open-row read is `null` (unknown),
 * a refused pull-request list is `prsClose: null`. A pull request counts for the rows it DECLARES it closes (`Closes #n`, the merge-blocking field, read by the one reader the claim uses), in the
 * repository whose rows they are: the keyed code repositories' pull requests count too, since a row of this tracker is built in `agent-org`.
 * It carries no `endedAt`: `orgHealthReadings` fills it from the last merge the tick read (`lastMergedAt`), which is ONE PROXY FOR TWO EVENTS and not the milestone's own: it is later than the
 * milestone's last claim or pull request ending whenever anything else merged since, so it errs SILENT, never loud. It stays out of this call so the tick's merge read keeps ONE caller (#4047).
 * #4378: ONLY ADOPTER-FACING ROWS ARE COUNTED when `declaration` says which repositories are (`countedClockRows`); omitted, or declaring none, every open row of the milestone is counted as before.
 */
export function milestoneClockFact({ openRowsRead, prsRead, keyedPrsRead = [], now, declaration }: { openRowsRead: any[] | null; prsRead: any[] | null; keyedPrsRead?: any[]; now: number; declaration?: Parameters<typeof adopterRowKind>[1]; }): Omit<import("../org-health.ts").MilestoneClockFact, "endedAt"> | null {
  if (openRowsRead === null) return null;
  const marked = new Map(openRowsRead.map((row) => row.milestone).filter((m) => m && PRIMARY_MILESTONE_LINE.test(String(m.description ?? ""))).map((m) => [Number(m.number), String(m.title ?? "")]));
  const primaries = [...marked].map(([number, title]) => ({ number, title }));
  const rows = primaries.length === 1 ? openRowsRead.filter((row) => Number(row.milestone?.number) === primaries[0].number).flatMap((row) => countedClockRows(row, now, declaration)) : [];
  const closing = (pr: any) => declaredClosedRows(pr.body, { prRepo: pr.repo ?? repoNow() });
  return { primaries, rows, prsClose: prsRead === null ? null : [...prsRead, ...keyedPrsRead].flatMap(closing) };
}

/** #3731: THE PULL REQUESTS THE GATE IS NOT WAKING ANYONE FOR. A held order names its pull request by the subject `redPrFacts` also keys on, so the one spelling excludes it. */
function withoutHeld(prs: any[], held: { subject: string; }[] | undefined) {
  if (held === undefined || held.length === 0) return prs;
  const subjects = new Set(held.map((h) => h.subject));
  return prs.filter((pr) => !subjects.has(`pr-${subjectRef(pr.repoKey, pr.number)}`));
}

/** #3533: THE FACT, OR NOTHING. `undefined` is a caller that does not ask (and a host that declares no tool): the key is then left out, and `orgHealthReadings` reads an omitted one as silent. */
const toolAgreementFact = (read: ReturnType<typeof import("../org-health.ts").readToolAgreement>): { toolAgreement?: { now: number; result: any; } | null; } => (read === undefined ? {} : { toolAgreement: read });

/** #4390: THE FACT, OR NOTHING: `undefined` is a caller that does not ask, silent, and `null` a refused read, which the signal says is unknown. */
const nodeStripsFact = (read: import("../node-strips-types.ts").NodeStripFact | null | undefined) => (read === undefined ? {} : { nodeStrips: read });

/** #4001: THE FACT, OR NOTHING: `undefined` is a caller that does not ask, silent, and `null` a refused read, which the signal says is unknown. */
const releaseRunsFact = (read: import("../org-health.ts").ReleaseRuns | null | undefined) => (read === undefined ? {} : { releaseRuns: read });

/** #4128: THE FACT, OR NOTHING: `undefined` is a caller that does not ask, silent, and `null` a refused listing of the repositories, which the signal says is unknown. */
const releaseBehindFact = (read: import("../release-behind-main.ts").RepoFact[] | null | undefined) => (read === undefined ? {} : { releaseBehind: read });

/** #4126: THE FACT, OR NOTHING: `undefined` is a caller that does not ask, silent, and `null` or `{ unreadable }` a refused read, which the signal says is unknown. */
const classRepeatFact = (read: import("../class-repeat.ts").ClassRepeatFact | null | undefined) => (read === undefined ? {} : { classRepeat: read });

/** #3634: THE FACT, OR NOTHING, as `toolAgreementFact`: `undefined` is a project that declares no `teamAccess`, so the reading is silent. */
const teamAccessFact = (read: import("../org-health.ts").TeamAccessFact | undefined) => (read === undefined ? {} : { teamAccess: read });

/** #3364: THE WAIT READ AFTER THE GATE HAS LIFTED WHAT IT CAN, so the readings and the orders see only the stale waits a session still owes. `null` stays `null`. */
function liftedWaits(waits: ReturnType<typeof waitTickFacts>, { now, release }: { now: number; release?: typeof releaseHoldViaModule; }) {
  return waits === null ? null : { ...waits, stale: liftResolvedHolds(waits.stale, { now, release }) };
}

/**
 * WHAT THE TICK'S WAIT READ SAYS TO THE REST OF IT: whether a hold still excuses (`undefined` when the read was refused, which leaves the label's own excuse
 * as it was) and the waits that stand although their condition is true.
 */
function waitStanding(waits: ReturnType<typeof waitTickFacts>, now: number) {
  if (waits === null) return { holdStands: undefined, stale: [] };
  return { holdStands: (pr: any) => holdExcused(pr, { facts: waits.facts, now }), stale: waits.stale };
}

/**
 * WHAT COULD LAND, for `no-merge-while-work-exists`: the green PRs (a PR whose hold has stopped excusing counts as the mergeable one it would be with the hold
 * lifted, #2996) and the claimable Ready rows (a Ready row whose wait is stale counts as one the wait is hiding).
 */
function workThatCouldLand({ prs, required, readyRows, prFiles, rowBranches, openRows }: any, { holdStands, stale }: { holdStands?: (pr: any) => boolean; stale: import("../wait-condition.ts").StaleWait[]; }): { greenPrs: number; claimableRows: number; } {
  const staleReadyRows = stale.filter((s) => s.item.kind === "row" && s.item.labels.includes(READY_LABEL)).length;
  return {
    greenPrs: holdStands ? greenCountWithLapsedHoldsLifted(prs, required, holdStands) : shouldBeMerging(prs, required).length,
    claimableRows: partitionUnclaimed(readyRows, prFiles, { rowBranches, openRows }).offerable.length + staleReadyRows,
  };
}
