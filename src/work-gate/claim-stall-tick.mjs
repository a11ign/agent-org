// @ts-check
// module: the claim-stall tick -- what the gate says to a session whose claim has stopped moving (#2898)
//
// MOVED OUT OF `work-gate.mjs`, NOT REWRITTEN (#2898, the fifth split of #928's lever 2a): `claimStallTick`, the
// claim evaluation it runs, the declared-wait reading that excuses a quiet claim, and the helpers only they use.
// Measured on #2898: a row waited behind three pull requests in a day for edits to exactly these definitions.
//
// THE BOUNDARY, as `work-gate/pr-orders.mjs` states it: what only this family uses lives here; what a family that
// stayed behind also uses (`readPrs`, `readClaimedRowComments`, `readMergedPrs`, `gitRun`) is IMPORTED from
// `work-gate.mjs`, the cycle that module documents, safe while nothing here reads an imported binding at load time.
// `withChecksPending` STAYED: it reads the PR rollup, and `org-health.test.ts`'s #2956 guard enlists any file that does.
// `work-gate.mjs` re-exports every name this file exports that it exported before.
import { labelsOf, REPO_CHECKOUT, REVIEWER_STATE_DIR, systemctlRun, openBlockers, withChecksPending, readMergedPrs,
  readElsewherePrs } from "../work-gate.mjs";
import { CLAIM_LABEL } from "../claim-labels.mjs";
import { gitRun, pathExists, statMtime, readStallState, writeStallState, STALL_STATE_FILE, nextStallState,
  claimStalledOrders, readHerdrRestart, claimFactsFrom, readClaim, nudgeDeliveredAt, nudgeKey } from "../claim-stall.mjs";
import { readAgents } from "../herdr-agents.mjs";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL, SESSION_PREFIX } from "../project-vocabulary.mjs";
import { waitingOn, fleetWaitingOn, describeWaiting } from "../waiting-condition.mjs";
import { homeProjectDeclaration } from "../project-config.mjs";
import { readFileSync } from "node:fs";

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
 * @param {any} row @param {string} holder @returns {string | null}
 */
function declaredWait(row, holder) {
  return declaredWaitOf(row, holder)?.phrase ?? null;
}

/**
 * `declaredWait`'s decision with its KIND, which is the `WAIT_FIELDS` key `idle-claimant.mjs` counts as a field (#2999): ONE decider for "this
 * row has a wait field", so the idle reading and the clock reading cannot disagree about a row. `blocked` (the label) is not a kind: it names
 * no referent. `fleet-hold` is a `Fleet-hold-until:` line, whose second meaning -- a claim on the workers -- nothing else reads.
 * @param {any} row @param {string} holder @returns {{ kind: string, phrase: string } | null}
 */
function declaredWaitOf(row, holder) {
  if (labelsOf(row).includes(CHAIRMAN_LABEL)) return { kind: "chairman", phrase: `waiting on the chairman (${CHAIRMAN_LABEL})` };
  const waiting = waitingOn({ ...row, blockedBy: { nodes: [] } }) ?? fleetWaitingOn(row);
  if (waiting === null || (waiting.kind === "answer" && waiting.session === holder)) return null;
  const kind = waiting.kind === "date" ? "not-before" : waiting.kind === "row" ? "blocked-by" : waiting.kind;
  return { kind, phrase: describeWaiting(waiting) };
}

/**
 * @typedef {{ claimedAt: number, comment: number | null, commit: number | null, push: number | null,
 *   openPrs: { createdAt?: string, labels?: ({ name?: string } | string)[] }[], mergedAt: number | null }} ClaimMoves what a claim's holder has DONE, as plain data: the times
 *   of the claim and of the holder's newest comment, commit and push, the pull requests that are the claim's own (`ownsPr`, in every tracked repository) and the
 *   merge of one since the claim. Data and not `ClaimFacts`, whose `file` and `work` are thunks that a Map in `decide`'s arguments could not carry through the shadow tap
 * @typedef {{ moves: Map<number, ClaimMoves>, skipped: Map<number, string> }} ClaimFactsOfTick every claimed row's moves, and for the rows whose facts could not be
 *   built the reason (`skipped`): a row in neither is one this tick did not evaluate at all
 * @typedef {(facts: ClaimFactsOfTick | null) => void} OnClaimFacts `null` is a tick that evaluated NO claim (a refused read), never "no claims"
 */

/** @param {import("../claim-stall.mjs").ClaimFacts} facts @returns {ClaimMoves} */
function movesOf(facts) {
  return { claimedAt: facts.claimedAt, comment: facts.comment, commit: facts.commit, push: facts.push,
    openPrs: (facts.ownPrs ?? []).map((/** @type {any} */ pr) => ({ createdAt: pr.createdAt, labels: pr.labels })),
    mergedAt: facts.mergedPr?.mergedAt ?? null };
}

