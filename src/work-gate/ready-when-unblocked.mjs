// @ts-check
// A ROW WHOSE LAST BLOCKER CLOSED IS PROMOTED BY THE GATE, WITH NO MODEL, WHEN ITS FILER DECLARED IT SO (a11ign/a11ign#4064, #4055 move 1a).
//
// BEFORE THIS, every such row cost `product-manager` a wake (`unclaimed-blocker-cleared`: 118 wakes over 96 rows and $115.43 in the trace store, 2026-10-01..08) to answer a question the filer had
// already answered: "is this complete except for its edges?". A wait is data, so the permission is data: a body line `Ready-when-unblocked: yes`, written by whoever filed the row after the
// filing preflight. A closed edge is NOT proof the row is still true (#2905 was promoted on closed edges with a false premise), so the line is a declaration the gate then CHECKS, never a
// substitute for the checks.
//
// WHAT RUNS, IN ORDER, per row the tick already found cleared (`unclaimedClearings`, which is the "no remaining edge, `Not-before` or `answer:`" half and excludes claimed, `ready`, `parked` and
// `needs:chairman` rows): (1) the line; (2) the row's labels, READ FRESH, still say it is a plain `backlog` row and none of them means "not startable" or "not pickable"; (3) the LIVE body, read
// fresh, still declares the line, still has its waits clear, passes the claim rule's template check (`ineligibility`: Region, Acceptance, Open-check) and has no merged PR already naming it;
// (4) `row-file --promote`, which re-runs the filing rule (`fileRefusalReason`) on the live body once more and owns the Status move, the label set and the read-back. A refusal at ANY step leaves
// the row exactly as it was, so the caller's order to `product-manager` is today's, unchanged.
//
// A LEAF AT LOAD TIME, like `unpark-satisfied.mjs`: no import of `work-gate.mjs` (which imports this), so the clearings and the not-startable list are passed in.
import { ANSWER_PREFIX, BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL } from "../project-vocabulary.mjs";
import { CLAIM_LABEL, READY_LABEL } from "../claim-labels.mjs";
import { REPO } from "../project-identity.mjs";
import { githubIo, ineligibility, mergedClosersOf, PARKED } from "../unpark-satisfied.mjs";
import { waitingOn } from "../waiting-condition.mjs";

/** The body line a filer writes. A heading prefix is tolerated, the value is exactly `yes` (any other word is not a declaration). */
const DECLARATION = /^[ \t]*#{0,6}[ \t]*Ready-when-unblocked:[ \t]*yes[ \t]*$/im;
/** The log line's tail, which the Open-check's PROMOTED count greps for. */
export const PROMOTED_REASON = "blockers cleared, Ready-when-unblocked";

/**
 * @typedef {{ labels: string[], state: string, body: string }} LiveRow
 * @typedef {{ read: (number: number) => LiveRow, mergedClosers: (number: number) => { number: number, mergedAt: string }[],
 *            promote: (number: number) => { ok: true } | { ok: false, refusal: string } }} ReadyIo
 * @typedef {{ promoted: number[], kept: { number: number, reason: string }[], errors: { number: number, message: string }[] }} ReadyResult
 */

/** @param {unknown} body @returns {boolean} does the row declare that it is complete except for its edges */
export const declaresReadyWhenUnblocked = (body) => DECLARATION.test(String(body ?? ""));

/** @param {any} row @returns {string[]} */
const labelsOf = (row) => (row?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));

/**
 * WHY A FRESHLY READ ROW IS NOT THIS MODULE'S TO PROMOTE, or `null`. The tick's copy is seconds old; a label or an amendment made since is exactly the "since" the body check exists for.
 * @param {number} number @param {LiveRow} live @param {any} tickRow @param {readonly string[]} notStartable @param {number} now @returns {string | null}
 */
