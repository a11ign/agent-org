// @ts-check
// A CLAIM THAT DOES NOT MOVE, AND NOTHING THAT SAID SO -- #2470.
//
// `ceo`'s ruling on #2407 (2026-09-25): a row carried `session:worker-7` while `../wt-2407` held 215 lines
// uncommitted, unpushed, no pull request, last file change seven hours before -- and the session was BUSY the whole
// time, on another row. A status check says "working" and is right; THE ROW is what had stalled. Nothing in the gate
// read a claim going unmoved, and the one nudge that worked cost a `ceo` turn spent reading a pane.
//
// THIS FILE IS THE PURE HALF, AND A LEAF: it imports only `node:*`, the git-env scrubber, `claim-labels.ts` and the
// shared `herdr-agents.ts` leaf, so `work-gate.ts` (which runs before any `pnpm install`) and `wake.ts` can both import
// it without one importing the other. It DECIDES; the gate carries the decision as an order and `wake.ts` performs
// the parts that need a pane.
//
// FIVE THINGS LIVE HERE, EACH THE ANSWER TO ONE DONE-WHEN (#2470's, or #2747's):
//   1. THE READING (`claimReading`): nudge, then release, on no progress on THE ROW for `STALL_INTERVAL_MS`.
//   2. THE RELEASES THAT ARE NOT A STALL: a claim whose row is BLOCKED and whose holder holds nothing (8), one whose
//      pull request MERGED while the row stayed open (10), and one whose SESSION IS GONE (#2747, `goneReading`).
//      Same predicate for "holds nothing" as the stall's keep-work.
//   3. THE READINGS OF A HOST EVENT: the `herdr.service` restart (11) and an interrupted pane (9).
//   4. THE STATE THE SECOND READING NEEDS: a released row carries no memory of the first nudge unless it is written
//      down, and it is written down in `claim-stalls.json`, beside the wake ledger. The same file remembers when a
//      holder was first found gone (#2747), so a transient partial listing cannot manufacture a release.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ANSWER_PREFIX, SESSION_PREFIX } from "./project-vocabulary.ts";
import { idleLimitMs, idleNudgePrompt, stoppedNudgePrompt, declareNudgePrompt, isStoppedHolder, redOwnPrs, redCheckNudgePrompt, unansweredNudgeNote } from "./idle-claimant.ts";
import { recordFailures, type FailureEvent, type RecordResult } from "./failure-ledger.ts";
import { herdrAgentName } from "./herdr-agents.ts";
import { ownsPr } from "./pr-ownership.ts";
import { pausedNow } from "./account-limit.ts";
import { claimRecordOf, type RowComment } from "./claim-record.ts";
import { CLAIM_STALLED, DONE_FOOTER, INTERRUPTED_TEXT, MINUTE_MS, RESTART_RESEND_WINDOW_MS, STALL_INTERVAL_MS, THRASH_TEXT, once, prMention, readJsonObject, type ClaimFacts, type Reading, type StallState, withRedChecks } from "./claim-stall/stall-causes-and-claim-readings.ts";

/**
 * The nudge memory, from `claim-stalls.json`.
 * @param {string} path @param {typeof readFileSync} [read] @returns {StallState}
 */
export function readStallState(path: string, read: typeof readFileSync = readFileSync): StallState {
  return readJsonObject(path, read);
}

/**
 * The memory after this tick's readings: a NUDGE is recorded at `now`, a `nudged` row keeps its record (and so does a STALL release
 * that is not yet performed), a `vacating` row (#2747) keeps the tick its session was FIRST found gone (and so does a GONE release
 * that is not yet performed), and every other row -- moving, no longer claimed by that session, or a session that reappeared -- loses
 * its memory, so a row that stalls (or vacates) a second time is a first reading again and not a release on the strength of last
 * week's nudge (or an old absence a listing has since taken back).
 *
 * @param {StallState} before
 * @param {{ facts: ClaimFacts, reading: Reading }[]} readings @param {number} now
 * @returns {StallState}
 */
export function nextStallState(before: StallState, readings: { facts: ClaimFacts; reading: Reading; }[], now: number): StallState {
  const after: StallState = {};
  for (const { facts, reading } of readings) {
    const memory = memoryOf(reading, now);
    if (memory !== null) after[facts.row] = { session: facts.session, ...memory };
  }
  return JSON.stringify(after) === JSON.stringify(before) ? before : after;
}

/**
 * What one reading leaves in the memory, or `null` for nothing. A NUDGE is recorded at `now` (`idle` when it was the idle-claimant's, #2999), a
 * `nudged` one keeps its record, an `idle-watch` the tick the holder was first found idle, a `vacating` one the tick it was first found gone.
 *
 * A STALL RELEASE THAT HAS NOT YET BEEN PERFORMED KEEPS ITS MEMORY: `wake.ts` performs it after this tick, may fail (a workspace that will
 * not close, a decline that is refused), and the gate emits the order again next tick -- which must read as the SECOND reading again, not
 * forget the nudge and start a fresh two hours. Once performed the row is no longer claimed and the entry goes with it. A GONE RELEASE THAT HAS
 * NOT YET BEEN PERFORMED keeps its `goneSince` for the same reason.
 * @param {Reading} reading @param {number} now @returns {{ nudgedAt?: number, goneSince?: number, idleSince?: number, idle?: boolean } | null}
 */