/**
 * THE WHOLE OF `claim-stalled` FOR ONE TICK: read every claimed row, decide, keep the nudge memory, and return the orders
 * (a nudge to a holder; a RELEASE that `wake.mjs` performs).
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
 *
 * @param {{ rows: any[], claimedComments: any[] | null, openPrs: any[], mergedPrs: any[] | null,
 *   elsewhere?: import("../claim-stall.mjs").ElsewherePrs, io?: import("../claim-stall.mjs").HostReads, repo?: string, now?: number, restartAt?: number | null,
 *   agents?: {label: string, status: string}[] | null,
 *   stateDir?: string, log?: (line: string) => void, ledger?: () => string,
 *   read?: typeof readStallState, write?: typeof writeStallState, onFacts?: OnClaimFacts }} args
 * @returns {import("../claim-stall.mjs").StallOrder[]}
 */
export function claimStallTick({ io = { git: gitRun, exists: pathExists, mtime: statMtime }, repo = REPO_CHECKOUT, now = Date.now(),
  stateDir = REVIEWER_STATE_DIR, log = (line) => process.stderr.write(line), read = readStallState, write = writeStallState, ...inputs }) {
  try {
    return evaluateClaims({ ...inputs, io, repo, now, stateDir, log, read, write });
  } catch (/** @type {any} */ err) {
    log(`claim-stall: could not run (${String(err?.message ?? err).split("\n")[0]}) -- no claim-stalled order this tick.\n`);
    inputs.onFacts?.(null);
    return [];
  }
}

/**
 * `claimStallTick`'s body, with every default resolved by its caller. NEVER CALLED WITHOUT THE CATCH ABOVE: a throw here is the tick's to report.
 * @param {{ rows: any[], claimedComments: any[] | null, openPrs: any[], mergedPrs: any[] | null, restartAt?: number | null,
 *   elsewhere?: import("../claim-stall.mjs").ElsewherePrs, agents?: {label: string, status: string}[] | null,
 *   ledger?: () => string, io: import("../claim-stall.mjs").HostReads, repo: string, now: number, stateDir: string,
 *   log: (line: string) => void, read: typeof readStallState, write: typeof writeStallState, onFacts?: OnClaimFacts }} args
 */
function evaluateClaims({ rows, claimedComments, openPrs, mergedPrs, elsewhere, restartAt, agents, ledger, io, repo, now, stateDir, log, read, write, onFacts }) {
  const held = rows.filter((r) => labelsOf(r).includes(CLAIM_LABEL));
  if (held.length > 0 && claimedComments === null) {
    log("claim-stall: the comments on the claimed rows could not be read -- NO claim was evaluated this tick.\n");
    onFacts?.(null);
    return [];
  }
  const statePath = `${stateDir}/${STALL_STATE_FILE}`;
  const before = read(statePath);
  const byRow = new Map((claimedComments ?? []).map((r) => [Number(r?.number), r?.comments ?? []]));
  const { readings, skipped } = readClaims({ held, byRow, openPrs, mergedPrs, elsewhere, io, repo, now, before, log,
    ledger: ledger ?? (() => ledgerText(`${stateDir}/wake-ledger`)), restart: restartFor(held, restartAt),
    agents: agentsFor(held, agents) });
  onFacts?.({ moves: new Map(readings.map(({ facts }) => [facts.row, movesOf(facts)])), skipped });
  const after = nextStallState(before, readings, now);
  if (after !== before) write(statePath, after);
  return claimStalledOrders(readings, now);
}

/**
 * The restart the no-progress clock may not precede: the caller's reading when it has one, else `systemctl`'s -- and only when
 * some row is claimed, so a quiet org spawns nothing.
 * @param {any[]} held @param {number | null | undefined} given @returns {number | null}
 */
function restartFor(held, given) {
  if (given !== undefined) return given;
  return held.length > 0 ? readHerdrRestart(systemctlRun) : null;
}

/**
 * The herdr workspace listing `goneReading` needs (#2747): the caller's reading when it has one, else a live `herdr
 * workspace list` -- and only when some row is claimed, so a quiet org makes no herdr call either. Mirrors `restartFor`
 * exactly, for the same testability reason this file's own header states about "who is free": a live default is a seam,
 * never the only path, so the gate stays runnable from CI on a fixture alone.
 * @param {any[]} held @param {{label: string, status: string}[] | null | undefined} given @returns {{label: string, status: string}[] | null}
 */
function agentsFor(held, given) {
  if (given !== undefined) return given;
  return held.length > 0 ? readAgents() : null;
}

/**
 * How many claimed rows each session holds: a pull request's `session:` label names a session, which is a claim's own only for a session holding one (#3445).
 * @param {any[]} held @returns {Map<string, number>}
 */
