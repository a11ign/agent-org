// module: the claim-stall tick -- what the gate says to a session whose claim has stopped moving (#2898)
//
// MOVED OUT OF `work-gate.ts`, NOT REWRITTEN (#2898, the fifth split of #928's lever 2a): `claimStallTick`, the
// claim evaluation it runs, the declared-wait reading that excuses a quiet claim, and the helpers only they use.
// Measured on #2898: a row waited behind three pull requests in a day for edits to exactly these definitions.
//
// THE BOUNDARY, as `work-gate/pr-orders.ts` states it: what only this family uses lives here; what a family that
// stayed behind also uses (`readPrs`, `readClaimedRowComments`, `readMergedPrs`, `gitRun`) is IMPORTED from
// `work-gate.ts`, the cycle that module documents, safe while nothing here reads an imported binding at load time.
// `withChecksPending` STAYED: it reads the PR rollup, and `org-health.test.ts`'s #2956 guard enlists any file that does.
// `work-gate.ts` re-exports every name this file exports that it exported before.
import { labelsOf, REPO_CHECKOUT, REVIEWER_STATE_DIR, systemctlRun, openBlockers, withChecksPending, readMergedPrs,
  readElsewherePrs } from "../work-gate.ts";
import { familyNumber } from "../arm-pr.ts";
import { CLAIM_LABEL } from "../claim-labels.ts";
import { gitRun, pathExists, statMtime, readStallState, writeStallState, readJsonObject, writeJsonObject, STALL_STATE_FILE, nextStallState,
  claimStalledOrders, readHerdrRestart, claimFactsFrom, readClaim, readLabelEvents, nudgeDeliveredAt, nudgeKey, closedClaimOrders,
  restartNotices, recordStalledNudges, AGENT_SESSIONS_FILE, Unreadable, withRedChecks } from "../claim-stall.ts";