function memoryOf(reading: Reading, now: number): { nudgedAt?: number; goneSince?: number; idleSince?: number; idle?: boolean; nudges?: number; } | null {
  const idle = "idle" in reading && reading.idle ? { idle: true } : {};
  // (agent-org#743) the count of unanswered nudges in this stall; ABSENT is 1, so the first nudge of a stall writes what it always wrote
  const nudges = "count" in reading && reading.count !== undefined && reading.count > 1 ? { nudges: reading.count } : {};
  if (reading.kind === "nudge") return { nudgedAt: now, ...idle, ...nudges };
  if (reading.kind === "nudged") return { nudgedAt: reading.nudgedAt, ...idle, ...nudges, ...(reading.idleSince === undefined ? {} : { idleSince: reading.idleSince }) };
  if (reading.kind === "idle-watch") return { idleSince: reading.since };
  if (reading.kind === "vacating") return { goneSince: reading.since };
  if (reading.kind !== "release") return null;
  if (reading.why === "stalled" && reading.nudgedAt !== null) return { nudgedAt: reading.nudgedAt, ...idle, ...nudges, ...(reading.idleSince === undefined ? {} : { idleSince: reading.idleSince }) };
  if (reading.why === "gone" && reading.since !== undefined) return { goneSince: reading.since };
  return null;
}

/**
 * Write a memory ATOMICALLY (a temp file and a rename), because two processes read these files -- the gate and the tick -- and a
 * half-written one must read as the previous one, and never as an empty object.
 * @param {string} path
 * @param {object} state
 * @param {(path: string, data: string) => void} [writer] a seam, so a test writes nowhere
 */
