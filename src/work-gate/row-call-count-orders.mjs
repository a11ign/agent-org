// @ts-check
// module: the row-call-count orders -- the gate asks a claimed row's session to split when its calls pass the threshold (#2898)
//
// MOVED OUT OF `work-gate.ts`, NOT REWRITTEN (#2898, the fourth split of #928's lever 2a): the live call-count signal
// (#2691), the assessed-calls marker a session leaves after judging, the order text, and the helpers only they use.
// Measured on #2898: six rows waited behind ONE pull request (#2819), and it edited nothing but these definitions.
//
// THE BOUNDARY, as `work-gate/pr-orders.mjs` states it: what only this family uses lives here; what a family that
// stayed behind also uses is IMPORTED from `work-gate.ts`, the cycle that module documents, safe while nothing here
// reads an imported binding at load time. `work-gate.ts` re-exports every name this file exports that it exported before.
import { labelsOf, holderWaitingOn, defaultRun, repoNow, PARKED_LABEL } from "../work-gate.ts";
import { claimRecordOf } from "../claim-stall.ts";
import { holdersOf, HOLD_PREFIX } from "../pr-hold-state.ts";
import { notBeforeDate, notBeforeIso, fleetHoldUntil, todayIso, ANSWER_PREFIX } from "../waiting-condition.ts";
import { SESSION_PREFIX, BLOCKED_LABEL, NEEDS_CHAIRMAN_LABEL } from "../project-vocabulary.ts";
import { subjectMention } from "../review-attribution.ts";
import { transcriptFiles, claudeTurns } from "../token-audit.ts";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * #2691: A CLAIMED ROW'S SESSION PAST THIS MANY CALLS on its OWN live transcript is a split CANDIDATE for
 * `product-manager`'s judgement, never an automatic split. The chairman's token-efficiency reading (#928,
 * 2026-09-27) measured p90 147 calls/session against a filing target of about 60.
 */
export const ROW_CALL_COUNT_SPLIT_THRESHOLD = 100;

/**
 * The session a still-open row is claimed by, from its own single `session:` label -- `null` for zero or
 * more than one, `readClaims`'s own refusal for the same reason: a row carrying an unexpected count is not
 * guessed at.
 * @param {any} row
 */
export function claimedRowSession(row) {
  const sessions = labelsOf(row).filter((/** @type {string} */ n) => n.startsWith(SESSION_PREFIX));
  return sessions.length === 1 ? sessions[0].slice(SESSION_PREFIX.length) : null;
}

/**
 * The `{ row, session, at }` a claim record gives for every open row that carries one -- the raw material
 * `rowCallCountSignals` windows against, pulled out so that arithmetic has something to read rather than
 * re-deriving it inline. A row with no session label, or whose newest claim-record comment cannot be read
 * (none posted, or the newest one is a release) contributes nothing -- a window with nothing to anchor it
 * is never guessed at, `claimedRowSession`'s own rule for an ambiguous label count applied one step further.
 * @param {any[]} openRows @param {Map<number, any[]>} byRow
 * @returns {{ row: number, session: string, at: number, record: any }[]}
 */
function claimedRowAnchors(openRows, byRow) {
  const anchors = [];
  for (const row of openRows) {
    const session = claimedRowSession(row);
    if (session === null) continue;
    const record = claimRecordOf(byRow.get(Number(row.number)) ?? []);
    if (record === null) continue;
    anchors.push({ row: Number(row.number), session, at: record.at, record: row });
  }
  return anchors;
}

/**
 * When `anchor`'s window closes: `Infinity`, unless the SAME session claims ANOTHER open row later, in
 * which case that later claim ends this one's window. #2710's second half -- a standing seat holding row A
 * and then claiming row B while still holding A must not keep charging A for calls made after B was
 * claimed, or A and B never stop reporting overlapping totals for the same later work.
 * @param {{ session: string, at: number }} anchor @param {{ session: string, at: number }[]} anchors
 */
function windowEnd(anchor, anchors) {
  const laterOwnClaims = anchors.filter((a) => a.session === anchor.session && a.at > anchor.at).map((a) => a.at);
  return laterOwnClaims.length > 0 ? Math.min(...laterOwnClaims) : Infinity;
}

