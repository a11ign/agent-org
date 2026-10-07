// @ts-check
// module: the org-health facts and orders -- what the tick reads and says about whether the org is landing work (#2898)
//
// MOVED OUT OF `work-gate.mjs`, NOT REWRITTEN (#2898, the second split of #928's lever 2a, after #2542): the readings
// `orgHealthNow` hands to `org-health.mjs` (red pull requests, the fleet's captures, the wait facts and the rulings
// the tick re-reads) and the orders built from them. Measured on #2898 over the pairs of pull requests that waited
// on B4: six rows waited behind fixes to exactly these definitions and nothing else in the file.
//
// THE BOUNDARY, as `work-gate/pr-orders.mjs` states it: what only this family uses lives here, and what a family
// that stayed behind also uses (`readPrs`, `shouldBeMerging`, `partitionUnclaimed`, `holdExcused`'s callers) stays in
// `work-gate.mjs` and is IMPORTED from it. That import is a cycle with the entry point, safe only while nothing
// here reads an imported binding at load time; the one top-level `const` here (`MAX_WAIT_READS`) is a literal.
// `redPrFacts` STAYED in `work-gate.mjs`: it is the one place the gate asks `red-pr.mjs`'s `isBrokenRed`, and
// `org-health.test.ts`'s #2956 guard accepts a file that reads the rollup only if it imports that decider, so the
// import and its one caller stay together. `work-gate.mjs` re-exports every name this file exports that it exported before.
import { REPO_CHECKOUT, HOUR_MS, fleetBatchRows, defaultRun, repoNow, MAX_ROW_ORDERS_PER_TICK,
  shouldBeMerging, labelsOf, sessionOf, REVIEWER_STATE_DIR, dispatchedLabJobsOrSay, redPrFacts, partitionUnclaimed, openBlockers } from "../work-gate.mjs";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.mjs";
import { claimRecordOf } from "../claim-stall.mjs";
import { idleClaimantReading } from "../idle-claimant.mjs";
import { familyNumber } from "../arm-pr.mjs";
import { readAgents } from "../herdr-agents.mjs";
import { idleWithOpenRowsReading } from "../idle-with-open-rows.mjs";
import { roleBriefPath } from "../project-roles.mjs";
import { waitingOn, fleetWaitingOn, notBeforeDate, todayIso } from "../waiting-condition.mjs";
import { NEEDS_CHAIRMAN_LABEL, SESSION_PREFIX } from "../project-vocabulary.mjs";
import { FLEET_IDLE_HOURS, readLastMergedAt, orgHealthTick,
  primaryStandingSince, readTeamAccess } from "../org-health.mjs";
import { holdersOf, holdExcused } from "../pr-hold-state.mjs";
import { withoutHold } from "../red-pr.mjs";
import { subjectRef, subjectMention } from "../review-attribution.mjs";
import { readRulings, unreadableLine, rulingTick } from "../ruling-record.mjs";
import { homeProjectDeclaration } from "../project-config.mjs";
import { readReleaseFacts, registryDistTags, remoteTagExists, splitHeldOnSatisfied, heldOnSatisfiedOrders, umbrellaEdges, umbrellaEdgeOrders } from "./held-on-satisfied-orders.mjs";
import { referencesOf, releaseReferencesOf, waitItemOf, staleWaits, bareWaits, manualWaits, parseWaits, liftableHolds, isItemWait } from "../wait-condition.mjs";
import { stallReasonOf, ownerOfPr } from "./pr-orders.mjs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Where the fleet watch writes the capture ledger (#2979), under the project checkout: `packages/control/src/fleet-watch.mjs`'s `DEFAULT_CAPTURES_STATE_PATH`. */
export const FLEET_CAPTURES_LEDGER = "runs/fleet-captures-state.json";