function rowsPerSession(held) {
  const counts = new Map();
  for (const row of held) {
    for (const label of labelsOf(row).filter((/** @type {string} */ n) => n.startsWith(SESSION_PREFIX))) {
      const session = label.slice(SESSION_PREFIX.length);
      counts.set(session, (counts.get(session) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * @returns {{ readings: { facts: import("../claim-stall.mjs").ClaimFacts, reading: import("../claim-stall.mjs").Reading }[], skipped: Map<number, string> }}
 * @param {{ held: any[], byRow: Map<number, any[]>, openPrs: any[], mergedPrs: any[] | null,
 *   elsewhere?: import("../claim-stall.mjs").ElsewherePrs, io: import("../claim-stall.mjs").HostReads, repo: string, now: number, restart: number | null,
 *   agents: {label: string, status: string}[] | null,
 *   before: import("../claim-stall.mjs").StallState, log: (line: string) => void, ledger: () => string }} ctx
 */
function readClaims({ held, byRow, openPrs, mergedPrs, elsewhere, io, repo, now, restart, agents, before, log, ledger }) {
  /** @type {{ facts: import("../claim-stall.mjs").ClaimFacts, reading: import("../claim-stall.mjs").Reading }[]} */
  const readings = [];
  /** @type {Map<number, string>} the rows whose facts could not be built, with the reason `claimFactsFrom` gave (#3451) */
  const skipped = new Map();
  const heldBy = rowsPerSession(held);
  for (const row of held) {
    const sessions = labelsOf(row).filter((/** @type {string} */ n) => n.startsWith(SESSION_PREFIX));
    if (sessions.length !== 1) {
      log(`claim-stall: #${row.number} carries ${sessions.length} session labels -- not evaluated.\n`);
      continue;
    }
    const session = sessions[0].slice(SESSION_PREFIX.length);
    const facts = claimFactsFrom({ row: row.number, title: row.title, session, waiting: declaredWait(row, session),
      waitKind: declaredWaitOf(row, session)?.kind ?? null, blockedBy: openBlockers(row), comments: byRow.get(Number(row.number)) ?? [], openPrs: withChecksPending(openPrs), mergedPrs,
      trackerRepo: homeProjectDeclaration().tracker[0].repo, sessionRows: heldBy.get(session),
      ...(elsewhere === undefined ? {} : { elsewhere: { ...elsewhere, open: elsewhere.open === null ? null : withChecksPending(elsewhere.open) } }), repo }, io);
    if ("skip" in facts) {
      log(`claim-stall: ${facts.skip} -- not evaluated.\n`);
      skipped.set(Number(row.number), facts.skip);
      continue;
    }
    const reading = readClaim(facts, { now, restartAt: restart, agents, ...rememberedFor({ entry: before[facts.row], session, row: facts.row, ledger }) });
    // A HOLDER THAT HAS WORK AND A BLOCKER is the EXPECTED hold and is not said every tick; only a read that could not be made is.
    if (reading.kind === "holding" && reading.expected !== true) {
      log(`claim-stall: #${facts.row} (${session}) is HELD, not released: ${reading.why}.\n`);
    }
    if (reading.kind === "release" && reading.why === "gone") {
      log(`claim-stall: #${facts.row} (${session}) is GONE from herdr's own listing -- releasing.\n`);
    }
    readings.push({ facts, reading });
  }
  return { readings, skipped };
}

/**
 * What the memory says about ONE claim's holder, as the reading's context: the nudge it was sent (with its delivery, read from the wake ledger),
 * the tick its session was first found gone, and the tick it was first found idle (#2999). A memory written for ANOTHER session is nobody's.
 * @param {{ entry: import("../claim-stall.mjs").StallState[string] | undefined, session: string, row: number, ledger: () => string }} args
 */
function rememberedFor({ entry, session, row, ledger }) {
  const remembered = entry?.session === session ? entry : undefined;
  const nudge = remembered?.nudgedAt !== undefined ? { nudgedAt: remembered.nudgedAt, idle: remembered.idle === true,
    deliveredAt: nudgeDeliveredAt(ledger(), nudgeKey(session, row, remembered.nudgedAt)) } : null;
  return { nudge, goneSince: remembered?.goneSince ?? null, idleSince: remembered?.idleSince ?? null };
}

/** @param {import("../claim-stall.mjs").StallOrder[] | undefined} orders */
export const stallOrdersOrNone = (orders) => orders ?? [];

/** The wake ledger's text, `""` when it cannot be read. @param {string} path */
function ledgerText(path) {
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
 * @param {any[] | null} rows @param {any[] | null} claimedComments @param {any[] | null} prs
 * @param {{ tick?: typeof claimStallTick, merged?: typeof readMergedPrs, elsewhere?: typeof readElsewherePrs, log?: (line: string) => void,
 *   onFacts?: OnClaimFacts }} [deps]
 */
export function claimStallsNow(rows, claimedComments, prs, { tick = claimStallTick, merged = readMergedPrs, elsewhere = readElsewherePrs,
  log = (line) => process.stderr.write(line), onFacts } = {}) {
  if (rows === null || prs === null) {
    log(`claim-stall: the ${rows === null ? "open rows" : "open pull requests"} could not be read -- NO claim was evaluated this tick.\n`);
    onFacts?.(null);
    return [];
  }
  const anyClaimed = rows.some((r) => labelsOf(r).includes(CLAIM_LABEL));
  return tick({ rows, claimedComments, openPrs: prs, mergedPrs: anyClaimed ? merged() : null, ...(anyClaimed ? { elsewhere: elsewhere() } : {}),
    ...(onFacts === undefined ? {} : { onFacts }) });
}