/**
 * Whether a CLAIMED row declares a wait, and so is not a candidate for a split: its calls are the session's other work, not
 * the row's (#3384; #2905's one open item was a word from the chairman and cost three audits).
 *
 * `holderWaitingOn` IS THE PREDICATE, NOT A SIXTH LIST: it is what `blockerClearedOrders` asks of the same population -- a CLAIMED
 * row -- and reads `blockedBy`, `Not-before:`, `Fleet-hold-until:`, `answer:<session>`, `needs:chairman` and `parked`. It does not
 * read `blocked` or a `hold:` label, so those two are added here. `readPromotableRows`' filter could not be reused whole: it is
 * inline in that reader, and its `NOT_STARTABLE` carries `in-progress`, which every row asked about here has.
 * @param {any} row @param {number} now
 */
export function rowDeclaresWait(row, now) {
  const labels = labelsOf(row);
  return holderWaitingOn(row, todayIso(new Date(now)), now) || labels.includes(BLOCKED_LABEL) || holdersOf(labels).length > 0;
}

/**
 * Whether `name` is a label that declares a wait -- the label half of `rowDeclaresWait`, for reading when one was lifted.
 * @param {string} name @returns {boolean}
 */
function isWaitLabel(name) {
  return [NEEDS_CHAIRMAN_LABEL, PARKED_LABEL, BLOCKED_LABEL].includes(name) || name.startsWith(HOLD_PREFIX) || name.startsWith(ANSWER_PREFIX);
}

/**
 * WHEN THE ROW'S LAST DECLARED WAIT WAS LIFTED, in epoch ms: `0` for none found (nothing to take off the claim's window), `null`
 * when the read was refused -- never `0`, which would read as "never waited" and charge the wait's calls to the row.
 *
 * Two sources, the latest wins: an `unlabeled` event for a wait label (`issues/{n}/events`, the cheaper subset of the timeline
 * `readEvidenceLabelledAt` also reads), and a `Not-before:` or `Fleet-hold-until:` that has now passed, whose own instant is the
 * clearing -- `rowDeclaresWait` reads both as a wait, so both must be datable or an expired hold keeps charging the hold's calls. A cleared
 * `blockedBy` edge is NOT dated: the events carry no close of the blocker, so that wait reads as `0`, today's behaviour.
 * @param {any} row @param {(args: string[]) => string} [run]
 * @returns {number | null}
 */
export function readWaitClearedAt(row, run = defaultRun) {
  try {
    const out = run(["api", `repos/${repoNow()}/issues/${Number(row.number)}/events`, "--paginate", "--jq",
      '.[] | select(.event == "unlabeled") | {name: .label.name, at: .created_at}']);
    const lifted = out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l))
      .filter((e) => isWaitLabel(String(e.name))).map((e) => Date.parse(e.at));
    const declared = notBeforeDate(row?.body);
    const held = fleetHoldUntil(row?.body);
    const passed = [declared === null ? NaN : Date.parse(notBeforeIso(declared)), held === null ? NaN : Date.parse(held)];
    return Math.max(0, ...lifted.filter(Number.isFinite), ...passed.filter(Number.isFinite));
  } catch (err) {
    console.error(`row-call-count-signal: could not read when #${row?.number}'s wait was lifted (${err instanceof Error ? err.message : err}); counting from the claim`);
    return null;
  }
}

/** The default `waitClearedAt`: no clearing known, so the window starts at the claim -- the behaviour before #3384. */
const notRead = () => 0;

/**
 * `anchor`'s calls from the later of its claim and the clearing of its last wait. The clearing is read ONLY for a row already
 * over the threshold from the claim (the read is one `gh` call, so it is never paid per tick for a row that cannot signal), and
 * a refused read keeps the whole window, which is the behaviour before #3384.
 * @param {{ row: number, at: number, record: any }} anchor
 * @param {{ count: (since: number) => number, threshold: number, waitClearedAt: (row: any) => number | null }} how
 */
function callsAfterWait(anchor, { count, threshold, waitClearedAt }) {
  const fromClaim = count(anchor.at);
  if (fromClaim <= threshold) return fromClaim;
  const cleared = waitClearedAt(anchor.record);
  return cleared === null || cleared <= anchor.at ? fromClaim : count(cleared);
}