function notPromotable(number, live, tickRow, notStartable, now) {
  if (live.state !== "OPEN") return `#${number} is ${live.state}`;
  const standing = [CLAIM_LABEL, READY_LABEL, PARKED, NEEDS_CHAIRMAN_LABEL, ...notStartable].filter((l) => live.labels.includes(l));
  const answer = live.labels.find((l) => l.startsWith(ANSWER_PREFIX));
  if (standing.length > 0 || answer) return `it now carries ${[...standing, ...(answer ? [answer] : [])].map((l) => `\`${l}\``).join(", ")}`;
  if (!live.labels.includes(BACKLOG_LABEL)) return `it no longer carries \`${BACKLOG_LABEL}\``;
  if (!declaresReadyWhenUnblocked(live.body)) return "its body no longer declares `Ready-when-unblocked: yes`";
  const waiting = waitingOn({ labels: live.labels.map((name) => ({ name })), body: live.body, blockedBy: tickRow.blockedBy }, undefined, now);
  return waiting === null ? null : `it is waiting again (${waiting.kind})`;
}

/**
 * ONE ROW: the checks, then the promotion. THROWS on a failed read or an unexpected promote failure, which the caller records NAMING the row.
 * @param {{ row: any }} clearing @param {ReadyIo} io @param {readonly string[]} notStartable @param {number} now @returns {string | null} why the row was left alone, or `null` when promoted
 */
function tryPromote({ row }, io, notStartable, now) {
  const number = Number(row.number);
  const live = io.read(number);
  const why = notPromotable(number, live, row, notStartable, now) ?? ineligibility({ number, body: live.body }, live.labels, io.mergedClosers);
  if (why !== null) return why;
  const promoted = io.promote(number);
  return promoted.ok ? null : promoted.refusal;
}

/**
 * PROMOTE EVERY CLEARED ROW THAT DECLARED `Ready-when-unblocked: yes` AND STILL PASSES. A row without the line is not mentioned at all (today's order for it is unchanged). A failure on one row is an
 * error NAMING it and the pass goes on. The tick's own row object gets the labels it now has, so the order cause that runs next in the same tick does not offer the row it has just promoted.
 * @param {{ clearings: { row: any }[], notStartable: readonly string[], now: number }} input @param {ReadyIo} io @returns {ReadyResult}
 */
export function promoteReadyWhenUnblocked({ clearings, notStartable, now }, io) {
  /** @type {ReadyResult} */
  const result = { promoted: [], kept: [], errors: [] };
  for (const clearing of clearings) {
    if (!declaresReadyWhenUnblocked(clearing.row.body)) continue;
    const number = Number(clearing.row.number);
    try {
      const why = tryPromote(clearing, io, notStartable, now);
      if (why === null) {
        result.promoted.push(number);
        clearing.row.labels = [READY_LABEL, ...labelsOf(clearing.row).filter((l) => l !== BACKLOG_LABEL)].map((name) => ({ name }));
      } else result.kept.push({ number, reason: why });
    } catch (error) {
      result.errors.push({ number, message: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  return result;
}

/** @param {ReadyResult} result @param {(line: string) => void} log */
export function reportReadyWhenUnblocked(result, log) {
  for (const number of result.promoted) log(`PROMOTED #${number} (${PROMOTED_REASON})\n`);
  for (const { number, reason } of result.kept) log(`NOT PROMOTED #${number} (Ready-when-unblocked declared): ${reason.split("\n")[0]} -- product-manager is asked as before\n`);
  for (const { number, message } of result.errors) log(`COULD NOT promote #${number} (Ready-when-unblocked declared): ${message} -- product-manager is asked as before\n`);
}

/**
 * THE REAL WORLD, through the gate's own `gh` runner. The promotion is `unpark-satisfied`'s `promote` (a `row-file --promote` child), so there is one promotion act in the gate and not two.
 * @param {(args: string[]) => string} run @returns {ReadyIo}
 */
export function githubReadyIo(run) {
  const github = githubIo(run);
  return {
    read: (number) => {
      const read = JSON.parse(run(["issue", "view", String(number), "--repo", REPO, "--json", "labels,state,body"]));
      return { labels: (read.labels ?? []).map((/** @type {any} */ l) => String(l.name)), state: String(read.state), body: String(read.body ?? "") };
    },
    mergedClosers: (number) => mergedClosersOf(number, run),
    promote: github.promote,
  };
}