export function writeJsonObject(path: string, state: object, writer: (path: string, data: string) => void = writeFileSync) {
  mkdirSync(dirname(path), { recursive: true });
  writer(`${path}.tmp`, `${JSON.stringify(state)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** @param {string} path @param {StallState} state @param {(path: string, data: string) => void} [writer] */
export function writeStallState(path: string, state: StallState, writer: (path: string, data: string) => void = writeFileSync) {
  writeJsonObject(path, state, writer);
}

// --- THE ORDERS -----------------------------------------------------------------------------------------------------

/** @param {number} ms */
const minutes = (ms: number) => Math.round(ms / MINUTE_MS);

/**
 * `interrupt` (#3535) is a closed row's per-row instance caught mid-turn: the performer stops it, with no prompt
 *
 * `tracker` (agent-org#834) is the declared key of the tracker the row is in, and ABSENT for the home tracker's: `row` is a number in THAT tracker's
 * repository, so the performer reads its labels, posts its comment and declines it there. The tick that read the row fills it (`claim-stall-tick.ts`).
 */
export type ReleaseRequest = { row: number, tracker?: string, session: string, why: "stalled" | "blocked" | "merged" | "gone" | "closed" | "wait", branch: string | null, worktree: string | null, idleMinutes: number | null, nudgedAt: number | null, edges?: number[], waiting?: string, mergedPr?: number, mergedPrRepoKey?: string, mergedPrHead?: string, openPrs?: number[], openPrRepoKeys?: (string | undefined)[], answer?: string, interrupt?: boolean, nudges?: number };
export type StallOrder = { session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string, title?: string, release?: ReleaseRequest, resume?: boolean };

/**
 * The nudge to an IDLE holder (#2999): the same cause, key and delivery as {@link nudgeOrder}'s -- so the ledger, the offer window and the
 * second reading's release are ONE mechanism -- with the text that spells the wait fields. A holder re-offered the nudge (not yet delivered)
 * is told the floor, `IDLE_CLAIMANT_MINUTES`, because only the first reading knew how long it had been idle.
 * @param {ClaimFacts} facts @param {number} nudgedAt @param {number} idleMs @returns {StallOrder}
 */
function idleNudgeOrder(facts: ClaimFacts, nudgedAt: number, idleMs: number, nudge = 1): StallOrder {
  const what = { row: facts.row, branch: facts.branch, idleMinutes: minutes(idleMs), releaseMinutes: minutes(STALL_INTERVAL_MS), canRelease: facts.openPrs === 0 };
  const built = facts.nothing !== true;
  // (agent-org#743) a holder idle on a RED pull request of its own is told which checks and to fix them, whatever it declared; any other holder with a pull request
  // open is told the count beside the text it always had (those three are pinned, and their "nothing is released" sentence is the one the count amends)
  const red = built ? redOwnPrs(withRedChecks(facts.ownPrs)) : [];
  const counted = built && facts.openPrs > 0;
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `idle-nudge-${nudgedAt}`,
    // #458: a holder the stopped clock applies to is told to CONTINUE; the text is chosen from the same facts the reading was
    prompt: red.length > 0 ? redCheckNudgePrompt({ row: facts.row, branch: facts.branch, idleMinutes: what.idleMinutes, red, nudge })
      : (facts.declared !== undefined && built ? declareNudgePrompt({ ...what, declared: facts.declared })
        : isStoppedHolder({ built, prs: facts.ownPrs }) ? stoppedNudgePrompt(what) : idleNudgePrompt(what)) + (counted ? `\n${unansweredNudgeNote(nudge)}` : ""),
    causeKey: nudgeKey(facts.session, facts.row, nudgedAt), resume: true,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

/**
 * The nudge, to the holder: NAMES THE ROW AND THE INTERVAL (Acceptance 1), says what counts as a move so it can be
 * answered in one command, and says what happens if it is not -- including that the work is KEPT.
 *
 * KEYED ON `nudgedAt`, so the key is one per stall episode: it is byte-identical on every tick of the offer window (the
 * ledger drops the repeats) and a row that stalls again later is a new question.
 * @param {ClaimFacts} facts @param {number} nudgedAt @param {number} lastMoveAt @returns {StallOrder}
 */
function nudgeOrder(facts: ClaimFacts, nudgedAt: number, lastMoveAt: number): StallOrder {
  const idle = minutes(nudgedAt - lastMoveAt);
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `nudge-${nudgedAt}`,
    prompt: `#${facts.row} IS YOURS AND NOTHING ON IT HAS MOVED FOR ${idle} MINUTES (the gate's interval is `
      + `${minutes(STALL_INTERVAL_MS)}): no commit on \`${facts.branch ?? "its branch"}\`, no push, no pull request, no `
      + `changed file in \`${facts.worktree ?? "its worktree"}\`, no row comment from you. THE SIGNAL IS THE ROW, NOT YOU: `
      + "being busy on something else is exactly the case this exists for (#2407, a worktree with 215 uncommitted lines "
      + "and nobody had touched it for seven hours while its holder worked another row).\n"
      + "IF YOU ARE WORKING ON IT, SAY SO IN ONE COMMAND: commit what you have, push the branch, or comment on the row. Any "
      + "of the three is a move and resets the clock. IF YOU CANNOT, say what stops you in a FIELD, not a sentence "
      + `(\`${ANSWER_PREFIX}<session>\` for a ruling, \`gh issue edit <n> --add-blocked-by <m>\` for a row you wait on, `
      + "`Not-before:` for a date) -- each clears itself.\n"
      + `IF NOTHING MOVES FOR ${minutes(STALL_INTERVAL_MS)} MINUTES AFTER THIS REACHES YOU the claim is RELEASED (the row is offered to `
      + "the pool again, or comes to `product-manager` if it was not Ready before you took it). Your worktree and everything unpushed in it "
      + "are KEPT, and the next instance starts in them: nothing you have built is lost, and nothing you have not built is held.",
    causeKey: nudgeKey(facts.session, facts.row, nudgedAt),
    // A NUDGE IS SENT AS A PLAIN PROMPT, NEVER BEHIND A `/clear` (#2470): its whole subject is what the session has built, and a standing seat
    // that was wiped first would be asked "what have you done" by a context that has forgotten.
    resume: true,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

/**
 * The nudge's `causeKey`: one per stall episode. The gate derives it here and reads the wake ledger for it, and `wake.ts` records it on delivery,
 * so the key has ONE spelling. @param {string} session @param {number} row @param {number} nudgedAt
 */
export function nudgeKey(session: string, row: number, nudgedAt: number) {
  return `${session}/${CLAIM_STALLED}/row-${row}/nudge-${nudgedAt}`;
}

/**
 * When the wake ledger last recorded `key` as DELIVERED, or `null`: the line `<epochMs>\t<causeKey>[...]` the tick writes once herdr has accepted the
 * prompt, with a `VOIDED` line (a delivery a restart killed) taking one back. THE LEDGER'S FORMAT IS `wake.ts`'s, which this leaf cannot import, so
 * the test writes a line with the real `ledgerLine` and reads it here: a change of format breaks that test and not the release.
 * @param {string} raw the ledger's text @param {string} key @returns {number | null}
 */
export function nudgeDeliveredAt(raw: string, key: string): number | null {
  const times: number[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    const at = Number(fields[0]);
    if (!Number.isFinite(at)) continue;
    if (fields[1] === "VOIDED" && fields[2] === key) {
      const index = times.lastIndexOf(Number(fields[3]));
      times.splice(index === -1 ? times.length - 1 : index, 1);
    } else if (fields[1] === key) times.push(at);
  }
  return times.length === 0 ? null : Math.max(...times);
}

/** @param {{ mergedPr?: number, mergedPrRepoKey?: string }} release a release whose `why` is "merged" @returns {string} */
export function mergedPrMention(release: { mergedPr?: number; mergedPrRepoKey?: string; }): string {
  return prMention(Number(release.mergedPr), release.mergedPrRepoKey);
}

/** @param {{ openPrs?: number[], openPrRepoKeys?: (string | undefined)[] }} release @returns {string} its open pull requests, comma-joined, each with its repository */
export function openPrMentions(release: { openPrs?: number[]; openPrRepoKeys?: (string | undefined)[]; }): string {
  return (release.openPrs ?? []).map((n, i) => prMention(n, release.openPrRepoKeys?.[i])).join(", ");
}

/**
 * The release, as an order `wake.ts` PERFORMS. It carries every fact the performer needs and the prompt is only what a
 * log line says: a release is not a question, and no session is asked anything.
 * @param {Pick<ClaimFacts, "row" | "session" | "branch" | "worktree">} facts @param {Extract<Reading, { kind: "release" }>} reading @returns {StallOrder}
 */
function releaseOrder(facts: Pick<ClaimFacts, "row" | "session" | "branch" | "worktree">, reading: Extract<Reading, { kind: "release"; }>): StallOrder {
  const release: ReleaseRequest = { row: facts.row, session: facts.session, why: reading.why, branch: facts.branch, worktree: facts.worktree,
    idleMinutes: reading.idleMs === null ? null : minutes(reading.idleMs), nudgedAt: reading.nudgedAt,
    ...(reading.interrupt === true ? { interrupt: true } : {}),
    ...(reading.count === undefined ? {} : { nudges: reading.count }),
    ...(reading.edges === undefined ? {} : { edges: reading.edges }),
    ...(reading.waiting === undefined ? {} : { waiting: reading.waiting }),
    ...(reading.mergedPr === undefined ? {} : { mergedPr: reading.mergedPr, answer: "product-manager",
      ...(reading.mergedPrRepoKey === undefined ? {} : { mergedPrRepoKey: reading.mergedPrRepoKey }),
      ...(reading.mergedPrHead === undefined ? {} : { mergedPrHead: reading.mergedPrHead }) }),
    // HELD, NOT POOLED (#3048): a gone holder's open PR is the work, so the row goes to `product-manager` and `ready` is not restored.
    ...(reading.openPrs === undefined || reading.openPrs.length === 0 ? {} : { openPrs: reading.openPrs, answer: "product-manager",
      ...(reading.openPrRepoKeys === undefined ? {} : { openPrRepoKeys: reading.openPrRepoKeys }) }) };
  const said = reading.why === "stalled" && reading.count !== undefined
      ? `${reading.count} nudges went unanswered (idle again after each, and no commit, no pull request and no head moved after any); its open pull request is left as it is`
    : reading.why === "stalled" && reading.idle ? `idle with no wait field and nothing moved for ${release.idleMinutes} minutes, and the nudge was not answered`
    : reading.why === "stalled" ? `nothing moved for ${release.idleMinutes} minutes and the nudge was not answered`
    : reading.why === "closed" ? `#${facts.row} is CLOSED${reading.interrupt === true ? ` while ${facts.session} is mid-turn on it, so the instance is interrupted` : ""}`
    : reading.why === "blocked" ? `blocked by ${(reading.edges ?? []).map((n) => `#${n}`).join(", ")} and the holder holds nothing`
    : reading.why === "wait" ? `${reading.waiting ?? "a declared wait"}, and the holder holds nothing`
    : reading.why === "gone" ? `${facts.session} no longer exists in herdr's own listing${release.openPrs === undefined ? ""
      : `, and ${openPrMentions(release)} is still open (the row is held for product-manager, not returned to the pool)`}`
    : `${mergedPrMention(release)} merged and the row stayed open`;
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `release-${reading.why}`,
    prompt: `RELEASE the claim on #${facts.row} held by ${facts.session}: ${said}.`,
    causeKey: `${facts.session}/${CLAIM_STALLED}/row-${facts.row}/release-${reading.why}`, release,
  };
}

/**
 * The orders this tick's readings imply: a nudge for a row FIRST found stalled and for one still inside the offer window
 * of its nudge, and a release for a second reading, a blocked claim and a merged one. ONE ORDER PER ROW.
 *
 * @param {{ facts: ClaimFacts, reading: Reading }[] | undefined} readings @param {number} now
 * @returns {StallOrder[]}
 */
export function claimStalledOrders(readings: { facts: ClaimFacts; reading: Reading; }[] | undefined, now: number, { accountPaused = pausedNow(now) !== null }: { accountPaused?: boolean; } = {}): StallOrder[] {
  const orders: StallOrder[] = [];
  for (const { facts, reading } of readings ?? []) {
    if (reading.kind === "nudge" && reading.idle) orders.push(idleNudgeOrder(facts, now, reading.idleMs, reading.count));
    else if (reading.kind === "nudge") orders.push(nudgeOrder(facts, now, reading.lastMoveAt));
    // OFFERED UNTIL DELIVERED, and then never again: the ledger holds a delivered key for one wake window only, so an offer that outlived the
    // delivery would send it a second time.
    else if (reading.kind === "nudged" && reading.deliveredAt === null) {
      const floor = idleLimitMs({ built: facts.nothing !== true, prs: withRedChecks(facts.ownPrs), ...(facts.declared !== undefined ? { declared: facts.declared } : {}) });
      orders.push(reading.idle ? idleNudgeOrder(facts, reading.nudgedAt, floor, reading.count) : nudgeOrder(facts, reading.nudgedAt, reading.lastMoveAt));
    } else if (reading.kind === "release" && !accountPaused) orders.push(releaseOrder(facts, reading)); // agent-org#1307: a claim is kept while the account is limited
  }
  return orders;
}

// --- THE LEDGER AND THE RESTART NOTICE (#458) --------------------------------------------------------------------------------------------

/**
 * The failure ledger's class key for a claimed worker that stopped (epic #4437). It is a constant of this file and not an entry of the ledger's seeded
 * `FAILURE_KINDS`: those files are #4452's and #4475's, and adding the key there is a one-line follow-up after they merge.
 */
export const CLAIMED_WORKER_STALLED = "claimed-worker-stalled";

/**
 * ONE EVENT PER UNANSWERED NUDGE, `<session>/#<row>/<nudge time>` (the nudge time in epoch ms, the spelling `nudgeKey` and the wake ledger carry, so a line
 * in one finds its line in the other). THE CLASS IS A NUDGE THE HOLDER DID NOT ANSWER, and the observable is the second reading's verdict
 * ({@link secondReading}): a `release` with `why: "stalled"` and a `nudgedAt`, i.e. nothing on the row moved after the nudge either. A FRESH nudge is
 * NOT an event (#4826): it is the guard working, and `repeatsIn` read each firing of it as a repeat of the class, so four nudges that all brought the
 * holder back (3 of the 4 rows closed within minutes) tripped `class-repeat` for a guard that had not failed. The fresh nudge stays recorded where it
 * already was, the wake ledger (`nudgeKey`).
 *
 * THE REF CARRIES `nudgedAt`, NOT `now`: the release is read on the tick it happens, long after the nudge, and a ref that moved with the tick would make
 * one episode two lines. A `nudged` reading is the same episode still inside its grace and is NOT an event, EXCEPT ONE THAT IS `idleAgain` (agent-org#860): the
 * holder was told, and was idle for a full period after the delivery with nothing moved and nothing declared. That is the second idle period the chairman's rule
 * files an incident for, and it is read on the tick, because a holder that is never released (a `Claimed-nothing:` claim, #3407; an open pull request of its own,
 * #2999; a keyed row, agent-org#834) never reaches the release this writer used to wait for. The ref is the same, so the release that may follow is the same line.
 * A second row's unanswered nudge is a different ref, which is what `repeatsIn` counts as a repeat of the class.
 * @param {{ facts: ClaimFacts, reading: Reading }[] | undefined} readings @param {number} now @returns {FailureEvent[]}
 */
export function stalledNudgeEvents(readings: { facts: ClaimFacts; reading: Reading; }[] | undefined, now: number): FailureEvent[] {
  return (readings ?? []).flatMap(({ facts, reading }) => {
    // the same ref in both cases: a release later than an `idleAgain` reading is the SAME episode, and `recordFailures` skips a (key, ref) already logged
    // (agent-org#743) a NUDGE THAT SUPERSEDES AN UNANSWERED ONE carries it: the holder with a pull request open is nudged again where it used to read `nudged` and `idleAgain`
    const unanswered = reading.kind === "release" ? (reading.why === "stalled" ? reading.nudgedAt : null)
      : reading.kind === "nudged" && reading.idleAgain === true ? reading.nudgedAt : reading.kind === "nudge" ? (reading.unanswered ?? null) : null;
    return unanswered === null ? [] : [{ classKey: CLAIMED_WORKER_STALLED, ref: `${facts.session}/#${facts.row}/${unanswered}`, at: now }];
  });
}

/**
 * Append this tick's nudges to the failure ledger. NEVER THROWS INTO THE TICK (a recorder that stopped the tick would be the outage it records), and a
 * refused append is REPORTED by `recordFailures` and comes back as `refused`, never swallowed. `record` is the seam a test writes nowhere through.
 * @param {{ readings: { facts: ClaimFacts, reading: Reading }[] | undefined, now: number, logPath: string, record?: typeof recordFailures, report?: (line: string) => void }} tick
 * @returns {RecordResult}
 */
export function recordStalledNudges({ readings, now, logPath, record = recordFailures, report = (line) => process.stderr.write(`${line}\n`) }: {
        readings: { facts: ClaimFacts; reading: Reading; }[] | undefined; now: number; logPath: string; record?: typeof recordFailures; report?: (line: string) => void;
    }): RecordResult {
  try {
    return record({ logPath, events: stalledNudgeEvents(readings, now), now, report });
  } catch (cause) {
    const refused = String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);
    report(`${CLAIMED_WORKER_STALLED}: NOT RECORDED: ${refused}`);
    return { appended: 0, skipped: 0, refused };
  }
}