/** @param {any} worker */
const isLedgerWorker = (worker) => Boolean(worker) && Array.isArray(worker.rises)
  && (worker.lastRoseAt === null || Number.isFinite(worker.lastRoseAt))
  && worker.rises.every((/** @type {any} */ rise) => Boolean(rise) && Number.isFinite(rise.at) && Number.isFinite(rise.by));

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
 * the first day does not log an UNKNOWN every tick for `repeating-lines.mjs` to offer at 30 ticks (`copiesToCompare`'s reason). A capture
 * inside a young ledger is still a capture.
 * @param {{ now: number, path?: string, read?: (path: string, encoding: "utf8") => string }} io
 * @returns {{ captures24h: number, lastCaptureAt: number | null } | null | undefined}
 */
export function readFleetCaptures({ now, path = join(REPO_CHECKOUT, FLEET_CAPTURES_LEDGER), read = readFileSync }) {
  try {
    const ledger = JSON.parse(read(path, "utf8"));
    const workers = ledger?.workers;
    if (!Number.isFinite(ledger?.since) || !workers || typeof workers !== "object" || Array.isArray(workers)
      || !Object.values(workers).every(isLedgerWorker)) return null;
    const windowMs = FLEET_IDLE_HOURS * HOUR_MS;
    const all = /** @type {any[]} */ (Object.values(workers));
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
 * @param {any[] | null} openRows
 * @param {string[] | null} [labJobs]
 * @returns {{ rows: number[], labJobs: string[] } | null}
 */
export function fleetWaitingFacts(openRows, labJobs = []) {
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
 * @param {any[]} prs @param {string[] | null} required @param {{ now: number }} io
 * @returns {import("../org-health.mjs").OverdueCandidate[]}
 */
export function stalledPrFacts(prs, required, { now }) {
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
 * @typedef {import("./claim-stall-tick.mjs").ClaimMoves} ClaimMoves
 * @typedef {{ moves: Map<number, ClaimMoves> | null, agents: {label: string, status: string}[] | null, now: number }} Holders
 * `moves` is the claim-stall tick's reading of every claimed row (`ClaimFactsOfTick.moves`; `null` when that tick evaluated none), `agents` herdr's own
 * workspace listing (`null` when herdr could not be asked).
 */

/**
 * The wait kinds a claimed row DECLARES as fields, which `idleClaimantReading` counts: `claim-stall-tick.mjs`'s `declaredWaitOf` plus its open `blockedBy`
 * edges, restated because that function is not exported and the file is not this row's Region. `answer:<the holder>` is not the holder's wait.
 * THE TICK'S `now` DECIDES WHETHER A `Not-before:` HOLDS, never the wall clock (`waitingOn` defaults to it), or a clock handed a time reads another day's wait.
 * @param {any} row @param {string | null} holder @param {number} now @returns {string[]}
 */
function waitKindsOf(row, holder, now) {
  const today = todayIso(new Date(now));
  const waiting = waitingOn({ ...row, blockedBy: { nodes: [] } }, today, now) ?? fleetWaitingOn(row, today, now);
  const kind = waiting === null || (waiting.kind === "answer" && waiting.session === holder) ? [] : [waiting.kind === "date" ? "not-before" : waiting.kind];
  return [...kind, ...(labelsOf(row).includes(NEEDS_CHAIRMAN_LABEL) ? ["chairman"] : []), ...(openBlockers(row).length > 0 ? ["blocked-by"] : [])];
}

/**
 * The moves of a claimed row that is IN QUESTION for the idle shapes: read, not merged and untouched for `OVERDUE_IDLE_CLAIM_MINUTES`. A row owning a pull
 * request IS in question since #3569 (it used to be `pr-owned` and so never read): the holder's wait on that pull request is a fact `idleClaimantReading`
 * can read, and a holder idle on one with none is the stall. `null` for any row outside that, so neither the herdr listing nor a reading is spent on it.
 * @param {number} number @param {Holders} holders @returns {{ moves: ClaimMoves, lastMove: number } | null}
 */
function untouchedMoves(number, holders) {
  const moves = holders.moves?.get(Number(number));
  if (moves === undefined || moves.mergedAt !== null) return null;
  const lastMove = Math.max(...[moves.claimedAt, moves.comment, moves.commit, moves.push].filter((at) => at !== null));
  return holders.now - lastMove >= IDLE_CLAIM_MS ? { moves, lastMove } : null;
}

/**
 * WHY AN IDLE HOLDER WITH NO READABLE WAIT IS NAMED: `wait-premise-gone` when the row still carries a `Not-before:` that `waitingOn` no longer holds (the
 * field is in the past, and it names the CAUSE, so it is asked first), `never-started` for a claim with no commit, push, comment or pull request of the
 * holder's, and `idle-no-wait` for every other holder that has moved before and then stopped with nothing declared.
 * @param {any} row @param {ClaimMoves} moves @returns {string}
 */
function idleReasonOf(row, { commit, push, comment, openPrs }) {
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
 * @param {any} row @param {Holders} holders @returns {{ reason: string } | { unknown: string } | null}
 */
function idleShapeOf(row, holders) {
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
 * @param {any[]} openRows @param {any[]} claimedComments @param {Holders} [holders]
 * @returns {{ items: import("../org-health.mjs").OverdueCandidate[], unknown: string[] }}
 */
function claimedRowReadings(openRows, claimedComments, holders) {
  const commentsOf = new Map(claimedComments.map((row) => [Number(row.number), row.comments ?? []]));
  /** @type {string[]} */
  const unknown = [];
  const items = openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL)).map((row) => {
    const shape = holders === undefined ? null : idleShapeOf(row, holders);
    if (shape !== null && "unknown" in shape) unknown.push(shape.unknown);
    const base = labelsOf(row).some((label) => label.startsWith("hold:")) ? "held" : "claimed";
    const item = { kind: /** @type {const} */ ("row"), number: row.number, reason: base, owner: sessionOf(row), since: claimRecordOf(commentsOf.get(Number(row.number)) ?? [])?.at ?? null };
    return shape !== null && "reason" in shape ? { ...item, reason: shape.reason, boundMinutes: OVERDUE_IDLE_CLAIM_MINUTES } : item;
  });
  return { items, unknown };
}

/**
 * @param {any[]} openRows @param {any[]} claimedComments @param {Holders} [holders]
 * @returns {import("../org-health.mjs").OverdueCandidate[]}
 */
export function claimedRowFacts(openRows, claimedComments, holders) {
  return claimedRowReadings(openRows, claimedComments, holders).items;
}

/**
 * Whether the herdr listing is NEEDED: some claimed row is in question for the idle shapes. A quiet org, and a tick whose claims are all moving or own a
 * pull request, makes no herdr call (`work-gate.mjs` pays for a read only when a condition derived from rows in hand asks for it).
 * @param {any[]} openRows @param {Map<number, ClaimMoves> | null} moves @param {number} now
 */
export function needsHolderAgents(openRows, moves, now) {
  return openRows.some((row) => labelsOf(row).includes(CLAIM_LABEL) && untouchedMoves(row.number, { moves, agents: null, now }) !== null);
}

/**
 * #3486: THE OUTCOME CLOCK'S FACTS: the PRs and, when the tick holds the claimed rows' comments, the rows. `claimedComments` is `undefined` for a caller
 * that does not ask (silent: the rows are not clocked), and `null` for a refused read (a stated unknown). An open list that was refused clocks
 * nothing and says so; a refused PR list is `items: null`. `holders` (slice 2b) is whom the rows are held by: omitted, the rows are named `claimed`/`held`
 * only; `moves: null` is a claim-stall tick that read no claim, and a listing herdr could not give is `unread` -- said when some row needed it.
 * @param {{ prsRead: any[] | null, openRowsRead: any[] | null, claimedComments?: any[] | null, required: string[] | null, now: number, holders?: Holders }} input
 * @returns {{ items: import("../org-health.mjs").OverdueCandidate[] | null, unread: string[] }}
 */
export function overdueFacts({ prsRead, openRowsRead, claimedComments, required, now, holders }) {
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
 * @param {{ openRowsRead: any[] | null, claimFacts: import("./claim-stall-tick.mjs").ClaimFactsOfTick | null | undefined, now: number,
 *   readHolderAgents: typeof readAgents }} input
 * @returns {Holders | undefined}
 */
function holdersForClock({ openRowsRead, claimFacts, now, readHolderAgents }) {
  if (claimFacts === undefined) return undefined;
  const moves = claimFacts?.moves ?? null;
  return { moves, now, agents: openRowsRead !== null && needsHolderAgents(openRowsRead, moves, now) ? readHolderAgents() : null };
}

/**
 * How many referenced items one tick reads that the open lists do not already hold. A BOUND ON THE API SPEND, NOT A TARGET: a wait cites a
 * few anchors, and the incident that filed #2996 had about ten. A reference past the bound is simply unread -- an unknown, never closed.
 */
export const MAX_WAIT_READS = 30;

/** @param {unknown} iso @returns {number | null} */
const epochOrNull = (iso) => {
  const at = Date.parse(String(iso ?? ""));
  return Number.isFinite(at) ? at : null;
};

/**
 * One item as `gh api repos/<r>/issues/<n>` states it, as a `RefFact`, or `null` for a state it does not know. `merged_at` is on a PULL
 * REQUEST's issue record only, and it is what tells a merge from a close.
 * @param {any} raw @returns {import("../wait-condition.mjs").RefFact | null}
 */
export function refFactOf(raw) {
  const labels = (raw?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));
  const changedAt = epochOrNull(raw?.updated_at);
  if (raw?.state === "open") return { state: "open", labels, resolvedAt: null, changedAt };
  if (raw?.state !== "closed") return null;
  return { state: raw.merged_at ? "merged" : "closed", labels, resolvedAt: epochOrNull(raw.merged_at) ?? epochOrNull(raw.closed_at), changedAt };
}

/**
 * ONE REFERENCED ITEM'S STATE, or `null` when it could not be read: NEVER "closed" -- a refused read says nothing about the item.
 * @param {{ repo: string | null, number: number }} ref @param {(args: string[]) => string} run
 */
export function readWaitRef(ref, run = defaultRun) {
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
 * @param {{ items: import("../wait-condition.mjs").WaitItem[], open: any[], run: (args: string[]) => string, limit?: number }} input
 * @returns {import("../wait-condition.mjs").WaitFacts}
 */
export function readWaitFacts({ items, open, run, limit = MAX_WAIT_READS }) {
  return readRefFacts({ refs: referencesOf(items), open, run, limit });
}

/**
 * #2997: THE FACTS FOR A LIST OF REFERENCES, whoever named them -- a wait (#2996) or a ruling's check. The lookup is `readWaitFacts`'s own: the open lists first,
 * then one `gh api` call each up to `limit`; a reference neither held nor read is left OUT, which `conditionHolds` calls unknown.
 * @param {{ refs: { key: string, repo: string | null, number: number }[], open: any[], run: (args: string[]) => string, limit?: number }} input
 * @returns {import("../wait-condition.mjs").WaitFacts}
 */
export function readRefFacts({ refs, open, run, limit = MAX_WAIT_READS }) {
  /** @type {Record<string, import("../wait-condition.mjs").RefFact>} */
  const known = {};
  // An item of another repository is held under `owner/repo#n`, so `#148` of `agent-org` cannot answer for `#148` of the first repository (#3479).
  for (const raw of open) known[raw.repoKey && raw.repo ? `${raw.repo}#${Number(raw.number)}` : `#${Number(raw.number)}`] = { state: "open", labels: (raw.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l)),
    resolvedAt: null, changedAt: epochOrNull(raw.updatedAt) };
  /** @type {Record<string, import("../wait-condition.mjs").RefFact>} */
  const items_ = {};
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
 * @param {{ prsRead: any[] | null, openRowsRead: any[] | null, now: number, run?: (args: string[]) => string,
 *           readers?: import("./held-on-satisfied-orders.mjs").ReleaseReaders }} input
 */
export function waitTickFacts({ prsRead, openRowsRead, now, run = defaultRun, readers = { distTags: registryDistTags, tagExists: (tag) => remoteTagExists(tag, { run, repo: repoNow }) } }) {
  if (prsRead === null || openRowsRead === null) return null;
  const items = [...prsRead.map((pr) => waitItemOf(pr, "pr")), ...openRowsRead.map((row) => waitItemOf(row, "row"))];
  const facts = { ...readWaitFacts({ items, open: [...prsRead, ...openRowsRead], run }), releases: readReleaseFacts({ items, readers }) };
  return { facts, stale: staleWaits({ items, facts, now }), bare: bareWaits({ items, now }), manual: manualWaits({ items, now }), umbrella: umbrellaEdges({ items }) };
}

/**
 * THE SETTER'S ORDER, one per stale wait (capped like every row order): the item, the condition that is now true, and the exact fields to
 * remove. IT IS THE `org-health` CAUSE, addressed to the setter and not to `ceo`: a cause of its own would be declared in
 * `cause-declaration.mjs`, outside #2996's Region, and the profile (judgment, high) is the right one for an order to look and remove.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * chairman, 2026-10-02: a freeze ended at 06:50Z and the waits it caused stood four hours.
 *
 * @param {import("../wait-condition.mjs").StaleWait[]} stale
 */
export function staleWaitOrders(stale) {
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

const PR_HOLD_ENTRY = fileURLToPath(new URL("../pr-hold.mjs", import.meta.url));

/**
 * #3364: RELEASE ONE SESSION'S HOLD THROUGH THE MODULE THAT OWNS IT, `pr-hold.mjs --release`, which removes the label AND re-arms a pull request that carried
 * `rearm-on-release` (a bare label removal leaves it unarmed: "Lifting a hold does not arm"). A child process rather than an import, because the module is a
 * CLI whose `main` runs on load. Exit `0` is DONE; `2` (released but the re-arm could not be proven) is NOT done, so the order still goes to a session.
 * #3479: `repoKey` AIMS IT at the pull request's repository, and the first repository's call is exactly what it was (no flag).
 * @param {number} number @param {string} session @param {string} [repoKey] @returns {boolean} whether the release reported done
 */
export function releaseHoldViaModule(number, session, repoKey) {
  const aim = repoKey ? [`--repo-key=${repoKey}`] : [];
  const result = spawnSync(process.execPath, [PR_HOLD_ENTRY, String(number), `--session=${session}`, "--release", ...aim], { encoding: "utf8" });
  if (result.status !== 0) process.stderr.write(`COULD NOT lift hold:${session} on pr-${subjectRef(repoKey, number)} (exit ${result.status}): ${String(result.stderr).trim()}\n`);
  return result.status === 0;
}

/** #3479: the keys of the repositories the project declares for code, the first's empty key left out. @returns {Set<string>} */
const declaredRepoKeys = () => new Set(homeProjectDeclaration().code.map((entry) => entry.key).filter((key) => key !== ""));

/**
 * #3364: THE GATE LIFTS A HOLD WHOSE `Waiting-for: merged|closed` IS TRUE, instead of ordering a session to remove one label. Returns the stale waits that STILL
 * need a session: those `liftableHolds` leaves, and those whose release failed (so a failure falls back to today's order, as `performActions` does for a
 * refused `gh pr ready`, and says so on stderr). A lifted hold carries no label, so the next tick finds no stale wait for it.
 * #3479: a pull request of a repository the project declares is lifted too, released WITH its key; `declared` is the test's seam for which keys those are.
 * @param {import("../wait-condition.mjs").StaleWait[]} stale @param {{ now: number, release?: typeof releaseHoldViaModule, log?: (line: string) => void, declared?: ReadonlySet<string> }} io
 * @returns {import("../wait-condition.mjs").StaleWait[]}
 */
export function liftResolvedHolds(stale, { now, release = releaseHoldViaModule, log = (line) => process.stderr.write(line), declared = declaredRepoKeys() }) {
  const { lifts, remaining } = liftableHolds(stale, now, declared);
  const failed = lifts.filter(({ item, holders }) => !holders.map((session) => release(item.number, session, item.repoKey)).every(Boolean));
  for (const { item, holders } of lifts.filter((l) => !failed.includes(l))) log(`DID lift-hold pr-${subjectRef(item.repoKey, item.number)} (${holders.join(", ")}) -- its Waiting-for is true; no session woken\n`);
  return [...remaining, ...failed.flatMap((l) => l.stale)];
}

/**
 * #2996: THE GREEN PULL REQUESTS, counting a PR whose hold has stopped excusing as the mergeable PR it would be with the hold lifted.
 * @param {any[]} prs @param {string[] | null} required @param {(pr: any) => boolean} holdStands
 */
function greenCountWithLapsedHoldsLifted(prs, required, holdStands) {
  return shouldBeMerging(prs.map((pr) => (holdersOf(labelsOf(pr)).length > 0 && !holdStands(pr) ? withoutHold(pr) : pr)), required).length;
}

/**
 * #2997: THE RULINGS THE TICK RE-READS. Cheap first: no unresolved ruling means NO read at all, so a quiet record costs the tick nothing. A ruling's single-reference
 * checks are read through `readRefFacts` (the open lists, then `gh api`), its population checks from the two lists the tick already holds; a refused list is `null`, which
 * a check reads as unknown and never as a pass. The line posted on the ruling's issue is the tick's one write besides the record.
 * @param {{ prsRead: any[] | null, openRowsRead: any[] | null, now: number }} tick
 * @param {{ stateDir?: string, run?: (args: string[]) => string, log?: (line: string) => void }} [io]
 */
export function rulingOrdersNow({ prsRead, openRowsRead, now }, { stateDir = REVIEWER_STATE_DIR, run = defaultRun, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
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
 * #2936: THE ORG-HEALTH TICK over what `main` already holds. Reads ONE new thing, the last merge (`GH_READS`); every other fact is a
 * value the tick computed for `decide`: the PRs with their owners, `required`, the offered rows, the #2845 streaks and the primary's
 * drift. `prsRead`/`readyRead` are the RAW reads, `null` for a refusal, because `decideArgs` carries them coalesced to `[]` and
 * a refused read must reach the detector as an unknown. A refusal of the streak read is the counter's own stderr line
 * (`claim-refusals: could not run`), which `repeating-lines.mjs` offers if it persists; it reaches here as no streaks.
 *
 * #2980: THE FLEET FACTS ARE PASSED, because `orgHealthReadings` reads an OMITTED `fleet` as "this caller does not ask" -- silent -- so
 * a gate that never passed them had the idle-fleet signal dead for as long as nobody noticed. `openRowsRead` is the raw read for the
 * same reason as `prsRead`. `io` is for the test: the clock, the last merge, the ledger and the log, so nothing here needs a token.
 * #3486: `claimedComments` IS THE CLAIMED ROWS' COMMENTS (`readClaimedRowComments`), `undefined` WHEN THE CALLER DOES NOT ASK, so the claimed rows are not clocked (see `overdueFacts`).
 * #3731: `held` IS THE ORDERS THE GATE WITHHELD THIS TICK FOR A RUNNER START (`holdForGithubIncident`'s `held`), and a pull request one of them names is NOT COUNTED as red: `decided` is
 * the list from BEFORE the hold, so without it the red the gate chose not to wake anyone for tripped `red-pr-unattended` two hours later, a second alarm for a failure the org had
 * decided not to act on. NOTHING IS RECORDED: the next tick with the incident gone holds nothing, so the same red counts again by itself. `undefined` is a caller with no hold.
 * #3448: `pools` IS THE API BUDGETS THIS TICK'S OWN READS NAMED (`readRowsOffBoard` leaves the GraphQL one); EMPTY IS A REFUSED READ AND THE SIGNAL SAYS IT WAS NOT READ, never clear.
 * @param {{ prsRead: any[] | null, readyRead: any[] | null, openRowsRead: any[] | null, claimedComments?: any[] | null, decideArgs: any, decided: any[], held?: { subject: string }[], pools?: import("../org-health.mjs").PoolReading[] }} tick
 * @param {{ now?: number, lastMergedAt?: () => number | null, readCaptures?: (now: number) => ReturnType<typeof readFleetCaptures>,
 *           log?: (line: string) => void, readCopies?: () => null, readLabJobs?: () => string[] | null, readWaits?: typeof waitTickFacts,
 *           release?: typeof releaseHoldViaModule, readHolderAgents?: typeof readAgents, readToolAgreement?: typeof import("../org-health.mjs").readToolAgreement,
 *           readReleaseRuns?: () => import("../org-health.mjs").ReleaseRuns | null | undefined,
 *           teamAccess?: () => import("../org-health.mjs").TeamAccessFact | undefined }} [io] `readReleaseRuns` (#4001) is `undefined` WHEN THE CALLER DOES NOT ASK, which is every test; the gate's call site passes the real one (ONE `gh api` call a tick, three while the newest release is a failure), so no test reaches a remote; `teamAccess` (#3634) is the team-level read, ONE `gh api` call per declared team each tick (the 2-minute tick is 30 calls an hour of a 5,000-an-hour core pool, 0.6% per team, the same price as `lastMergedAt`), and NO CALL AT ALL for a project that declares no `teamAccess`; a test that must reach no remote passes `() => undefined` `readToolAgreement` (#3533) is `undefined` WHEN THE CALLER DOES NOT ASK, which is every test
 *           and the gate's call site passes the real one, so no test reaches a remote; `readWaits` (#2996) is the test's seam for the
 *           referenced items, so nothing here needs a token; `release` (#3364) is its seam for the hold release, so nothing here runs `pr-hold.mjs`
 */
export function orgHealthNow({ prsRead, readyRead, openRowsRead, claimedComments, decideArgs, decided, held, pools },
  { now = Date.now(), lastMergedAt = () => readLastMergedAt(defaultRun, repoNow()), readCaptures = (at) => readFleetCaptures({ now: at }), log, readCopies,
    readLabJobs = dispatchedLabJobsOrSay, readWaits = waitTickFacts, release, readHolderAgents = readAgents, readToolAgreement = () => undefined, readReleaseRuns = () => undefined,
    teamAccess = () => readTeamAccess(defaultRun) } = {}) {
  const { prs, required, primaryDrift, claimRefusals, claimFacts } = decideArgs;
  // #2996: THE WAITS ARE READ BEFORE THE READINGS, because a hold's excuse is now a question about its condition. `null` is a refused
  // list: the hold then keeps its label-only excuse (the old behaviour) and the two wait readings say unknown.
  const waits = liftedWaits(readWaits({ prsRead, openRowsRead, now }), { now, release });
  const { holdStands, stale } = waitStanding(waits, now);
  const readings = orgHealthTick({
    now,
    lastMergedAt: lastMergedAt(),
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
    ...(openRowsRead !== undefined && { idle: idleFact({ openRowsRead, prsRead, readyRead, decideArgs, now }) }), // #3943: the same rows, and the gate's own shelving list
    ...(pools !== undefined && { pools: pools.length > 0 ? pools : null }),
    ...toolAgreementFact(readToolAgreement()),
    ...releaseRunsFact(readReleaseRuns()), // #4001
    ...teamAccessFact(teamAccess()),
  }, { ...(log && { log }), ...(readCopies && { readCopies }) });
  const { held: heldOnSatisfied, rest } = splitHeldOnSatisfied(stale);
  const cap = { limit: MAX_ROW_ORDERS_PER_TICK };
  return [...readings, ...staleWaitOrders(rest), ...heldOnSatisfiedOrders(heldOnSatisfied, cap), ...umbrellaEdgeOrders(waits?.umbrella ?? [], cap)];
}

/**
 * #3943: THE ENGINEER SEATS: the standing roles `sessions.json` marks `engineer` and every spawned `worker-<n>` a row names (a spawned seat exists only while it
 * holds one, so the rows are where it is read from). `null` is a roster that could not be read, which is unknown and never "no engineer".
 * @param {any[]} openRows @param {string} [path]
 * @returns {string[] | null}
 */
export function engineerSeats(openRows, path = roleBriefPath("sessions.json").absolute) {
  try {
    const { live } = JSON.parse(readFileSync(path, "utf8"));
    const standing = live.filter((/** @type {any} */ s) => s.role === "engineer" && s.family === undefined).map((/** @type {any} */ s) => s.name);
    const spawned = openRows.flatMap((row) => labelsOf(row).filter((l) => l.startsWith(SESSION_PREFIX)).map((l) => l.slice(SESSION_PREFIX.length)))
      .filter((name) => familyNumber(name) !== null);
    return [...new Set([...standing, ...spawned])];
  } catch {
    return null;
  }
}

/**
 * #3943: THE IDLE READING over the rows and the gate's own offer, both already in hand. A tick whose pull-request or Ready read was refused cannot say which
 * rows the gate shelves, so it says UNREAD: every ready row would otherwise read as `READY_UNOFFERED`, a false defect.
 * @param {{ openRowsRead: any[] | null, prsRead: any[] | null, readyRead: any[] | null, decideArgs: any, now: number }} input
 */
function idleFact({ openRowsRead, prsRead, readyRead, decideArgs, now }) {
  if (openRowsRead === null) return idleWithOpenRowsReading({ now, engineers: null, openRows: null });
  if (prsRead === null || readyRead === null) return { kind: /** @type {const} */ ("unread"), why: "the gate's own offer could not be read, so which ready rows it withholds is not known" };
  const { prFiles, rowBranches, openRows, readyRows } = decideArgs;
  const shelved = new Map(partitionUnclaimed(readyRows, prFiles, { rowBranches, openRows }).blocked.map((b) => [b.number, b.reason]));
  return idleWithOpenRowsReading({ now, engineers: engineerSeats(openRowsRead), openRows: openRowsRead, shelved });
}

/**
 * #3731: THE PULL REQUESTS THE GATE IS NOT WAKING ANYONE FOR. A held order names its pull request by the subject `redPrFacts` also keys on, so the one spelling excludes it.
 * @param {any[]} prs @param {{ subject: string }[] | undefined} held
 */
function withoutHeld(prs, held) {
  if (held === undefined || held.length === 0) return prs;
  const subjects = new Set(held.map((h) => h.subject));
  return prs.filter((pr) => !subjects.has(`pr-${subjectRef(pr.repoKey, pr.number)}`));
}

/**
 * #3533: THE FACT, OR NOTHING. `undefined` is a caller that does not ask (and a host that declares no tool): the key is then left out, and `orgHealthReadings` reads an omitted one as silent.
 * @param {ReturnType<typeof import("../org-health.mjs").readToolAgreement>} read @returns {{ toolAgreement?: { now: number, result: any } | null }}
 */
const toolAgreementFact = (read) => (read === undefined ? {} : { toolAgreement: read });

/** #4001: THE FACT, OR NOTHING: `undefined` is a caller that does not ask, silent, and `null` a refused read, which the signal says is unknown. @param {import("../org-health.mjs").ReleaseRuns | null | undefined} read */
const releaseRunsFact = (read) => (read === undefined ? {} : { releaseRuns: read });

/**
 * #3634: THE FACT, OR NOTHING, as `toolAgreementFact`: `undefined` is a project that declares no `teamAccess`, so the reading is silent.
 * @param {import("../org-health.mjs").TeamAccessFact | undefined} read
 */
const teamAccessFact = (read) => (read === undefined ? {} : { teamAccess: read });

/**
 * #3364: THE WAIT READ AFTER THE GATE HAS LIFTED WHAT IT CAN, so the readings and the orders see only the stale waits a session still owes. `null` stays `null`.
 * @param {ReturnType<typeof waitTickFacts>} waits @param {{ now: number, release?: typeof releaseHoldViaModule }} io
 */
function liftedWaits(waits, { now, release }) {
  return waits === null ? null : { ...waits, stale: liftResolvedHolds(waits.stale, { now, release }) };
}

/**
 * WHAT THE TICK'S WAIT READ SAYS TO THE REST OF IT: whether a hold still excuses (`undefined` when the read was refused, which leaves the label's own excuse
 * as it was) and the waits that stand although their condition is true.
 * @param {ReturnType<typeof waitTickFacts>} waits @param {number} now
 */
function waitStanding(waits, now) {
  if (waits === null) return { holdStands: undefined, stale: [] };
  return { holdStands: (/** @type {any} */ pr) => holdExcused(pr, { facts: waits.facts, now }), stale: waits.stale };
}

/**
 * WHAT COULD LAND, for `no-merge-while-work-exists`: the green PRs (a PR whose hold has stopped excusing counts as the mergeable one it would be with the hold
 * lifted, #2996) and the claimable Ready rows (a Ready row whose wait is stale counts as one the wait is hiding).
 * @param {any} decideArgs @param {{ holdStands?: (pr: any) => boolean, stale: import("../wait-condition.mjs").StaleWait[] }} waits
 * @returns {{ greenPrs: number, claimableRows: number }}
 */
function workThatCouldLand({ prs, required, readyRows, prFiles, rowBranches, openRows }, { holdStands, stale }) {
  const staleReadyRows = stale.filter((s) => s.item.kind === "row" && s.item.labels.includes(READY_LABEL)).length;
  return {
    greenPrs: holdStands ? greenCountWithLapsedHoldsLifted(prs, required, holdStands) : shouldBeMerging(prs, required).length,
    claimableRows: partitionUnclaimed(readyRows, prFiles, { rowBranches, openRows }).offerable.length + staleReadyRows,
  };
}