import { subjectMention, subjectRef } from "../review-attribution.ts";
import { claimRecordOf } from "../claim-record.ts";
import { idleClaimantReading, verifiedCloseOrder, type VerifiedCloseOrder } from "../idle-claimant.ts";
import { FAILURE_LEDGER_FILE } from "../failure-ledger.ts";
import { readAgents, readAgentSessions } from "../herdr-agents.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL, SESSION_PREFIX } from "../project-vocabulary.ts";
import { waitingOn, fleetWaitingOn, describeWaiting, answersOwedBy } from "../waiting-condition.ts";
import { declaredWaitsOf, waitItemOf, conditionHolds, type WaitFacts } from "../wait-condition.ts";
import { WORKER_STATE_DIR, readDeclarations, lastDeliveredTo, declarationReading } from "../worker-state.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { CANARY_STATE_FILE, DEFAULT_CANARY_OPTIONS, machineryFlagOn, parseCanaryState, type CanaryState } from "../org-health.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * What the live tick reads the host with. `labelEvents` (#4789) is the tracker's row history, so a merge counts only from when THIS session's label
 * was added; without it a hand-started engineer inherits the previous holder's merged pull request. #612 reads the same history for the stall clock,
 * so without it a hand-started engineer is nudged at its first tick.
 */
export const LIVE_HOST_READS: import("../claim-stall.ts").HostReads = { git: gitRun, exists: pathExists, mtime: statMtime,
  labelEvents: (row: number) => readLabelEvents(row, homeProjectDeclaration().tracker[0].repo) };

/**
 * What a row DECLARES it is waiting on, as a phrase, or `null`. Only the waits that are DATA the org already reads -- a
 * future `Not-before:`, an `answer:<session>` label, a `Fleet-hold-until:` and the chairman's label -- and NOT an open
 * `blockedBy` edge, which `claimReading` treats separately (a holder with nothing built is released from one).
 *
 * `answer:<the holder>` IS NOT A WAIT OF THE HOLDER'S. It says a session owes an answer, and when that session is the one holding the row it
 * is the row waiting on the HOLDER -- the opposite of a holder with a legitimate reason to be quiet. `ceo`'s ruling on the 2026-09-25 stalled
 * sweep (a comment on #2470, section B) has `product-manager` set `answer:<holder>` on each stalled claim to wake it; reading those as
 * declared waits would exempt exactly the rows this cause exists for. An `answer:` owed by ANOTHER session (`answer:product-manager` on a
 * row an orchestrator holds) is the holder waiting on a ruling, and is respected.
 */
function declaredWait(row: any, holder: string, waitFacts: WaitFacts | null, watching: ReadonlySet<string> | null): string | null {
  return declaredWaitOf(row, holder, waitFacts, watching)?.phrase ?? null;
}

/**
 * `declaredWait`'s decision with its KIND, which is the `WAIT_FIELDS` key `idle-claimant.ts` counts as a field (#2999): ONE decider for "this
 * row has a wait field", so the idle reading and the clock reading cannot disagree about a row. `blocked` (the label) is not a kind: it names
 * no referent. `fleet-hold` is a `Fleet-hold-until:` line, whose second meaning -- a claim on the workers -- nothing else reads.
 *
 * `canary-hour` is a row that names a machinery flag the canary is still watching (`canaryHourOf`), read after the row's own declared waits so a row that
 * states one keeps its kind.
 */
function declaredWaitOf(row: any, holder: string, waitFacts: WaitFacts | null, watching: ReadonlySet<string> | null): { kind: string; phrase: string; } | null {
  if (labelsOf(row).includes(CHAIRMAN_LABEL)) return { kind: "chairman", phrase: `waiting on the chairman (${CHAIRMAN_LABEL})` };
  const waiting = waitingOn({ ...row, blockedBy: { nodes: [] } }) ?? fleetWaitingOn(row);
  if (waiting !== null && !(waiting.kind === "answer" && waiting.session === holder)) {
    const kind = waiting.kind === "date" ? "not-before" : waiting.kind === "row" ? "blocked-by" : waiting.kind;
    return { kind, phrase: describeWaiting(waiting) };
  }
  return canaryHourOf(row, watching) ?? waitingForOf(row, waitFacts);
}

/**
 * The machinery flags the canary is still WATCHING at `now`: switched ON, with no final verdict (`passed` or `reverted`), and inside the hour its `onAt`
 * starts (a flag the gate has not yet started has no `onAt`, and its hour has not begun, so it is watching). Read from the canary file in `stateDir`, the
 * file the gate writes. The names are the file's own keys: `switchFlag` writes only a name in `FLAG_REGISTRY`, so these are the registered flags, and
 * the registry is not imported here because `machinery-flag.ts` imports this family's work-gate modules, and importing it from here throws at load (a TDZ error).
 * `null` when that file cannot be read or is not its shape: a failed read never excuses a quiet holder.
 */
function canaryWatching(stateDir: string, now: number): ReadonlySet<string> | null {
  const path = `${stateDir}/${CANARY_STATE_FILE}`;
  let state: CanaryState;
  try {
    state = parseCanaryState(existsSync(path) ? readFileSync(path, "utf8") : null);
  } catch {
    return null;
  }
  const windowMs = DEFAULT_CANARY_OPTIONS.windowMinutes * 60_000;
  return new Set(Object.keys(state.flags).filter((name) => {
    const record = state.flags[name];
    return machineryFlagOn(state, name) && record.verdict !== "passed" && record.verdict !== "reverted" && (record.onAt === null || now < record.onAt + windowMs);
  }));
}

/**
 * The `canary-hour` decision: a row whose title or body NAMES a flag the canary is still watching, read as `namesOwedKey` reads a name in
 * `flag-switch-ledger.ts` -- a whole word, not a prefix or a dotted part of a longer name.
 */
function canaryHourOf(row: any, watching: ReadonlySet<string> | null): { kind: string; phrase: string; } | null {
  if (watching === null) return null;
  const text = `${row.title}\n${row.body ?? ""}`;
  const flag = [...watching].find((name) => new RegExp(`(^|[^\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`).test(text));
  return flag === undefined ? null : { kind: "canary-hour", phrase: `waiting on the machinery canary for \`${flag}\`, which is still inside its hour` };
}

/**
 * A `Waiting-for:` line in the row's body whose condition is NOT yet true (#1183). The body's own line is read here because `waitingOn` reads only
 * the fields above, so a holder that declared its wait in the body was nudged as though it had declared none. The line is read against the SAME facts
 * the work gate reads for ready rows (`waitFacts`), and a condition that is unknown (`null`: an unread reference, `manual`, an unreadable line) is NOT a
 * declared wait -- a failed read never excuses a quiet holder. A met condition returns `null` on the same tick, so the holder is nudged again.
 *
 * `kind` stays out of `WAIT_RELEASE_KINDS`: a holder with work is not released by it, and one with no work is kept `waiting`, as every unknown kind is.
 */
function waitingForOf(row: any, waitFacts: WaitFacts | null): { kind: string; phrase: string; } | null {
  if (waitFacts === null) return null;
  const unmet = declaredWaitsOf(waitItemOf(row, "row")).waits.find((wait) => conditionHolds(wait, waitFacts) === false);
  return unmet === undefined ? null : { kind: "waiting-for", phrase: `Waiting-for: ${unmet.text}` };
}

/**
 * What a claim's holder has DONE, as plain data: the times
 * of the claim and of the holder's newest comment, commit and push, the pull requests that are the claim's own (`ownsPr`, in every tracked repository) and the
 * merge of one since the claim. Data and not `ClaimFacts`, whose `file` and `work` are thunks that a Map in `decide`'s arguments could not carry through the shadow tap
 */
export type ClaimMoves = { claimedAt: number, comment: number | null, commit: number | null, push: number | null,
  openPrs: { createdAt?: string, labels?: ({ name?: string } | string)[], number?: number, repoKey?: string, reviewDecision?: string | null,
  checksPending?: boolean }[], mergedAt: number | null };

/**
 * Every claimed row's moves, and for the rows whose facts could not be
 * built the reason (`skipped`): a row in neither is one this tick did not evaluate at all
 */
export type ClaimFactsOfTick = { moves: Map<number, ClaimMoves>, skipped: Map<number, string> };

/** `null` is a tick that evaluated NO claim (a refused read), never "no claims" */
export type OnClaimFacts = (facts: ClaimFactsOfTick | null) => void;

/**
 * (agent-org#747) ONE OTHER DECLARED TRACKER'S CLAIMED ROWS, as the stall pass reads them. `key` is the tracker's declared key (`agent-org`), which every memory
 * entry and order subject of its rows is namespaced by, and `repo` is its `owner/repo`, which a pull request title's reference and the row's label history name.
 * `rows: null` is a tracker whose open rows could not be read, and `claimedComments: null` one whose claimed rows' comments could not: each is SAID as unread
 * and never read as "no claim" (a tracker read as empty would forget every nudge it had sent).
 */
export type TrackerClaims = { key: string; repo: string; rows: any[] | null; claimedComments: any[] | null };

/** A row's label history in ONE NAMED tracker: `io.labelEvents` is the home tracker's alone, and for another tracker's row number it would read the home row's. */
export type LabelEventsOf = (row: number, repo: string) => ReturnType<NonNullable<import("../claim-stall.ts").HostReads["labelEvents"]>>;

function movesOf(facts: import("../claim-stall.ts").ClaimFacts): ClaimMoves {
  return { claimedAt: facts.claimedAt, comment: facts.comment, commit: facts.commit(), push: facts.push(),
    // #3569: the fields `idleClaimantReading` reads a holder's wait from (a review, a check, an approval, a hold), already on `ownPrs` -- no new read.
    openPrs: (facts.ownPrs ?? []).map((pr: any) => ({ createdAt: pr.createdAt, labels: pr.labels, number: pr.number, repoKey: pr.repoKey,
      reviewDecision: pr.reviewDecision, checksPending: pr.checksPending })),
    mergedAt: facts.mergedPr?.mergedAt ?? null };
}

/**
 * The home tracker's moves for `onFacts`, the ONE reader that asks every row for its commit and push (its consumers, `org-health` and
 * `blockerClearedOrders`, hold them as plain numbers). A row whose git would not answer is left out of `moves` and named in `skipped`, as it was when the
 * build itself read git: its reading is `holding` (agent-org#1083), and a missing move is "not read", never "no commit".
 * @param {{ readings: { facts: ClaimFacts }[], skipped: Map<number, string> }} home @returns {ClaimFactsOfTick}
 */
function movesOfTick(home: { readings: { facts: import("../claim-stall.ts").ClaimFacts; }[]; skipped: Map<number, string>; }): ClaimFactsOfTick {
  const moves = new Map<number, ClaimMoves>();
  const skipped = new Map(home.skipped);
  for (const { facts } of home.readings) {
    try {
      moves.set(facts.row, movesOf(facts));
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      skipped.set(facts.row, `#${facts.row}: ${err.message}`);
    }
  }
  return { moves, skipped };
}

/**
 * THE WHOLE OF `claim-stalled` FOR ONE TICK: read every claimed row, decide, keep the nudge memory, and return the orders
 * (a nudge to a holder; a RELEASE that `wake.ts` performs).
 *
 * A READ THAT WAS REFUSED EVALUATES NOTHING. `claimedComments === null` means the row comments -- one of the four signals --
 * were not read, and a row read without them looks stalled when it may have been commented on a minute ago. `mergedPrs`
 * null is milder: only the merged release loses its evidence. A row this cannot READ is skipped by name on stderr, because
 * a silence about a claim would look like a claim that was fine.
 *
 * THE CLOCK NEVER STARTS BEFORE THE LAST `herdr.service` START (`restartAt`, 11f), and the tick reads it only when some row
 * is claimed at all. NEVER THROWS: a broken detector must not stop the orders behind it, and it says so.
 *
 * THE SECOND READING IS FAIR ONLY TO A HOLDER THAT WAS TOLD: for a row with a remembered nudge the tick reads the WAKE LEDGER for that nudge's
 * key, and the grace runs from the delivery it finds (`claimReading`). `ledger` is the seam for that read; an unreadable ledger reads as "not
 * delivered", which only DELAYS a release.
 *
 * `onFacts` (#3451) is how the facts this tick built reach `blockerClearedOrders`, which asks of the same holder "did you claim after the clearing, own a
 * pull request, move since" and would otherwise re-derive a narrower copy of these. A callback and not a second return value, because `decide` and every
 * caller of this function take ORDERS; it is called once per tick, with `null` when no claim was evaluated.
 *
 * `agents` (#2747) is herdr's own workspace listing, read the same way `restartAt` is: the caller's reading when given, else a live one --
 * and only when some row is claimed. `null` (herdr could not be asked) never releases a claim as "gone"; see `goneReading`'s own doc.
 */
export function claimStallTick({ io = LIVE_HOST_READS, repo = REPO_CHECKOUT, now = Date.now(),
  stateDir = REVIEWER_STATE_DIR, log = (line) => process.stderr.write(line), read = readStallState, write = writeStallState, ...inputs }: {
        rows: any[]; claimedComments: any[] | null; openPrs: any[]; mergedPrs: any[] | null;
        elsewhere?: import("../claim-stall.ts").ElsewherePrs; io?: import("../claim-stall.ts").HostReads; repo?: string; now?: number; restartAt?: number | null;
        agents?: { label: string; status: string; }[] | null; agentSessions?: Map<string, string> | null;
        stateDir?: string; log?: (line: string) => void; ledger?: () => string;
        read?: typeof readStallState; write?: typeof writeStallState; onFacts?: OnClaimFacts; record?: typeof recordStalledNudges;
        trackers?: TrackerClaims[]; labelEventsOf?: LabelEventsOf;
        /** #1183: the facts a body `Waiting-for:` is read against; absent or `null` reads no body wait (the gate's own rule for ready rows). */
        waitFacts?: WaitFacts | null;
    }): import("../claim-stall.ts").StallOrder[] {
  try {
    return evaluateClaims({ labelEventsOf: io === LIVE_HOST_READS ? readLabelEvents : undefined, ...inputs, io, repo, now, stateDir, log, read, write });
  } catch (err: any) {
    log(`claim-stall: could not run (${String(err?.message ?? err).split("\n")[0]}) -- no claim-stalled order this tick.\n`);
    inputs.onFacts?.(null);
    return [];
  }
}

/**
 * `claimStallTick`'s body, with every default resolved by its caller. NEVER CALLED WITHOUT THE CATCH ABOVE: a throw here is the tick's to report.
 *
 * EVERY DECLARED TRACKER'S CLAIMED ROWS (agent-org#747). The home tracker's rows are read exactly as they were; each of `trackers` is read with the same
 * readings, the same memory file and the same orders, its rows' memory entries and order subjects namespaced by the tracker's key (`agent-org#476`, so
 * `476` of the home tracker is another entry), and two things differ and are SAID where they happen: a tracker that cannot be read is skipped as UNREAD with
 * its memory kept (an empty claim list would forget its nudges), and a release of its rows carries the tracker's key (`ReleaseRequest.tracker`, agent-org#834),
 * which is how `wake.ts` reads the holder's `session:` label, comments and declines in THAT tracker's repository and not the home one's.
 * `onFacts` stays the home tracker's: `blockerClearedOrders` keys those facts by bare row number.
 */
function evaluateClaims({ rows, claimedComments, openPrs, mergedPrs, elsewhere, restartAt, agents, agentSessions, ledger, io, repo, now, stateDir, log, read, write, onFacts, record = recordStalledNudges, trackers = [], labelEventsOf, waitFacts = null }: {
        rows: any[]; claimedComments: any[] | null; openPrs: any[]; mergedPrs: any[] | null; restartAt?: number | null;
        elsewhere?: import("../claim-stall.ts").ElsewherePrs; agents?: { label: string; status: string; }[] | null; agentSessions?: Map<string, string> | null;
        ledger?: () => string; io: import("../claim-stall.ts").HostReads; repo: string; now: number; stateDir: string;
        log: (line: string) => void; read: typeof readStallState; write: typeof writeStallState; onFacts?: OnClaimFacts; record?: typeof recordStalledNudges;
        trackers?: TrackerClaims[]; labelEventsOf?: LabelEventsOf; waitFacts?: WaitFacts | null;
    }) {
  const held = rows.filter((r) => labelsOf(r).includes(CLAIM_LABEL));
  const homeUnread = held.length > 0 && claimedComments === null;
  if (homeUnread) {
    log("claim-stall: the comments on the claimed rows could not be read -- NO claim was evaluated this tick.\n");
    onFacts?.(null);
  }
  // each other tracker: its claimed rows, or why it was not read (said, once per tick, and its memory is kept below)
  const units = trackers.map((tracker) => {
    const heldRows = tracker.rows === null ? [] : tracker.rows.filter((r) => labelsOf(r).includes(CLAIM_LABEL));
    const unread = tracker.rows === null ? "its open rows could not be read"
      : heldRows.length > 0 && tracker.claimedComments === null ? "the comments on its claimed rows could not be read" : null;
    if (unread !== null) log(`claim-stall: tracker \`${tracker.key}\` (${tracker.repo}): ${unread} -- its claimed rows were NOT evaluated this tick (UNREAD, which is not "no claim"; its nudge memory is kept).\n`);
    return { tracker, held: heldRows, unread };
  });
  const readable = units.filter((unit) => unit.unread === null);
  if (homeUnread && readable.length === 0) return [];
  const everyHeld = [...(homeUnread ? [] : held), ...readable.flatMap((unit) => unit.held)];
  const statePath = `${stateDir}/${STALL_STATE_FILE}`;
  const before = read(statePath);
  const watching = canaryWatching(stateDir, now);
  const wakeLedger = ledger ?? (() => ledgerText(`${stateDir}/wake-ledger`));
  // #460: WHAT EACH WORKER'S LAST TURN DECLARED, read once, with no model. `null` is a directory that exists and cannot be read: the declaration regime is
  // then OFF for the tick (absence is not proof), and every claim is read as it was before the declaration existed.
  const declarations = everyHeld.length === 0 ? null : readDeclarations(`${stateDir}/${WORKER_STATE_DIR}`);
  if (declarations !== null && declarations.unreadable.length > 0) log(`claim-stall: worker-state files that could not be read (those workers read as undeclared): ${declarations.unreadable.join(", ")}.\n`);
  const shared = { openPrs, mergedPrs, elsewhere, repo, now, log, declarations, watching, ledger: wakeLedger, restart: restartFor(everyHeld, restartAt),
    agents: agentsFor(everyHeld, agents), heldBy: rowsPerSession(everyHeld) };
  const homeBefore = unscoped(before);
  const home = homeUnread ? { readings: [], skipped: new Map<number, string>(), closes: [] }
    : readClaims({ ...shared, held, byRow: commentsByRow(claimedComments), key: "", trackerRepo: homeProjectDeclaration().tracker[0].repo, io, before: homeBefore, waitFacts });
  if (!homeUnread) onFacts?.(movesOfTick(home));
  const others = readable.map((unit) => {
    const { key, repo: trackerRepo } = unit.tracker;
    // #1183: the facts are the HOME repository's, keyed by bare `#n`, so another tracker's body waits are read against none (unknown, so no excuse)
    const read = readClaims({ ...shared, held: unit.held, byRow: commentsByRow(unit.tracker.claimedComments), key, trackerRepo, waitFacts: null,
      io: { ...io, labelEvents: labelEventsOf === undefined ? undefined : (row: number) => labelEventsOf(row, trackerRepo) } as typeof io,
      before: scopedView(before, `${key}#`) });
    if (unit.held.length > 0) log(`claim-stall: tracker \`${key}\` (${trackerRepo}): ${unit.held.length} claimed rows, ${read.readings.length} evaluated.\n`);
    return { unit, ...read };
  });
  const after: import("../claim-stall.ts").StallState = { ...(homeUnread ? homeBefore : nextStallState(homeBefore, home.readings, now)) };
  for (const unit of units) {
    const prefix = `${unit.tracker.key}#`;
    const mine = others.find((o) => o.unit === unit);
    scopedInto(after, prefix, mine === undefined ? scopedView(before, prefix) : nextStallState(scopedView(before, prefix), mine.readings, now));
  }
  // a memory entry of a key this tick was not asked about (a tracker no longer declared, or no tracker list at all) is nobody's to forget here
  for (const [slot, entry] of Object.entries(before)) {
    if (slot.includes(SCOPE_MARK) && !(slot in after) && !units.some((unit) => slot.startsWith(`${unit.tracker.key}${SCOPE_MARK}`))) after[slot] = entry;
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) write(statePath, after);
  // #458: THE TWO THINGS THAT NEED THE STATE DIRECTORY ITSELF (the restart memory and the failure ledger) are done only where one exists, so a tick
  // run on a fixture with the `read`/`write` seams writes nowhere. A failure of either is said and never stops the orders.
  const kept = existsSync(stateDir);
  const sessionsPath = `${stateDir}/${AGENT_SESSIONS_FILE}`;
  const sessions = agentSessionsFor(everyHeld, agentSessions, agents);
  const acked = kept ? readAckedSessions(sessionsPath) : {};
  const homeTold = homeUnread ? { orders: [], after: unscoped(acked) }
    : restartNotices({ readings: home.readings, sessions, acked: unscoped(acked), delivered: (key) => nudgeDeliveredAt(wakeLedger(), key) !== null });
  const ackedAfter: Record<string, string> = { ...homeTold.after };
  const orders = [...(homeUnread ? [] : claimStalledOrders(home.readings, now)), ...homeTold.orders, ...home.closes];
  for (const unit of units) {
    const { key, repo: trackerRepo } = unit.tracker;
    const prefix = `${key}#`;
    const mine = others.find((o) => o.unit === unit);
    if (mine === undefined) { scopedInto(ackedAfter, prefix, scopedView(acked, prefix)); continue; }
    const told = restartNotices({ readings: mine.readings, sessions, acked: scopedView(acked, prefix),
      delivered: (causeKey) => nudgeDeliveredAt(wakeLedger(), scopedCauseKey(key, causeKey)) !== null });
    scopedInto(ackedAfter, prefix, told.after);
    for (const order of [...claimStalledOrders(mine.readings, now), ...told.orders, ...mine.closes]) orders.push(namespacedOrder(order, key, trackerRepo));
  }
  for (const [slot, value] of Object.entries(acked)) {
    if (slot.includes(SCOPE_MARK) && !(slot in ackedAfter) && !units.some((unit) => slot.startsWith(`${unit.tracker.key}${SCOPE_MARK}`))) ackedAfter[slot] = value;
  }
  if (kept) writeAckedSessions(sessionsPath, ackedAfter, log);
  if (kept) record({ readings: [...home.readings, ...others.flatMap((o) => o.readings)], now, logPath: `${stateDir}/${FAILURE_LEDGER_FILE}` });
  return orders;
}

// --- AGENT-ORG#747: THE OTHER TRACKERS' ROWS ARE KEPT IN THE SAME FILES, UNDER `<key>#<row>` -----------------------------------------------

/** What joins a tracker's key to a row number in a memory slot and an order subject: `agent-org#476`, the spelling `subjectRef` gives a pull request. */
const SCOPE_MARK = "#";

/** The home tracker's entries of a memory: a bare row number, with no tracker key before it. */
function unscoped<T>(memory: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(memory).filter(([slot]) => !slot.includes(SCOPE_MARK)));
}