/** The memory of the restart notice, beside the nudge's: `{ "<session>/<row>": "<agent session id the holder was last told about>" }`. */
export const AGENT_SESSIONS_FILE = "agent-sessions.json";

/** `<session>/claim-stalled/row-<n>/restart-<id>`: one per restart of one holder's session, spelled like {@link nudgeKey} so the ledger reads it the same way. */
export function restartNoticeKey(session: string, row: number, agentSession: string) {
  return `${session}/${CLAIM_STALLED}/row-${row}/restart-${agentSession}`;
}

/**
 * THE ORDER TO A HOLDER WHOSE SESSION RESTARTED: its background tasks went with the old process, so the completion notice it is waiting for will never
 * come. The `claim-stalled` cause, like every "go back to your work" order here, so it is delivered and counted by the machinery that already is.
 * @param {ClaimFacts} facts @param {string} agentSession @returns {StallOrder}
 */
function restartNoticeOrder(facts: ClaimFacts, agentSession: string): StallOrder {
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `restart-${agentSession}`,
    prompt: `#${facts.row} IS YOURS AND YOUR SESSION RESTARTED: every background task you started before the restart is LOST, and no completion notice `
      + "will ever arrive for it.\n"
      + `RE-READ the row, its pull request and its checks, then CONTINUE from where \`${facts.branch ?? "its branch"}\` stands: re-run what was running, push `
      + "what is unpushed. This is sent once for this restart.",
    causeKey: restartNoticeKey(facts.session, facts.row, agentSession), resume: true,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

/**
 * WHO WAS TOLD THEIR TASKS ARE LOST, from the holder's agent-session id changing. NOT "the session started after its claim": a dispatch CLAIMS FIRST and
 * starts the process after, so every fresh start would read as one (#458's measurement comment). A restart is a second id for a holder the gate has
 * already seen, and `herdr agent list` carries it.
 *
 *   first sighting      remembered, no order: a fresh start (or the first tick after this ships) is not a restart
 *   same id             nothing
 *   a new id            ONE order, offered until the wake ledger shows it DELIVERED and then remembered; a holder mid-turn right after a restart is
 *                       `working`, so a notice dropped on the first tick would never reach it
 *   not listed          unchanged: `goneReading` owns an absent session, and a listing that failed (`null`) is never read as a restart
 *
 * A row already being nudged or released this tick (`nudge`, `nudged`, `release`, `vacating`) is skipped, since that order already tells the holder to
 * continue. A `Claimed-nothing:` claim is never told (as the stopped clock is not its own). `after` carries only the rows still claimed, so it cannot grow.
 * @param {{ readings: { facts: ClaimFacts, reading: Reading }[], sessions: Map<string, string> | null, acked: Record<string, string>, delivered: (key: string) => boolean }} tick
 * @returns {{ orders: StallOrder[], after: Record<string, string> }}
 */
export function restartNotices({ readings, sessions, acked, delivered }: {
        readings: { facts: ClaimFacts; reading: Reading; }[]; sessions: Map<string, string> | null; acked: Record<string, string>; delivered: (key: string) => boolean;
    }): { orders: StallOrder[]; after: Record<string, string>; } {
  const orders: StallOrder[] = [];
  const after: Record<string, string> = {};
  const skipped: Reading["kind"][] = ["nudge", "nudged", "release", "vacating"];
  for (const { facts, reading } of readings) {
    const slot = `${facts.session}/${facts.row}`;
    const remembered = typeof acked[slot] === "string" ? acked[slot] : undefined;
    const current = sessions?.get(herdrAgentName(facts.session));
    if (remembered !== undefined) after[slot] = remembered;
    if (current === undefined || facts.nothing === true) continue;
    if (remembered === undefined) { after[slot] = current; continue; }
    if (remembered === current) continue;
    if (delivered(restartNoticeKey(facts.session, facts.row, current))) { after[slot] = current; continue; }
    if (!skipped.includes(reading.kind)) orders.push(restartNoticeOrder(facts, current));
  }
  return { orders, after };
}

// --- A CLOSED ROW'S CLAIM (#3535) -----------------------------------------------------------------------------------------

/** a pull request GitHub says closed the row: ANY of them, in any tracked repository */
export type ClosingPr = { number: number, headRefName?: string, title?: string };
/**
 * a CLOSED row that still carries the claim label, as `gh issue list --state closed --label in-progress` returns it
 */
export type ClosedClaimedRow = { number: number, title?: string, labels?: ({ name?: string } | string)[], comments?: RowComment[], closedByPullRequestsReferences?: ClosingPr[] };

/**
 * THE ORDERS FOR CLAIMS THAT OUTLIVED THEIR ROW: a row CLOSED (not planned, or superseded by hand) while it still carries `in-progress` and a
 * `session:` label. Measured on #3530: closed 51 seconds after the claim, labels taken off by hand 14 min 8 s later, the instance still building.
 *
 * NOTHING ELSE CAN SEE ONE. `claimStallTick` evaluates the OPEN claimed rows, a closed row is in none of them, and `spareDecision` ends an
 * instance only BETWEEN turns, which is right for a row that is open (forcing a delivery wipes the work it interrupts, #1966) and wrong for one that no longer exists.
 *
 * A ROW CLOSED BY ITS OWN PULL REQUEST IS RELEASED HERE TOO (#1463). One of `closedByPullRequestsReferences` may be the CLAIMANT'S (`ownsPr`: the claimed branch,
 * the row suffix or the title's reference, the same rungs the merged release uses). That used to be left to "the merge's settle", and that settle does not exist
 * for an agent-org row: the close-rows sweep lives in the host repository's CI and was never copied here, and the merged release reads OPEN rows only. #1325's labels
 * (closed by #1378, its own pull request) were kept for 39 hours by that exemption, and the stall detector said so every tick. So the claim is released like any
 * other closed one, and the line that says why is said ONCE per stand (`once`: the memory of the last tick's own-pull-request lines), never on every tick.
 * A closing reference that is NOT the claimant's -- somebody else's pull request, in this repository or the other -- is this release's case as before (review of #313).
 *
 * THE INTERRUPT IS DECIDED HERE, FROM THE READING OF HERDR: the holder is a per-row instance (`isInstance`) AND `working`. A standing seat is
 * released and never interrupted, and an idle instance has nothing to interrupt. `agents === null` (herdr could not be asked) is NOT "idle": the release
 * still happens, because the row's state is what decides it, and it is said that the instance's state was unread.
 *
 * `rows === null` is a refused read -- reported as UNREAD, never as "no closed claim" and never as one found.
 * @param {{ rows: ClosedClaimedRow[] | null, agents: { label: string, status: string }[] | null, repo: string,
 *   isInstance: (session: string) => boolean, log?: (line: string) => void, trackerRepo?: string }} args
 * `once` is the own-pull-request memory: `before` is what the last tick said (keyed `tracker#row`, valued by the stand: the session and the pull request), and
 * `after` is what this tick says, which the caller writes back. A line is said only when its key's stand is new to `before`.
 * @returns {StallOrder[]}
 */
export function closedClaimOrders({ rows, agents, repo, isInstance, log = () => {}, trackerRepo, once }: {
        rows: ClosedClaimedRow[] | null; agents: { label: string; status: string; }[] | null; repo: string;
        isInstance: (session: string) => boolean; log?: (line: string) => void; trackerRepo?: string;
        once?: { before: Record<string, string>; after: Record<string, string>; };
    }): StallOrder[] {
  if (rows === null) {
    log(`claim-stall: the closed rows still carrying a claim were NOT read this tick${agents === null ? " (herdr could not be asked, so whether a per-row instance exists is unknown)" : ""} -- a closed row's claim was NOT evaluated.\n`);
    return [];
  }
  const orders: StallOrder[] = [];
  for (const row of rows) {
    const order = closedClaimOrder(row, { agents, repo, isInstance, log, trackerRepo, once });
    if (order !== null) orders.push(order);
  }
  return orders;
}

/**
 * ONE closed row's release order, or `null` with the reason said on `log`.
 * @param {ClosedClaimedRow} row
 * @param {{ agents: { label: string, status: string }[] | null, repo: string, isInstance: (session: string) => boolean, log: (line: string) => void, trackerRepo?: string, once?: { before: Record<string, string>, after: Record<string, string> } }} ctx
 * @returns {StallOrder | null}
 */
function closedClaimOrder(row: ClosedClaimedRow, { agents, repo, isInstance, log, trackerRepo, once }: { agents: { label: string; status: string; }[] | null; repo: string; isInstance: (session: string) => boolean; log: (line: string) => void; trackerRepo?: string; once?: { before: Record<string, string>; after: Record<string, string>; }; }): StallOrder | null {
  const names = (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l.name ?? "")));
  const sessions = names.filter((n) => n.startsWith(SESSION_PREFIX));
  if (sessions.length !== 1) {
    log(`claim-stall: closed #${row.number} carries ${sessions.length} session labels -- its claim was not released.\n`);
    return null;
  }
  const session = sessions[0].slice(SESSION_PREFIX.length);
  const record = claimRecordOf(row.comments ?? []);
  const claimant = { row: row.number, branch: record?.branch ?? null, session, ...(trackerRepo === undefined ? {} : { trackerRepo }) };
  const own = (row.closedByPullRequestsReferences ?? []).find((pr) => ownsPr(claimant, pr) !== null);
  if (own !== undefined) {
    const key = `${trackerRepo ?? ""}#${row.number}`;
    const stand = `${session}#${own.number}`;
    if (once !== undefined) once.after[key] = stand;
    if (once === undefined || once.before[key] !== stand) {
      log(`claim-stall: #${row.number} was closed by its own pull request (#${own.number}) -- no merge settle clears an agent-org row's claim labels, so ${session}'s claim is released here.\n`);
    }
  }
  const worktree = record?.worktree ?? null;
  const holder = agents?.find((a) => a.label === session);
  if (agents === null) log(`claim-stall: closed #${row.number}: herdr's state of ${session} was not read, so no interrupt is ordered.\n`);
  return releaseOrder({ row: row.number, session, branch: record?.branch ?? null,
    worktree: worktree === null ? null : resolve(repo, worktree) },
  { kind: "release", why: "closed", lastMoveAt: null, idleMs: null, nudgedAt: null,
    ...(isInstance(session) && holder?.status === "working" ? { interrupt: true } : {}) });
}