/**
 * Every open row whose claimed session has passed `threshold` CALLS made WHILE HOLDING THAT ROW -- from
 * its own claim record's `createdAt` up to whichever comes first, now or the same session's NEXT claim,
 * never the claiming session's whole lifetime (#2710). A spawned engineer's transcript IS its one row's
 * work, so an unbounded, single-claim window changes nothing for it; a STANDING seat (`ceo`, `orchestrator`,
 * `product-manager`) holds several rows in sequence or at once, and its lifetime total kept climbing
 * regardless of which row it named -- the defect that reported the SAME figure on two different rows
 * `orchestrator` held at once.
 *
 * A ROW THAT DECLARES A WAIT IS LEFT OUT, AND A CLEARED WAIT IS NOT CHARGED (#3384). `rowDeclaresWait` names the row
 * that is only waiting; for one whose wait has been lifted the window starts at the lifting, so the calls a standing seat made
 * elsewhere while the row waited are not the row's. It is still the SAME session's next claim that ends a window, so the
 * anchors of waiting rows stay in the list for `windowEnd`.
 *
 * A SIGNAL, NOT A SPLIT (#2691): whether and how to split stays `product-manager`'s judgement, so this
 * reports the count and stops there. A row at or under the threshold is left out entirely -- this names
 * split CANDIDATES, not every claimed row.
 *
 * @param {any[]} openRows @param {import("../token-audit.ts").Turn[]} turns every live turn, any session
 * @param {any[] | null} [claimedComments] the comments on every claimed row (`readClaimedRowComments`'s
 *   own shape, `{ number, comments }[]`), read once by the caller and reused rather than re-fetched here
 * @param {{ threshold?: number, now?: number, waitClearedAt?: (row: any) => number | null }} [options]
 *   `waitClearedAt` is `readWaitClearedAt` -- passed by the gate's tick, and NOT the default: a default that reached `gh` would
 *   make every caller's test a live read of this tracker's issues (#3384), so the default counts from the claim.
 * @returns {{ row: number, session: string, calls: number }[]} most calls first
 */
export function rowCallCountSignals(openRows, turns, claimedComments = [], options = {}) {
  const { threshold = ROW_CALL_COUNT_SPLIT_THRESHOLD, now = Date.now(), waitClearedAt = notRead } = options;
  const byRow = new Map((claimedComments ?? []).map((r) => [Number(r?.number), r?.comments ?? []]));
  const anchors = claimedRowAnchors(openRows, byRow);
  const signals = [];
  for (const anchor of anchors) {
    if (rowDeclaresWait(anchor.record, now)) continue;
    const end = windowEnd(anchor, anchors);
    const count = (/** @type {number} */ since) => turns.filter((t) => t.session === anchor.session && t.at >= since && t.at < end).length;
    const calls = callsAfterWait(anchor, { count, threshold, waitClearedAt });
    if (calls <= threshold) continue;
    const assessedAt = rowCallCountAssessedCalls(byRow.get(anchor.row) ?? []);
    if (assessedAt !== null && calls < 2 * assessedAt) continue;
    signals.push({ row: anchor.row, session: anchor.session, calls });
  }
  return signals.sort((a, b) => b.calls - a.calls);
}

/** The comment `product-manager` posts to record a "not split" verdict, carrying the call count it was
 * made at -- `CLAIM_RECORD_MARKER`'s shape, a structured marker rather than prose, because nothing
 * re-parses every comment on every tick to recover a number written in English. */
export const ROW_CALL_COUNT_ASSESSED_MARKER = "<!-- row-call-count-signal: split assessment -->";
const ASSESSED_CALLS = /\bcalls=(\d+)\b/;

/**
 * The call count `product-manager` last assessed this row at, from the newest comment carrying
 * `ROW_CALL_COUNT_ASSESSED_MARKER` -- `null` for no such comment, or one whose count cannot be read
 * (`claimRecordOf`'s own rule: an assessment that cannot be read is never guessed at, so it signals again
 * rather than staying silent).
 * @param {any[]} comments
 * @returns {number | null}
 */
