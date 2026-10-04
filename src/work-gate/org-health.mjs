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
  shouldBeMerging, labelsOf, sessionOf, REVIEWER_STATE_DIR, dispatchedLabJobsOrSay, redPrFacts, partitionUnclaimed } from "../work-gate.mjs";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.mjs";
import { claimRecordOf } from "../claim-stall.mjs";
import { FLEET_IDLE_HOURS, readLastMergedAt, orgHealthTick,
  primaryStandingSince } from "../org-health.mjs";
import { holdersOf, holdExcused } from "../pr-hold-state.mjs";
import { withoutHold } from "../red-pr.mjs";
import { subjectRef, subjectMention } from "../review-attribution.mjs";
import { readRulings, unreadableLine, rulingTick } from "../ruling-record.mjs";
import { homeProjectDeclaration } from "../project-config.mjs";
import { referencesOf, waitItemOf, staleWaits, bareWaits, manualWaits, parseWaits, liftableHolds } from "../wait-condition.mjs";
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
 * #3486: EVERY CLAIMED ROW AS A CANDIDATE FOR THE OUTCOME CLOCK: the age runs from the NEWEST claim record (`claimRecordOf`, which is the claim and
 * not a release) and nothing but the row closing stops it. `claimedComments` is `readClaimedRowComments`'s page; a claimed row it does not carry, or
 * one with no claim record, is `since: null` -- an unknown, never young. The reason is `held` for a row carrying a `hold:` label and `claimed` otherwise.
 * @param {any[]} openRows @param {any[]} claimedComments
 * @returns {import("../org-health.mjs").OverdueCandidate[]}
 */
export function claimedRowFacts(openRows, claimedComments) {
  const commentsOf = new Map(claimedComments.map((row) => [Number(row.number), row.comments ?? []]));
  return openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL)).map((row) => ({
    kind: "row", number: row.number, reason: labelsOf(row).some((label) => label.startsWith("hold:")) ? "held" : "claimed",
    owner: sessionOf(row), since: claimRecordOf(commentsOf.get(Number(row.number)) ?? [])?.at ?? null,
  }));
}

/**
 * #3486: THE OUTCOME CLOCK'S FACTS: the PRs and, when the tick holds the claimed rows' comments, the rows. `claimedComments` is `undefined` for a caller
 * that does not ask (silent: the rows are not clocked), and `null` for a refused read (a stated unknown). An open list that was refused clocks
 * nothing and says so; a refused PR list is `items: null`.
 * @param {{ prsRead: any[] | null, openRowsRead: any[] | null, claimedComments?: any[] | null, required: string[] | null, now: number }} input
 * @returns {{ items: import("../org-health.mjs").OverdueCandidate[] | null, unread: string[] }}
 */
export function overdueFacts({ prsRead, openRowsRead, claimedComments, required, now }) {
  if (prsRead === null) return { items: null, unread: [] };
  const prs = stalledPrFacts(prsRead, required, { now });
  if (claimedComments === undefined) return { items: prs, unread: [] };
  if (openRowsRead === null) return { items: prs, unread: ["the open rows"] };
  if (claimedComments === null) return { items: prs, unread: ["the claimed rows' comments"] };
  return { items: [...prs, ...claimedRowFacts(openRowsRead, claimedComments)], unread: [] };
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
 * @param {{ prsRead: any[] | null, openRowsRead: any[] | null, now: number, run?: (args: string[]) => string }} input
 */
export function waitTickFacts({ prsRead, openRowsRead, now, run = defaultRun }) {
  if (prsRead === null || openRowsRead === null) return null;
  const items = [...prsRead.map((pr) => waitItemOf(pr, "pr")), ...openRowsRead.map((row) => waitItemOf(row, "row"))];
  const facts = readWaitFacts({ items, open: [...prsRead, ...openRowsRead], run });
  return { facts, stale: staleWaits({ items, facts, now }), bare: bareWaits({ items, now }), manual: manualWaits({ items, now }) };
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
    .filter((w) => w.state !== "manual" && w.state !== "unreadable").map((w) => ({ key: w.key, repo: w.repo, number: w.number }));
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
 * #3448: `pools` IS THE API BUDGETS THIS TICK'S OWN READS NAMED (`readRowsOffBoard` leaves the GraphQL one); EMPTY IS A REFUSED READ AND THE SIGNAL SAYS IT WAS NOT READ, never clear.
 * @param {{ prsRead: any[] | null, readyRead: any[] | null, openRowsRead: any[] | null, claimedComments?: any[] | null, decideArgs: any, decided: any[], pools?: import("../org-health.mjs").PoolReading[] }} tick
 * @param {{ now?: number, lastMergedAt?: () => number | null, readCaptures?: (now: number) => ReturnType<typeof readFleetCaptures>,
 *           log?: (line: string) => void, readCopies?: () => null, readLabJobs?: () => string[] | null, readWaits?: typeof waitTickFacts,
 *           release?: typeof releaseHoldViaModule }} [io] `readWaits` (#2996) is the test's seam for the
 *           referenced items, so nothing here needs a token; `release` (#3364) is its seam for the hold release, so nothing here runs `pr-hold.mjs`
 */
export function orgHealthNow({ prsRead, readyRead, openRowsRead, claimedComments, decideArgs, decided, pools },
  { now = Date.now(), lastMergedAt = () => readLastMergedAt(defaultRun, repoNow()), readCaptures = (at) => readFleetCaptures({ now: at }), log, readCopies,
    readLabJobs = dispatchedLabJobsOrSay, readWaits = waitTickFacts, release } = {}) {
  const { prs, required, primaryDrift, claimRefusals } = decideArgs;
  // #2996: THE WAITS ARE READ BEFORE THE READINGS, because a hold's excuse is now a question about its condition. `null` is a refused
  // list: the hold then keeps its label-only excuse (the old behaviour) and the two wait readings say unknown.
  const waits = liftedWaits(readWaits({ prsRead, openRowsRead, now }), { now, release });
  const { holdStands, stale } = waitStanding(waits, now);
  const readings = orgHealthTick({
    now,
    lastMergedAt: lastMergedAt(),
    work: prsRead !== null && readyRead !== null ? workThatCouldLand(decideArgs, { holdStands, stale }) : null,
    redPrs: prsRead === null ? null : redPrFacts(prs, decided, { holdStands }),
    overdue: overdueFacts({ prsRead, openRowsRead, claimedComments, required, now }),
    refusals: claimRefusals ?? null,
    drift: primaryDrift ?? null,
    primarySince: primaryStandingSince(primaryDrift ?? null, { root: REPO_CHECKOUT }),
    fleet: readCaptures(now),
    waiting: fleetWaitingFacts(openRowsRead, readLabJobs()),
    waits,
    ...(pools !== undefined && { pools: pools.length > 0 ? pools : null }),
  }, { ...(log && { log }), ...(readCopies && { readCopies }) });
  return [...readings, ...staleWaitOrders(stale)];
}

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