// --- THE HOST EVENTS ------------------------------------------------------------------------------------------------

/**
 * When `herdr.service` last STARTED, as epoch ms -- or `null` for anything that is not a time (the unit is not active, the
 * property is empty, `systemctl` would not answer). It answers only for the LATEST start; what is done for an earlier one
 * is `RESTART_STATE_FILE`, which keeps the last restart already acted on.
 *
 * `--timestamp=utc` because the default prints the host's zone as an abbreviation (`BST`) that no parser here can read.
 * @param {(args: string[]) => string} run `systemctl`'s stdout
 * @returns {number | null}
 */
export function readHerdrRestart(run: (args: string[]) => string): number | null {
  try {
    const out = run(["--user", "show", "herdr.service", "-p", "ActiveEnterTimestamp", "--timestamp=utc"]);
    const m = /^ActiveEnterTimestamp=\w{3} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/m.exec(out);
    return m === null ? null : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  } catch {
    return null;
  }
}

const INPUT_BOX_RULE = /^─{8,}$/;

/**
 * Does this pane's LAST LINE OF OUTPUT read `Interrupted`? "Last line" means the last non-empty line ABOVE the input box:
 * Claude Code draws a rule, the `❯` prompt and a second rule under everything it has printed, then a status footer, so
 * the bottom of the pane is never the answer. A pane with no box (a bare shell) is read from its own last line.
 *
 * `idle` is NOT the signal (#2470 measured herdr calling every interrupted pane `idle`), and the needle is anchored to the
 * LAST line so a session merely QUOTING the sentence earlier in its output is not resumed.
 * @param {string | null | undefined} text @returns {boolean}
 */