export function rowCallCountAssessedCalls(comments) {
  const newest = comments.filter((c) => String(c?.body ?? "").includes(ROW_CALL_COUNT_ASSESSED_MARKER)).at(-1);
  if (newest === undefined) return null;
  const match = ASSESSED_CALLS.exec(String(newest.body));
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * The body of the verdict comment `product-manager` posts on a row-call-count signal (#2762): the WRITER the
 * marker and `rowCallCountAssessedCalls` were specified without, so the marker and `calls=N` were typed by
 * hand and a hand-typed verdict with neither left the doubling guard nothing to compare against.
 *
 * `calls=N` comes straight after the marker and BEFORE the free-text note: `ASSESSED_CALLS` takes the first
 * match, so a note that happens to quote another `calls=` figure cannot displace the real one. A count that
 * is not a non-negative integer throws rather than posting a comment the reader would read back as `null`.
 * @param {{ calls: number, split: boolean, note?: string }} verdict `calls` is the figure named in the signal's prompt
 * @returns {string}
 */
export function formatRowCallCountAssessment({ calls, split, note = "" }) {
  if (!Number.isInteger(calls) || calls < 0) throw new RangeError(`calls must be a non-negative integer, got ${calls}`);
  const head = `${ROW_CALL_COUNT_ASSESSED_MARKER}\ncalls=${calls}\n${split ? "Split" : "One unit, not split"}.`;
  return note.trim() === "" ? head : `${head} ${note.trim()}`;
}

/**
 * ONE ORDER NAMING EVERY ROW PAST THE THRESHOLD -- `pipelineCodeownerReviewOrders`'s shape and for its
 * reason: the set is what makes the cause self-clearing, keyed on WHICH rows are still over it, so a row
 * that splits or closes leaves it out of the next key.
 *
 * THE KEY NAMES THE SET, NOT THE COUNT (#2721). A claimed session's call count rises on nearly every one of
 * its own turns, so keying on the counts (as this did before #2721) minted a new `causeKey` on almost every
 * tick even though the SET of rows over threshold had not changed -- `product-manager` re-derived an
 * identical "not split" verdict from scratch, repeatedly, on the same unchanged row. The call counts still
 * reach the reader, in `prompt`; only the dedup key drops them.
 * @param {{ row: number, session: string, calls: number }[]} [signals]
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function rowCallCountOrders(signals = []) {
  if (signals.length === 0) return [];
  const key = signals.map((s) => s.row).sort((a, b) => a - b).join(",");
  const named = signals.map((s) => `${subjectMention({ number: s.row })} (${s.session}, ${s.calls} calls)`).join(", ");
  return [{
    session: "product-manager",
    cause: "row-call-count-signal",
    subject: "row-call-count-signal",
    discriminator: key,
    prompt: `${signals.length} claimed row(s) have passed ${ROW_CALL_COUNT_SPLIT_THRESHOLD} calls on their `
      + `own session's live transcript, per the chairman's token-efficiency reading (#928, #2691): ${named}.\n`
      + "This is a signal, not an automatic split -- the work may genuinely be one unit. Read each row and "
      + "decide whether to split it; a row that is one unit says so in its own body rather than being split "
      + "to hit a number.",
    causeKey: `product-manager/row-call-count-signal/${key}`,
  }];
}

/**
 * How long a transcript may go unwritten and still be read as a LIVE session's (a11ign/a11ign#3566). The gate read all of `~/.claude/projects`
 * on every tick -- 3.2 GB, 29 s of CPU and most of the tick's 2.7 GB peak, measured -- and 91% of those bytes were in files nothing had written to
 * for a day. A file's newest turn cannot be later than its mtime, so a file older than the horizon holds no turn the horizon could count, and a
 * file touched within it is still read WHOLE. What the horizon can drop is a row whose session has been silent for more than a day: the gate
 * releases a claim that stops moving after about four hours (#2470), so that row is not live, and its count would only have been a stale one.
 */
export const LIVE_TRANSCRIPT_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Every turn across every live `claude` transcript under `root` -- the SAME read `token-audit.ts`'s own
 * CLI and `split-baseline.mjs` make, reused rather than duplicated. `[]` for a missing root or an
 * unreadable file: a session whose transcript cannot be read contributes no call to any row's count, which
 * under-reports rather than guesses -- `claudeTurns`'s own rule (a partial line is skipped, not fatal)
 * applied one level up. A file not written within `horizonMs` of `now` is not read at all (`LIVE_TRANSCRIPT_HORIZON_MS`).
 * @param {string} [root]
 * @param {{ now?: number, horizonMs?: number }} [options]
 */
export function liveClaudeTurns(root = join(process.env.HOME ?? "", ".claude", "projects"), options = {}) {
  const { now = Date.now(), horizonMs = LIVE_TRANSCRIPT_HORIZON_MS } = options;
  const turns = [];
  for (const file of transcriptFiles(root)) {
    try {
      if (statSync(file).mtimeMs < now - horizonMs) continue;
      turns.push(...claudeTurns(readFileSync(file, "utf8")));
    } catch { /* unreadable: this row's count under-reports, never guessed at */ }
  }
  return turns;
}