/** One tracker's entries of a memory (those under `prefix`, `agent-org#`), with the prefix taken off, so the readers that key by row see their own rows. */
function scopedView<T>(memory: Record<string, T>, prefix: string): Record<string, T> {
  return Object.fromEntries(Object.entries(memory).filter(([slot]) => slot.startsWith(prefix)).map(([slot, entry]) => [slot.slice(prefix.length), entry]));
}

/** `scopedView`'s inverse: `view`'s entries written into `into` under `prefix`. */
function scopedInto<T>(into: Record<string, T>, prefix: string, view: Record<string, T>) {
  for (const [slot, entry] of Object.entries(view)) into[`${prefix}${slot}`] = entry;
}

/**
 * A claim's delivery key as the ledger records it for another tracker's row: `<session>/claim-stalled/row-<n>/nudge-<at>` becomes `.../row-agent-org#<n>/...`,
 * so a nudge of `agent-org#476` and one of the home tracker's `476` are two entries in the ledger. The home tracker's keys are unchanged.
 */
function scopedCauseKey(key: string, causeKey: string): string {
  return key === "" ? causeKey : causeKey.replace(/\/row-(\d+)\//, (_whole, row) => `/row-${subjectRef(key, Number(row))}/`);
}

/**
 * An order of another tracker's row, with its subject and delivery key namespaced and its prompt saying which repository the number belongs to (a prompt
 * names a row as `#747`, which the holder's `gh` reads in the repository of its own checkout). A RELEASE carries the tracker's key (agent-org#834), so the
 * performer reads, comments on and declines the row in that tracker and not the home one's of the same number.
 */
function namespacedOrder(order: import("../claim-stall.ts").StallOrder, key: string, repo: string): import("../claim-stall.ts").StallOrder {
  const row = /^row-(\d+)$/.exec(order.subject)?.[1];
  if (row === undefined) return order;
  const ref = subjectRef(key, Number(row));
  return { ...order, subject: `row-${ref}`, causeKey: scopedCauseKey(key, order.causeKey),
    ...(order.release === undefined ? {} : { release: { ...order.release, tracker: key } }),
    prompt: `${order.prompt}\n\nTHIS ROW IS \`${ref}\` OF \`${repo}\`, NOT THE PRIMARY'S #${row}: put \`--repo ${repo}\` on every \`gh\` command that names it, and read its number as \`${ref}\`.` };
}

/** The claimed rows' comments by row number; `null` (unread) is an empty map here, and the caller has already said it was not read. */
function commentsByRow(claimedComments: any[] | null): Map<number, any[]> {
  return new Map((claimedComments ?? []).map((r) => [Number(r?.number), r?.comments ?? []]));
}

/**
 * The herdr agent listing's session ids the restart notice reads (#458): the caller's reading when it has one, else a live one -- unless the caller
 * supplied the workspace listing (`agents`) and not this, which is a fixture, and makes no herdr call. Only when some row is claimed.
 */
function agentSessionsFor(held: any[], given: Map<string, string> | null | undefined, agents: unknown): Map<string, string> | null {
  if (given !== undefined) return given;
  return held.length > 0 && agents === undefined ? readAgentSessions() : null;
}

/** What each holder's session was last told about, `{}` when the file is missing or unreadable: an unreadable memory only ever MISSES a notice, never repeats one. */
function readAckedSessions(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAckedSessions(path: string, acked: Record<string, string>, log: (line: string) => void) {
  const text = `${JSON.stringify(acked, null, 2)}\n`;
  try {
    if (text !== `${JSON.stringify(readAckedSessions(path), null, 2)}\n`) writeFileSync(path, text);
  } catch (err: any) {
    log(`claim-stall: the restart memory could not be written (${String(err?.message ?? err).split("\n")[0]}) -- a restart notice may be offered again.\n`);
  }
}

/**
 * The restart the no-progress clock may not precede: the caller's reading when it has one, else `systemctl`'s -- and only when
 * some row is claimed, so a quiet org spawns nothing.
 */
function restartFor(held: any[], given: number | null | undefined): number | null {
  if (given !== undefined) return given;
  return held.length > 0 ? readHerdrRestart(systemctlRun) : null;
}

/**
 * The herdr workspace listing `goneReading` needs (#2747): the caller's reading when it has one, else a live `herdr
 * workspace list` -- and only when some row is claimed, so a quiet org makes no herdr call either. Mirrors `restartFor`
 * exactly, for the same testability reason this file's own header states about "who is free": a live default is a seam,
 * never the only path, so the gate stays runnable from CI on a fixture alone.
 */
function agentsFor(held: any[], given: { label: string; status: string; }[] | null | undefined): { label: string; status: string; }[] | null {
  if (given !== undefined) return given;
  return held.length > 0 ? readAgents() : null;
}

/**
 * How many claimed rows each session holds: a pull request's `session:` label names a session, which is a claim's own only for a session holding one (#3445).
 */
function rowsPerSession(held: any[]): Map<string, number> {
  const counts = new Map();
  for (const row of held) {
    for (const label of labelsOf(row).filter((n: string) => n.startsWith(SESSION_PREFIX))) {
      const session = label.slice(SESSION_PREFIX.length);
      counts.set(session, (counts.get(session) ?? 0) + 1);
    }
  }
  return counts;
}

function readClaims({ held, byRow, openPrs, mergedPrs, elsewhere, io, repo, now, restart, agents, before, log, ledger, declarations, key, trackerRepo, heldBy, waitFacts, watching }: {
        held: any[]; byRow: Map<number, any[]>; openPrs: any[]; mergedPrs: any[] | null;
        elsewhere?: import("../claim-stall.ts").ElsewherePrs; io: import("../claim-stall.ts").HostReads; repo: string; now: number; restart: number | null;
        agents: { label: string; status: string; }[] | null;
        before: import("../claim-stall.ts").StallState; log: (line: string) => void; ledger: () => string; declarations: ReturnType<typeof readDeclarations>;
        /** the tracker's declared key (`""` is the home tracker's), its `owner/repo`, and how many claimed rows each session holds across every tracker read */
        key: string; trackerRepo: string; heldBy: Map<string, number>;
        /** #1183: the home repository's wait facts (`null` for another tracker, whose bare `#n` are not these), read against each row's body `Waiting-for:` */
        waitFacts: WaitFacts | null;
        /** the machinery flags the canary is still watching at this tick (`canaryWatching`), `null` when its file could not be read */
        watching: ReadonlySet<string> | null;
    }): { readings: { facts: import("../claim-stall.ts").ClaimFacts; reading: import("../claim-stall.ts").Reading; }[]; skipped: Map<number, string>; closes: import("../claim-stall.ts").StallOrder[]; } {
  const readings: { facts: import("../claim-stall.ts").ClaimFacts; reading: import("../claim-stall.ts").Reading; }[] = [];
  // the rows whose facts could not be built, with the reason `claimFactsFrom` gave (#3451)
  const skipped: Map<number, string> = new Map();
  // (agent-org#1536) the rows whose holder is idle since its own VERIFIED note, ordered closed to `product-manager` (`verifiedCloseOf`)
  const closes: import("../claim-stall.ts").StallOrder[] = [];
  // another tracker's lines name its rows as `agent-org#476` and say which tracker they are of; the home tracker's are as they were
  const where = key === "" ? "" : `[${key}] `;
  const mention = (row: number) => subjectMention({ repoKey: key, number: row });
  for (const row of held) {
    const sessions = labelsOf(row).filter((n: string) => n.startsWith(SESSION_PREFIX));
    if (sessions.length !== 1) {
      log(`claim-stall: ${where}${mention(row.number)} carries ${sessions.length} session labels -- not evaluated.\n`);
      continue;
    }
    const session = sessions[0].slice(SESSION_PREFIX.length);
    const built = claimFactsFrom({ row: row.number, title: row.title, session, waiting: declaredWait(row, session, waitFacts, watching),
      waitKind: declaredWaitOf(row, session, waitFacts, watching)?.kind ?? null, blockedBy: openBlockers(row), comments: byRow.get(Number(row.number)) ?? [], openPrs: withChecksPending(openPrs), mergedPrs,
      trackerRepo, sessionRows: heldBy.get(session), now,
      ...(elsewhere === undefined ? {} : { elsewhere: { ...elsewhere, open: elsewhere.open === null ? null : withChecksPending(elsewhere.open) } }), repo }, io);
    if ("skip" in built) {
      log(`claim-stall: ${where}${built.skip} -- not evaluated.\n`);
      skipped.set(Number(row.number), built.skip);
      continue;
    }
    // #612: a clock that could not be dated from the label keeps the record's time, and the tick says so (a log line, not a reading: the reading is today's)
    if (built.clockHeld !== undefined) log(`claim-stall: ${where}${mention(built.row)} (${session}) clock kept at the claim record: ${built.clockHeld}.\n`);
    // #460: the declaration, read against THIS claim. A claim that names no branch (`nothing`) is idle at its prompt by design and has none to make.
    const facts = declarations === null || built.nothing === true ? built : { ...built, declared: declarationReading(declarations.byClaimant.get(session), {
      row: built.row, claimedAt: built.claimedAt, turnStartedAt: lastDeliveredTo(ledger(), session), ownPrs: built.ownPrs ?? [], mergedPr: built.mergedPr,
      answersOwed: answersOwedBy(row).filter((owed) => owed !== session), repo: trackerRepo }) };
    const reading = readClaim(facts, { now, restartAt: restart, agents, ...rememberedFor({ entry: before[facts.row], session, row: facts.row, ledger, key }) });
    // A HOLDER THAT HAS WORK AND A BLOCKER is the EXPECTED hold and is not said every tick; only a read that could not be made is.
    if (reading.kind === "holding" && reading.expected !== true) {
      log(`claim-stall: ${where}${mention(facts.row)} (${session}) is HELD, not released: ${reading.why}.\n`);
    }
    if (reading.kind === "release" && reading.why === "gone") {
      log(`claim-stall: ${where}${mention(facts.row)} (${session}) is GONE from herdr's own listing -- releasing.\n`);
    }
    readings.push({ facts, reading });
    const verified = verifiedCloseOf({ row: facts.row, labels: labelsOf(row), session, facts, comments: byRow.get(Number(row.number)) ?? [], agents, now });
    if (verified !== null) closes.push(verifiedCloseOrderOf(verified, { session, subject: mention(facts.row), now }));
  }
  return { readings, skipped, closes };
}

/**
 * (agent-org#1536) THE GATE'S READING OF ONE CLAIMED ROW for the verified close: `verifiedCloseOrder`'s, fed the holder's idle run the way the claim-stall reading
 * has it -- `idleClaimantReading` on the same facts and herdr's listing. `idleSince` is the row's last move, as `org-health.ts` gives it, so an idle holder's run
 * is at least that long. A holder that is busy, waiting on a declared field, or whose listing could not be read is not idle, and its row is not ordered closed.
 */
function verifiedCloseOf({ row, labels, session, facts, comments, agents, now }: { row: number; labels: string[]; session: string; facts: import("../claim-stall.ts").ClaimFacts;
  comments: any[]; agents: { label: string; status: string; }[] | null; now: number; }): VerifiedCloseOrder | null {
  // a commit or push git will not answer for is not a move that can be dated, so the row is not ordered closed this tick (as `movesOfTick` skips it)
  let lastMove: number;
  try {
    lastMove = Math.max(facts.claimedAt, facts.comment ?? 0, facts.commit() ?? 0, facts.push() ?? 0);
  } catch (err) {
    if (err instanceof Unreadable) return null;
    throw err;
  }
  const idle = idleClaimantReading({ session, prs: withRedChecks(facts.ownPrs), built: facts.nothing !== true, waitKinds: facts.waitKind ? [facts.waitKind] : [] },
    { now, agents, idleSince: lastMove });
  if (idle.kind !== "watching" && idle.kind !== "stall") return null;
  return verifiedCloseOrder({ row, labels, claimant: session, claim: claimRecordOf(comments), comments, idleSince: idle.since }, { now });
}

/**
 * (agent-org#1536) THE ORDER a {@link VerifiedCloseOrder} becomes: a prompt to `product-manager` (the reader that closes rows the claimant read as done), naming the
 * note and how long it has stood, so the close is checkable by whoever reads it. `discriminator` is the note, so a new note is a new order and the same one is not repeated.
 */
function verifiedCloseOrderOf(close: VerifiedCloseOrder, { session, subject, now }: { session: string; subject: string; now: number; }): import("../claim-stall.ts").StallOrder {
  const minutes = Math.floor((now - close.verifiedAt) / 60_000);
  return { session: close.to, cause: "verified-close", subject, discriminator: close.note, causeKey: `verified-close:${close.row}`,
    prompt: `${subject} IS CLAIMED BY ${session}, WHICH WROTE "VERIFIED" (OR ITS DONE-WHEN ITEMS AS MET) ON IT ${minutes} MINUTES AGO AT ${close.note}, AND HAS BEEN IDLE SINCE. `
      + `THE ROW IS YOURS TO CLOSE: read each Done-when item against that note and the comments it names. If every item is met, close the row (\`gh issue close\`) with a comment that names `
      + "each item and the comment holding its reading. If one is not met, say which, and do not close it." };
}

/**
 * What the memory says about ONE claim's holder, as the reading's context: the nudge it was sent (with its delivery, read from the wake ledger),
 * the tick its session was first found gone, and the tick it was first found idle (#2999). A memory written for ANOTHER session is nobody's.
 * `key` is the row's tracker: the delivery is looked up under the key the order carried (`scopedCauseKey`), not under the home tracker's spelling of it.
 */
function rememberedFor({ entry, session, row, ledger, key }: { entry: import("../claim-stall.ts").StallState[string] | undefined; session: string; row: number; ledger: () => string; key: string; }) {
  const remembered = entry?.session === session ? entry : undefined;
  // agent-org#743: `nudges` is how many unanswered nudges this stall has had, absent for the first
  const nudge = remembered?.nudgedAt !== undefined ? { nudgedAt: remembered.nudgedAt, idle: remembered.idle === true,
    deliveredAt: nudgeDeliveredAt(ledger(), scopedCauseKey(key, nudgeKey(session, row, remembered.nudgedAt))),
    ...(remembered.nudges === undefined ? {} : { count: remembered.nudges }) } : null;
  return { nudge, goneSince: remembered?.goneSince ?? null, idleSince: remembered?.idleSince ?? null };
}

export const stallOrdersOrNone = (orders: import("../claim-stall.ts").StallOrder[] | undefined) => orders ?? [];

/** The wake ledger's text, `""` when it cannot be read. */
function ledgerText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * `claimStallTick` with its API-facing inputs read HERE, so `main` stays a list of reads: the merged-PR list is paid only when some row is
 * claimed (`GH_READS.conditionalOnClaimedBranches`). THE OPEN ROWS AND THE OPEN PULL REQUESTS ARE PASSED RAW, `null` for a refusal: with either
 * missing nothing is evaluated and nothing is written. A refused pull-request read coalesced to "none open" would read a holder whose PR is in
 * review as one with no PR at all (nudged, or, with a `blockedBy` edge, released), and a refused row read would empty the nudge memory.
 */
export function claimStallsNow(rows: any[] | null, claimedComments: any[] | null, prs: any[] | null, { tick = claimStallTick, merged = readMergedPrs, elsewhere = readElsewherePrs,
  log = (line) => process.stderr.write(line), onFacts, trackers, waitFacts, openRowsPaced = false }: {
        tick?: typeof claimStallTick; merged?: typeof readMergedPrs; elsewhere?: typeof readElsewherePrs; log?: (line: string) => void;
        onFacts?: OnClaimFacts; trackers?: () => TrackerClaims[]; waitFacts?: WaitFacts | null;
        /** agent-org#1401: the open rows were NOT ASKED (the pacing skipped the primary's lanes), so their `null` is a skip and not a refusal. */
        openRowsPaced?: boolean;
    } = {}) {
  if (rows === null && openRowsPaced && prs !== null) {
    log("claim-stall: the open rows were skipped by pacing this tick -- NO claim was evaluated.\n");
    onFacts?.(null);
    return [];
  }
  if (rows === null || prs === null) {
    log(`claim-stall: the ${rows === null ? "open rows" : "open pull requests"} could not be read -- NO claim was evaluated this tick.\n`);
    onFacts?.(null);
    return [];
  }
  // agent-org#747: every OTHER declared tracker's claimed rows, asked for here and not in `work-gate.ts`, so that what a tick reads is what it evaluates. A
  // thrown read is a tracker said as unread (`rows: null`) by `claimStallTick`, and never an empty list.
  const others = trackers === undefined ? [] : trackers();
  const anyClaimed = rows.some((r) => labelsOf(r).includes(CLAIM_LABEL)) || others.some((t) => (t.rows ?? []).some((r) => labelsOf(r).includes(CLAIM_LABEL)));
  return tick({ rows, claimedComments, openPrs: prs, mergedPrs: anyClaimed ? merged() : null, ...(anyClaimed ? { elsewhere: elsewhere() } : {}),
    ...(onFacts === undefined ? {} : { onFacts }), ...(others.length === 0 ? {} : { trackers: others }), ...(waitFacts === undefined ? {} : { waitFacts }) });
}

/**
 * #3535: A CLOSED ROW'S CLAIM, as orders -- the release, and for a `worker-<n>` caught mid-turn the interrupt that rides it. The read was made by the gate's
 * follow-ups wave (`closedClaimsWhenWorkerListed`), with herdr's listing it was decided from, so this makes NO call: `null` is "not asked" (herdr listed no
 * per-row instance) and yields nothing, and `{ rows: null }` is said as unread by `closedClaimOrders`, never read as "no closed claim".
 * The per-row instance is `worker-<n>`, the roster's own family (`familyNumber`): a standing seat is released and never interrupted by this cause.
 */
export function closedClaimsNow(closed: { rows: import("../claim-stall.ts").ClosedClaimedRow[] | null; agents: { label: string; status: string; }[] | null; } | null, { repo = REPO_CHECKOUT, isInstance = (session) => familyNumber(session) !== null,
  log = (line) => process.stderr.write(line), trackerRepo, stateDir, read = (path) => readJsonObject(path), write = (path, lines) => writeJsonObject(path, lines) }: { repo?: string; isInstance?: (session: string) => boolean; log?: (line: string) => void; trackerRepo?: string;
  stateDir?: string; read?: (path: string) => ClosedLines; write?: (path: string, lines: ClosedLines) => void; } = {}): import("../claim-stall.ts").StallOrder[] {
  if (closed === null) return [];
  // #1463: the own-pull-request line is said once per stand, and the memory of it lives in its own file beside the stall memory. Without a `stateDir` there is
  // no memory, so the line is said each time asked (the fixtures that pass none keep their old behaviour). A tracker's entries are its own: another tracker's
  // are kept as they were, and an entry this tick did not say is gone, so a stand that ended is said again if it ever comes back.
  if (stateDir === undefined || closed.rows === null) return closedClaimOrders({ ...closed, repo, isInstance, log, trackerRepo });
  const path = `${stateDir}/${CLOSED_CLAIM_LINES_FILE}`;
  const before = read(path);
  const once = { before, after: {} as Record<string, string> };
  const orders = closedClaimOrders({ ...closed, repo, isInstance, log, trackerRepo, once });
  const prefix = `${trackerRepo ?? ""}#`;
  const kept = Object.fromEntries(Object.entries(before).filter(([key]) => !key.startsWith(prefix)));
  const after = { ...kept, ...once.after };
  if (JSON.stringify(after) !== JSON.stringify(before)) write(path, after);
  return orders;
}

/** #1463: the own-pull-request lines the last tick said, one stand per row (`closedClaimsNow`). */
export const CLOSED_CLAIM_LINES_FILE = "closed-claim-lines.json";
/** #1463: `tracker#row` -> the stand (`session#pull request`) its line was said for. */
type ClosedLines = Record<string, string>;