export function paneInterrupted(text: string | null | undefined): boolean {
  const lines = String(text ?? "").split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (INPUT_BOX_RULE.test(l.trim()) ? [i] : []));
  const content = rules.length >= 2 ? lines.slice(0, rules[rules.length - 2]) : lines;
  const last = [...content].reverse().find((l) => l.trim() !== "");
  return last !== undefined && last.includes(INTERRUPTED_TEXT);
}

/**
 * Did this pane's LAST TURN end in the autocompact thrash guard? Above the input box exactly as {@link paneInterrupted}
 * reads it, but over the last PARAGRAPH (the trailing run of non-empty lines), not the last line: {@link THRASH_TEXT}'s
 * message wraps, so one line is not enough. A trailing {@link DONE_FOOTER} line is Claude Code's own completion chrome,
 * never the message, and is dropped first so the paragraph it belongs to is not mistaken for the one before it.
 *
 * Anchored to the last paragraph for the same reason `paneInterrupted` anchors to the last line: a session merely
 * DISCUSSING this string (this very row, read into its own pane) is not this turn's.
 * @param {string | null | undefined} text @returns {boolean}
 */
export function paneThrashed(text: string | null | undefined): boolean {
  const lines = String(text ?? "").split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (INPUT_BOX_RULE.test(l.trim()) ? [i] : []));
  const content = rules.length >= 2 ? lines.slice(0, rules[rules.length - 2]) : lines;
  let end = content.length;
  while (end > 0 && content[end - 1].trim() === "") end--;
  if (end > 0 && DONE_FOOTER.test(content[end - 1])) end--;
  while (end > 0 && content[end - 1].trim() === "") end--;
  let start = end;
  while (start > 0 && content[start - 1].trim() !== "") start--;
  const paragraph = content.slice(start, end).join(" ");
  return paragraph.includes(THRASH_TEXT);
}

/**
 * Deliveries a restart (or an interruption) killed: inside `windowMs` before `at`, and whose target made no move from the delivery until
 * `until`. `until` is `at` for an interruption noticed as it happens, and NOW for a restart: a tick that notices a restart LATE (the tick was
 * down, or this shipped after it) must not re-send what the session has since answered, so "no move before the restart" is read through to the
 * moment of asking. `moved` is asked only of a delivery inside the window.
 *
 * @template {{ session: string, at: number }} D
 * @param {{ deliveries: D[], at: number, until?: number, moved: (session: string, from: number, to: number) => boolean,
 *   windowMs?: number }} facts
 * @returns {D[]}
 */
export function killedDeliveries<D extends { at: number; session: string }>({ deliveries, at, until = at, moved, windowMs = RESTART_RESEND_WINDOW_MS }: {
        deliveries: D[]; at: number; until?: number; moved: (session: string, from: number, to: number) => boolean;
        windowMs?: number;
    }): D[] {
  return deliveries.filter((d) => d.at >= at - windowMs && d.at < at && !moved(d.session, d.at, until));
}

/** @param {string} path @returns {number | null} the mtime in ms, `null` for a path that is gone */
export function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if ((err as any)?.code === "ENOENT" || (err as any)?.code === "ENOTDIR") return null;
    throw err;
  }
}

/** @param {string} path @returns {boolean} */
export const pathExists = (path: string): boolean => existsSync(path);
