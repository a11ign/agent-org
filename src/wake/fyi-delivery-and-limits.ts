import { readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { herdrAgentName } from "../herdr-agents.ts";
import { reviewerInstance } from "../review-attribution.ts";
import { reviewerDoorPath } from "../reviewer-door-path.ts";
import { OUTSIDE, VERDICT_DELIVERY_FLAG, outsideVerdictBlock, postOutsideVerdicts, type DoorRun } from "../review-trust.ts";
import { recordWrittenVerdicts } from "../verdict-delivery.ts";
import { machineryFlagOn } from "../org-health/fleet-build-readings.ts";
import { readReenqueueState } from "../work-gate/causes/pr-ejected.ts";
import { REVIEWER_STATE_DIR } from "../work-gate/vocabulary.ts";
import { claudeTurns, sessionOf, transcriptFiles } from "../token-audit.ts";
import { pauseRefusal, type AccountLimit } from "../account-limit.ts";
import { isOneShotOrder, standInClaimer, type OrchestratorOneShot } from "../orchestrator-one-shot.ts";
import { isCeoOneShotOrder, type CeoOneShot } from "../ceo-one-shot.ts";
import { SPARE_FAMILIES, familyMember } from "../arm-pr.ts";
import { CONTINUATION_CAUSES, MAX_CONTINUATIONS } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { statMtime } from "../claim-stall.ts";
import { persistentRoles } from "../project-roles.ts";
import { SESSIONS_FILE, declaresDecision, isLeadSeat } from "./seat-reset.ts";
import { MAX_SPAWNS_PER_TICK, isPilotOrder, isPullRequestSpawnOrder, ownRowOnly, reviewerEnvironment, rowRefOfOrder, spawnWorker, startsFresh, type ClaimRefused, type ClaimedRow, type ReviewerEntry, type SpawnClaimer, type ToolchainGate } from "./pull-request-spawn-orders.ts";
import { isReviewerOrder, repointedForReviewer, reviewerMismatch, reviewerTarget, type ReviewerDeps } from "./reviewer-tokens-and-checkouts.ts";
import { relaneTarget, routeWithFallback, type SpareInstance, withSpareInstances } from "./exit-and-limits.ts";

/**
 * IS THIS QUEUED ORDER AN FYI THAT MUST NOT WAKE ITS SEAT: `prompt:session` held it at write time (`fyi`), it still declares no decision, it is addressed to a lead
 * seat, and it is not a re-send of an order a restart killed (`resume`, #2470, which was already being delivered). An UNDECLARED order reads as FYI
 * ({@link declaresDecision}, `FYI_FLAG`), and `prompt:session` is where that default is given its consequence; THE FLAG IS READ HERE, NOT RE-DERIVED from the
 * absence of a decision, so an order the chairman's message queued as a real one (`STANCE.ORDER`) or one written before the field existed is never held.
 */
export function holdsAsFyi(handoff: { session: string; decision?: boolean; fyi?: boolean; resume?: boolean; }, isLead: (label: string) => boolean = isLeadSeat) {
  return handoff.fyi === true && !declaresDecision(handoff) && handoff.resume !== true && isLead(handoff.session);
}

/**
 * After this many deliveries of the same cause, stop offering it and say so.
 *
 * Six is three attempts an hour at a twenty-minute window, so a cause reaches this after roughly two
 * hours of being offered and ignored. That is long enough to survive an agent restart or a slow turn, and
 * short enough that a genuinely stuck row is named while someone is still awake to read it.
 */
export const MAX_DELIVERIES = 6;

/** How long to wait for a busy agent to reach a settled state before giving up on the clear. */
export const CLEAR_TIMEOUT_MS = 30_000;

/**
 * THE SETTLE'S TEST CLOCK (#3769): a test that spawns the tick as a PROCESS cannot inject `sleep`, so each one paid the real
 * {@link CLEAR_SETTLE_MS} (eleven tests, about 40 s of wall). The spawning test sets this variable to a number of milliseconds and
 * the tick's blocking sleep waits that long instead.
 *
 * ABSENT IN PRODUCTION, AND IT CAN ONLY SHORTEN: no unit file names it (`wake-settle-test-clock.test.ts` reads them all), and a
 * value above the real settle is ignored, so a stray export on a host cannot make the tick slower. The default is still the real
 * five seconds, which the two `THE DEFAULT IS REAL` tests in `wake-clear-settle.test.ts` measure.
 */
export const SETTLE_TEST_CLOCK_ENV = "AGENT_ORG_TEST_SETTLE_MS";

/**
 * The wait to actually perform for a settle of `ms`: the test clock's value when one is set to a whole number of milliseconds,
 * else `ms`. Anything that is not a plain non-negative integer is ignored, so a typo waits the real time rather than none.
 */
export function settleWaitMs(ms: number, env: NodeJS.ProcessEnv = process.env) {
  const set = env[SETTLE_TEST_CLOCK_ENV];
  return set !== undefined && /^\d+$/.test(set) ? Math.min(ms, Number(set)) : ms;
}

/**
 * Block for `ms` (or what {@link settleWaitMs} makes of it). Synchronous on purpose: `deliver` is synchronous, and making it async
 * to hold a five-second pause would turn every caller and every test async for one `sleep`.
 */
export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleWaitMs(ms));
}

/**
 * `120,000` cache-read tokens on a per-row instance's own last turn (#2688, chairman via `ceo`,
 * 2026-09-27) -- the `ceo`-chosen number the chairman's brief invited, and the done-when's own target: a
 * mid-session compaction lands the running average under it for the calls that follow, not because it is
 * a magic number.
 *
 * REVISIT FROM THE SAME MEASUREMENT THIS THRESHOLD'S OWN GUARD USES: move it down if a 120k-triggered
 * compaction still leaves the post-rollout average over 120k (context keeps growing after a mid-session
 * compact too, so one compaction per session may not be enough on the longest rows), and say so in the row
 * that moves it, with the reading that justified it.
 */
export const COMPACT_THRESHOLD_TOKENS = 120_000;

/**
 * A PER-ROW INSTANCE'S OWN CONTEXT SIZE, RIGHT NOW (#2688) -- the live proxy #928's own offline report is
 * built from, read live instead of only reported. `claudeTurns` and `transcriptFiles` are
 * `token-audit.ts`'s own readers; nothing here is a new metric, only this one read at delivery time.
 *
 * THE MOST RECENTLY WRITTEN TRANSCRIPT NAMING THIS SESSION WINS. More than one file can carry the session's
 * name (a restarted process opens a fresh one), and only the newest describes the window the next order
 * actually lands on.
 *
 * `null` IS "CANNOT TELL", NEVER ZERO: an instance whose transcript this cannot find or read is not
 * assumed small, so it is never sent a `/compact` on that account.
 *
 *  @param [root] the instance's own transcripts; real `~/.claude/projects`
 *   by default, injectable for a test
 * @param [reader] the file reads, a seam so a test can count them
 */
export function instanceCacheRead(label: string, root: string = join(process.env.HOME ?? "", ".claude", "projects"), reader: { readText: (file: string) => string; readHead: (file: string) => string; } = TRANSCRIPT_READER): number | null {
  return newestTranscriptRead(label, root, reader, (text) => claudeTurns(text, UNATTRIBUTED).filter((t) => t.session === label).at(-1)?.cacheRead ?? null);
}

/**
 * THE LOOP BOTH READS SHARE: NEWEST FIRST, STOPPING AT THE FIRST FILE THAT NAMES THE SESSION, is "the most recently written transcript naming it wins" without reading
 * the rest (a11ign/a11ign#3566, slice 6): this read every transcript on the host, 3.3 GB, parsed whole, once per order delivered -- 22 s of
 * CPU measured for ONE call, and the largest part of a waking tick's `wake` phase. A tie in mtime keeps the first in directory order, as `>` did.
 * A file that names the session and for which `pick` has no answer falls through to the next, exactly as the cache read always did.
 */
export function newestTranscriptRead<T>(label: string, root: string, reader: { readText: (file: string) => string; readHead: (file: string) => string; }, pick: (text: string) => T | null): T | null {
  for (const { file } of newestFirst(transcriptFiles(root))) {
    if (namesAnotherSession(file, label, reader)) continue;
    let text;
    try { text = reader.readText(file); } catch { continue; }
    // `claudeTurns` stamps every turn with this one session, so a file that is another's has none to find: skip its parse (a head that said nothing).
    if ((sessionOf(text) ?? UNATTRIBUTED) !== label) continue;
    const found = pick(text);
    if (found !== null) return found;
  }
  return null;
}

/** `claudeTurns`'s own name for a transcript that names no session; passed explicitly so the skip above and the parse cannot disagree about it. */
const UNATTRIBUTED = "unattributed";

/** How much of a transcript's start is read to learn whose it is: the wake prompt is its first message. A file whose head says nothing is read whole. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

export const TRANSCRIPT_READER: { readText: (file: string) => string; readHead: (file: string) => string; } = {
  readText: (file) => readFileSync(file, "utf8"),
  readHead(file) {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, TRANSCRIPT_HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  },
};

/** @returns newest first; equal mtimes keep their given order (the sort is stable) */
function newestFirst(files: string[]): { file: string; mtime: number; }[] {
  return files.map((file) => ({ file, mtime: statMtime(file) ?? 0 })).sort((a, b) => b.mtime - a.mtime);
}

/**
 * Whether the head of this transcript already says it is ANOTHER session's. `claudeTurns` takes a file's session from the FIRST `You are \`x\``
 * anywhere in it, so a match in the head is that very match, and a file whose first match is not `label` has no turn for `label`: skipping it
 * changes no answer. A head with no match says nothing, and a head that cannot be read says nothing -- both fall through to the whole-file read.
 */
function namesAnotherSession(file: string, label: string, reader: { readHead: (file: string) => string; }) {
  let head;
  try { head = reader.readHead(file); } catch { return false; }
  const named = sessionOf(head);
  return named !== null && named !== label;
}

/**
 * IS THIS A SESSION WHOSE ONLY WORK IS ONE ROW (#2483) -- and so one that must never be cleared between orders.
 *
 * ONE PREDICATE, CALLING THE TWO READERS THAT ALREADY SAY SO, and no pattern of its own: {@link familyNumber} for
 * the roster's spare family (`worker-4` onward) and `reviewerInstance` for `reviewer-<n>` and `reviewer-<key>-<n>`, which lives in
 * another module and also refuses the retired `reviewer-2`. `worker-capture`, `worker-tooling` and `worker-judge`
 * share the `worker-` prefix and answer `null` on both, so they stay standing seats and keep the clear.
 */
export function isPerRowInstance(label: string) {
  return familyMember(label) !== null || reviewerInstance(label) !== null;
}

/**
 * WHAT A STANDING LEAD'S WINDOW IS WORTH KEEPING FOR (#3440, chairman's order of 2026-10-04, lever 1 on #928): a clear re-writes
 * the whole starting context at the cache-write price, and the orders to the busiest leads arrive close together, so most clears
 * threw away a window that was minutes old. BOTH NUMBERS ARE UNMEASURED STARTING CONSTANTS (`ceo`'s ruling) and live here, in one
 * place, so the measurement that moves them edits one line.
 *
 * `KEEP_WITHIN_MS` -- N, 30 minutes: the previous order's age at or under which the window is kept. WOULD CHANGE ON: the gap
 * distribution per lead at the point where the cache-write saving of a kept order stops exceeding the cost of the stale context
 * it carries, read from the transcripts (`token-audit.ts` sums `cache_creation_input_tokens` per session). Measured 2026-10-04 over
 * 2026-10-01..04: 32 of 50 gaps to `ceo` and 18 of 39 to `product-manager` were at or under 30 minutes, 3 of 11 to `orchestrator`.
 *
 * `KEEP_FILL_TOKENS` -- 50% of a 200k window: the cache read at or under which a recent window is kept and over which it is
 * `/compact`ed. WOULD CHANGE ON: where answers start to degrade, which nothing here measures and nobody has.
 */
export const KEEP_WITHIN_MS = 30 * 60 * 1000;
export const CONTEXT_WINDOW_TOKENS = 200_000;
export const KEEP_FILL_FRACTION = 0.5;
export const KEEP_FILL_TOKENS = CONTEXT_WINDOW_TOKENS * KEEP_FILL_FRACTION;

/**
 * THE LARGEST STATE FILE A CLEAR WILL REHYDRATE FROM (#4072): 8 KiB, about 2,000 tokens, so a cleared seat restarts on a small floor rather
 * than on a second window. AN UNMEASURED STARTING CONSTANT. WOULD CHANGE ON: the size of the state files managers actually write, read
 * from `state/`, and the first one that is refused at this size for being useful rather than bloated.
 */
export const STATE_FILE_MAX_BYTES = 8 * 1024;

/** What was done to a seat's window before an order -- the one word every caller's wording is read from (#3440). */
export const CONTEXT_ACTION = Object.freeze({ KEPT: "kept", COMPACTED: "compacted", CLEARED: "cleared" });

/**
 * WHEN THE SEAT'S LAST ORDER LANDED, for a decision that must read the clock and not a transcript: one file per seat in a directory the caller names, written only after a prompt landed ({@link orderClockIn}). A DIRECTORY THE CALLER NAMES, NEVER A DEFAULT: a test that delivers to `ceo` would otherwise stamp the host's real record and keep the real `ceo`'s window. Without a clock the answer is "cannot tell", which is a clear. `stateFile` is where the seat's own end-of-wake state lives (#4072), `null` when the caller names no directory for it.
 */
export type OrderClock = { now: () => number, lastOrderAt: (label: string) => number | null, recordOrder: (label: string) => void, stateFile?: (label: string) => string | null };

/** What a caller that has no record directory hands the decision: nothing is known, so every standing seat is cleared. */
export const NO_CLOCK = { now: Date.now, lastOrderAt: () => null, recordOrder: () => {} };

/**
 * THE SIZE OF A STATE FILE THAT IS A REGULAR FILE AND CAN BE OPENED, or why it is not one (#4072). `stat` alone answers for a directory, a
 * socket or an unreadable file, and a clear that nothing can rehydrate from is the loss this check exists to prevent. ABSENT is a
 * `null` refusal: the ordinary state before a seat writes one.
 */
function regularFileSize(file: string): { bytes: number; } | { refusal: string | null; } {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { refusal: `state file ${file} is not a regular file, so the window is compacted` };
    closeSync(openSync(file, "r"));
    return { bytes: stat.size };
  } catch (err: any) {
    return err?.code === "ENOENT" ? { refusal: null }
      : { refusal: `state file ${file} could not be read (${String(err?.code ?? err).slice(0, 60)}), so the window is compacted` };
  }
}

/**
 * CAN THIS SEAT BE CLEARED INSTEAD OF COMPACTED (#4072): only if the state it would be rehydrated from exists and is within
 * {@link STATE_FILE_MAX_BYTES}. ABSENT, EMPTY, UNREADABLE AND OVERSIZED ARE FOUR DIFFERENT ANSWERS and none is a pass, because a clear
 * that nothing rehydrates throws away what a compaction would have summarised. An oversized file is REFUSED WITH ITS SIZE and never
 * truncated: half of a state file is a state nobody wrote.
 *
 * @returns `refusal` is null for an absent file, which is the ordinary
 *   state before any seat writes one and is not worth a line
 */
export function stateFileVerdict(label: string, clock: OrderClock): { usable: true; } | { usable: false; refusal: string | null; } {
  const file = clock.stateFile?.(label) ?? null;
  if (file === null) return { usable: false, refusal: null };
  const read = regularFileSize(file);
  if ("refusal" in read) return { usable: false, refusal: read.refusal };
  const { bytes } = read;
  if (bytes === 0) return { usable: false, refusal: `state file ${file} is empty, so the window is compacted` };
  if (bytes > STATE_FILE_MAX_BYTES) {
    return { usable: false, refusal: `state file ${file} is ${bytes} bytes, over the ${STATE_FILE_MAX_BYTES}-byte cap (not truncated), so the window is compacted` };
  }
  return { usable: true };
}

/**
 * THE RECENT-ORDER DECISION FOR A STANDING SEAT THAT IS NOT PERSISTENT (#3440): `kept` when its previous order was at or under
 * {@link KEEP_WITHIN_MS} ago and its window at or under {@link KEEP_FILL_TOKENS}, `cleared` when recent and over AND a state file within its cap
 * exists to rehydrate from ({@link stateFileVerdict}, #4072) and `compacted` when it does not, `cleared` otherwise.
 * EVERY UNREADABLE FACT IS A CLEAR: no previous order on record, a transcript that cannot be read, a record dated in the future.
 * `stateRefusal` is why a recent, over-full window was compacted rather than cleared, when that is worth saying.
 */
export function recentOrderAction(label: string, clock: OrderClock, contextRoot?: string): { action: string; stateRefusal: string | null; } {
  const last = clock.lastOrderAt(label);
  const age = last === null ? null : clock.now() - last;
  if (age === null || age < 0 || age > KEEP_WITHIN_MS) return { action: CONTEXT_ACTION.CLEARED, stateRefusal: null };
  const tokens = instanceCacheRead(label, contextRoot);
  if (tokens === null) return { action: CONTEXT_ACTION.CLEARED, stateRefusal: null };
  if (tokens <= KEEP_FILL_TOKENS) return { action: CONTEXT_ACTION.KEPT, stateRefusal: null };
  const state = stateFileVerdict(label, clock);
  return state.usable ? { action: CONTEXT_ACTION.CLEARED, stateRefusal: null }
    : { action: CONTEXT_ACTION.COMPACTED, stateRefusal: state.refusal };
}

/**
 * An instance's or a persistent seat's action: compacted over {@link COMPACT_THRESHOLD_TOKENS}, otherwise kept -- never cleared.
 */
export function overThreshold(label: string, contextRoot?: string) {
  const tokens = instanceCacheRead(label, contextRoot);
  return tokens !== null && tokens > COMPACT_THRESHOLD_TOKENS ? CONTEXT_ACTION.COMPACTED : CONTEXT_ACTION.KEPT;
}

/** The host's 1-minute load average and the cores it has, as read once by whoever asks ({@link hostLoadRefusal}). */
export type HostLoad = {load: number, cores: number};

/**
 * Why a NEW engineer must not start while the host is over its core count, or `null` (#3560, chairman via `ceo`, 2026-10-04).
 *
 * MEASURED BY `ceo` AT 21:35Z: load 98 on 16 cores with swap in use, and the gate's own tick took 6 min 44 s while it kept starting one
 * more full-suite engineer per tick (`MAX_SPAWNS_PER_TICK` caps the count, and nothing read the load). THE PAUSE IS DERIVED, NOT SET: no
 * state file, no label, so nothing can be left on. The next tick reads the load again, and the order -- refused like any spawn, never
 * written to the ledger -- is offered then. EXACTLY EQUAL DOES NOT REFUSE: "over" is the chairman's word.
 *
 * THE THRESHOLD IS THE CORE COUNT THE CHAIRMAN NAMED, NOT A MEASURED OPTIMUM. It lowers nothing a running suite makes (#3536).
 * A reading that is absent (no seam, a test) is no refusal, as `memory` and `claimable` are.
 */
export function hostLoadRefusal(reading: HostLoad | undefined): string | null {
  if (reading === undefined || !(reading.load > reading.cores)) return null;
  return `host load ${Number(reading.load.toFixed(2))} is over its ${reading.cores} cores: no new engineer is started`;
}

/**
 * Who takes this order: a session that is already free, or a process started for a role that has none.
 *
 * THE SPAWN IS THE REFUSAL PATH AND NOTHING ELSE. `route` is asked first and unchanged, so every order
 * that a standing session can take still goes to one -- this only runs where `deliver` used to write
 * `UNDELIVERED` and move on. That is what "beside the standing path, never in place of it" means in code.
 *
 * BOTH REASONS ARE REPORTED WHEN BOTH FAIL. A refusal that said only "no engineer is idle" would hide the
 * fact that a spawn was attempted and why it did not happen, which is precisely the question a pilot exists
 * to answer.
 *
 * @param order `fallbackPrompt` is the `prompt` typed INSTEAD when `fallback` is who receives it
 *
 *
 *
 *   (`memory`, from {@link ReviewerDeps}, is the memory hold both spawn paths ask -- {@link spawnMemoryGate}; `hostLoad` is the load reading
 *   the engineer spawn alone asks -- {@link hostLoadRefusal});
 *   `spawned` is how many ENGINEER processes this tick has already started -- see `MAX_SPAWNS_PER_TICK`, which a
 *   reviewer start never spends (#2401); `ineligibleReason` is {@link route}'s; `env` is the spawn's environment
 *   ({@link spawnEnvironment}); `relane` is {@link relaneTarget}'s clock and deferral record (#3465)
 */
export function targetFor(order: {
        session: string; causeKey: string; prompt: string; cause?: string; title?: string; fallback?: string;
        fallbackPrompt?: string; startFresh?: boolean;
    }, live: { label: string; status: string; }[], roster: string[], deps: {
        run: (args: string[]) => string; spawned: number; ineligibleReason?: (label: string) => string | null;
        relane?: { deferredSince: Map<string, number>; now: number; }; goneSeats?: ReadonlyMap<string, string>;
        env?: Record<string, string>; registerSpawn?: (role: string) => void; drained?: readonly string[];
        claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; claimer?: SpawnClaimer; hostLoad?: () => HostLoad;
        claimRefused?: ClaimRefused; oneShot?: OrchestratorOneShot; ceoOneShot?: CeoOneShot; toolchain?: ToolchainGate;
        accountPause?: AccountLimit | null;
    } & ReviewerDeps): {
    label: string; profile?: { kind: string; model: string; effort: string; }; claimed?: ClaimedRow;
    workspace?: string; reviewer?: true; order?: { prompt: string; };
} | { refusal: string; } {
  // A REVIEWER ORDER IS ASKED FIRST AND SEPARATELY (#2401): the engineer pilot's checks below are unchanged.
  if (isReviewerOrder(order)) return reviewerTarget(order, live, deps);
  // agent-org#1307: WHILE THE ACCOUNT'S CLAUDE ALLOWANCE IS SPENT, NO CLAUDE SEAT IS STARTED, CLAIMED FOR OR PROMPTED. A reviewer is a Codex seat and went above.
  if (deps.accountPause) return { refusal: pauseRefusal(deps.accountPause) };
  // agent-org#459: A READY ROW IS OFFERED TO ITS OWN SPARE OR TO A FRESH WORKER, never to another row's idle instance (`ownRowOnly`).
  const routed = routeWithFallback(order, live, withSpareInstances(roster, live), ownRowOnly(order, deps.ineligibleReason));
  if (!("refusal" in routed)) {
    // THE FALLBACK IS TYPED ITS OWN WORDS (#3078): the order's `prompt` is written to the owner, and says the fix is theirs.
    if (routed.label === order.fallback && typeof order.fallbackPrompt === "string") {
      return { label: routed.label, order: { prompt: order.fallbackPrompt } };
    }
    // AN INSTANCE TAKES ITS OWN PULL REQUEST'S ORDERS ONLY, whatever cause or fallback brought the order here.
    const wrong = reviewerMismatch(order, routed.label);
    if (wrong !== null) return { refusal: wrong };
    // AN ORDER OF ANY OTHER CAUSE, ABOUT THE LIVE REVIEWER'S OWN PULL REQUEST, RE-POINTS ITS TREE TOO (#2771).
    return reviewerInstance(routed.label) === null ? { label: routed.label }
      : { label: routed.label, order: repointedForReviewer({ session: routed.label, prompt: order.prompt }, deps.checkout) };
  }
  // #3465: A DECLARED FINISHING ORDER OVER THE BOUND TRIES A FREE ENGINEER BEFORE IT IS LEFT TO WAIT; nothing else here is a candidate (`relaneTarget`).
  const relaned = relaneTarget(order, { deferredSince: undefined, now: Date.now(), ...deps.relane, live, roster, ineligibleReason: deps.ineligibleReason, goneSeats: deps.goneSeats });
  if (relaned !== null) return "label" in relaned ? relaned : { refusal: `${routed.refusal}; not re-laned: ${relaned.refusal}` };
  if (!isPilotOrder(order)) return { refusal: routed.refusal };
  // #4524: A CHAIRMAN ROW'S START IS NOT HELD BY THE TICK'S ALLOWANCE OR THE HOST'S LOAD; the memory floor, the claim's own checks (B4) and the address still are.
  const fresh = startsFresh(order);
  if (!fresh && deps.spawned >= MAX_SPAWNS_PER_TICK) {
    return { refusal: `${routed.refusal}, and this tick has already started ${deps.spawned} `
      + `(MAX_SPAWNS_PER_TICK is ${MAX_SPAWNS_PER_TICK})` };
  }
  const overloaded = fresh ? null : hostLoadRefusal(deps.hostLoad?.());
  if (overloaded !== null) return { refusal: `${routed.refusal}; ${overloaded}` };
  // agent-org#1025: THE START BUDGET HOLDS A CHAIRMAN ROW TOO, since the starts it exists for are exactly the ones `startsFresh` lets past the pace limits.
  // It is asked BEFORE the claim, so a deferred start does not claim a row (a `node` startup of 9 to 14 s) only to release it.
  const startsSpent = deps.startHold?.() ?? null;
  if (startsSpent !== null) return { refusal: `${routed.refusal}; ${startsSpent}` };
  // #832: A ONE-SHOT ORCHESTRATOR RUN'S CLAIM IS HELD, AND ITS RECORD OF A SPAWN WRITTEN, INSIDE THE CLAIMER (`standInClaimer`): the spawn's own order of checks is unchanged, and an order
  // with no guard or no claimer handed in is never spawned, so the hardware rule does not depend on a caller remembering it.
  // #914: the ceo's one-shot run is guarded by its own `ceoOneShot`, the same way, and never by the orchestrator's.
  // agent-org#1520: A RED PULL REQUEST HAS NO ROW, so it is given NO claimer and NO claim check: there is no row to claim, and `spawnClaimability` reads only a row key.
  const pullRequest = isPullRequestSpawnOrder(order);
  const claimer = pullRequest ? undefined : isOneShotOrder(order) ? standInClaimer(deps.claimer, deps.oneShot, { rowOf: rowRefOfOrder, live })
    : isCeoOneShotOrder(order) ? standInClaimer(deps.claimer, deps.ceoOneShot, { rowOf: rowRefOfOrder, live }) : deps.claimer;
  if (claimer !== undefined && "refusal" in claimer) return { refusal: `${routed.refusal}; no spawn: ${claimer.refusal}` };
  const spawn = spawnWorker(order, live, roster,
    { run: deps.run, env: deps.env, drained: deps.drained, claimable: pullRequest ? undefined : deps.claimable, claimer,
      memory: deps.memory, claimRefused: deps.claimRefused, toolchain: deps.toolchain });
  if ("refusal" in spawn) return { refusal: `${routed.refusal}; ${spawn.refusal}` };
  // REGISTERED BEFORE THE PROMPT, because a refused prompt leaves the process running (see `deliver`).
  deps.registerSpawn?.(spawn.label);
  return { label: spawn.label, profile: spawn.profile, claimed: spawn.claimed, workspace: spawn.workspace };
}

/**
 * What a placed target costs the ENGINEER pilot's per-tick allowance: one for a process started for an engineer, none
 * for anything else -- a reviewer start never spends it (#2401), so `MAX_SPAWNS_PER_TICK` reads as it always did.
 */
export function engineerStarts(target: { profile?: object; reviewer?: true; }): number {
  return target.profile !== undefined && target.reviewer !== true ? 1 : 0;
}

/**
 * Why this target cannot answer now, or `null`. A process this tick STARTED has a fresh allowance question no
 * transcript can answer yet, so it is not asked (#2256).
 */
export function whyUnavailable(target: { label: string; profile?: object; }, unavailable: ((label: string) => string | null) | undefined): string | null {
  return target.profile ? null : (unavailable?.(target.label) ?? null);
}

/**
 * A capped cause (#2685): work-gate marked it `outageNow` when this run shares its reason with every other
 * one marked the same way -- GitHub itself refusing reads, not this row's own trouble -- so it is named
 * separately from `stuck`, which `finishTick` hands to `escalateStuck` one row at a time. Handing an
 * outage-marked cause to `escalateStuck` too would label as many rows `answer:ceo` as there are causes.
 */
export function recordCapped({ stuck, outaged }: { stuck: string[]; outaged: string[]; }, order: { causeKey: string; outageNow?: boolean; }, already: number) {
  if (order.outageNow) outaged.push(order.causeKey);
  else stuck.push(`${order.causeKey}: delivered ${already} times and the cause is still true`);
}

// --- #4070: THE CALM-FINISH A/B'S RECORD, AND THE CAP ON A CLAIM'S REPEAT ORDERS (#4055 move 2) ---

/** The session an order goes to instead of the worker once its claim has been sent {@link MAX_CONTINUATIONS} gate orders. */
export const CONTINUATION_ESCALATE_TO = "orchestrator";

/** gate orders sent so far per claim, and the writer of the next line */
export type ClaimOrders = {counts: Map<string, number>, append: (entry: Record<string, unknown>) => void};

/**
 * THE CLAIM A GATE ORDER BELONGS TO, or `null` when it is not a repeat order to a LIVE worker on one (#4070). Asked of the order's addressee before it is
 * routed: a spare instance holds exactly one row and is named for it (`worker-<row>`), so its claim IS the row; a standing engineer seat holds
 * successive claims, so its claim is the seat and the order's subject. Counting by the SESSION would charge one claim's orders to the next row the same
 * seat takes, and counting by the cause would give each cause its own allowance; neither is the claim.
 */
function claimOfOrder(order: { session: string; cause?: string; subject?: string; }, live: { label: string; }[], roster: string[]): string | null {
  if (!CONTINUATION_CAUSES.includes(String(order.cause)) || !live.some((a) => a.label === order.session)) return null;
  const member = familyMember(order.session, SPARE_FAMILIES);
  if (member !== null) return `row-${member.key === "" ? "" : `${member.key}#`}${member.number}`;
  return roster.includes(order.session) ? `${order.session}/${order.subject ?? order.cause}` : null;
}

/**
 * The order `orchestrator` receives in place of the worker's nth: the same cause and key, a new addressee, and the sentence that says why it is not the
 * worker's. The dead-owner fallback and `resume` are the worker's own routing and are dropped with it.
 */
export function escalatedContinuation(order: { session: string; prompt: string; cause?: string; causeKey: string; fallback?: string; fallbackPrompt?: string; fallbackOnlyIfAbsent?: boolean; resume?: boolean; }, { claim, number }: { claim: string; number: number; }) {
  const { fallback, fallbackPrompt, fallbackOnlyIfAbsent, resume, ...kept } = order;
  return { ...kept, session: CONTINUATION_ESCALATE_TO,
    prompt: `\`${order.session}\` HAS NOW BEEN SENT ${number - 1} GATE ORDERS ON ONE CLAIM (\`${claim}\`; the cap is ${MAX_CONTINUATIONS}, #4070), so the ${number}th comes to you `
      + "and not to it again: a third copy of a reminder the worker has not acted on costs it another full-context turn and has not moved it twice. Read the row and "
      + "its pull request, find what stops it, and either unblock it, release the claim or say on the row why it waits.\n\n"
      + `The order, as the worker would have received it (cause \`${order.cause}\`, key \`${order.causeKey}\`):\n\n${order.prompt}` };
}

/**
 * The number of this order on its claim, or `null` when it is not a repeat order to a live worker's claim or no record is kept: `number` is the nth gate
 * order to the claim (the record's count plus this one) and `escalated` is whether it is at or past {@link MAX_CONTINUATIONS}. Counted from what was
 * DELIVERED, so an order a refusal sends back is the same number on the next tick.
 */
export function continuationOf(order: { session: string; cause?: string; subject?: string; }, live: { label: string; }[], roster: string[], claimOrders: ClaimOrders | undefined): { claim: string; number: number; escalated: boolean; } | null {
  const claim = claimOrders === undefined ? null : claimOfOrder(order, live, roster);
  if (claim === null || claimOrders === undefined) return null;
  const number = (claimOrders.counts.get(claim) ?? 0) + 1;
  return { claim, number, escalated: number >= MAX_CONTINUATIONS };
}

/**
 * #3568: WHAT BECOMES OF AN ORDER ADDRESSED TO A SEAT THAT ENDED THIS TICK, none of it "nowhere to go" -- or `null` when the order is not about such a seat.
 * AN AUTHORED ORDER (a queued handoff, which carries `ids`) STAYS IN THE QUEUE: nothing was delivered, so nothing is retired, and the next tick's
 * {@link settleEndedOrders} re-addresses it to whoever holds what it names or drops it with its prompt kept. A DERIVED CAUSE IS DROPPED, because the gate
 * derives it again from the row on the next tick and an order written to the ledger now would suppress that for the whole wake window.
 *
 * @returns the line for the tick log
 */
export function endedSeatLine(order: { causeKey: string; session: string; ids?: string[]; }, gone: ReadonlyMap<string, string>): string | null {
  const why = gone.get(order.session);
  if (why === undefined) return null;
  return order.ids === undefined
    ? `DROPPED ${order.causeKey}: "${order.session}" ended this tick (${why}); the next tick derives it again from the row.`
    : `LEFT QUEUED ${order.causeKey}: "${order.session}" ended this tick (${why}); the queue keeps it for the next tick.`;
}
/**
 * `rows` is EVERY row the instance held, oldest first (#2407), and its ABSENCE is what marks a legacy line: one written before the field existed, which {@link consecutiveClean} counts for nothing. `released` (#2470, #2747) marks a line the GATE wrote when it took a claim back from a stalled, blocked, merged or gone holder: see {@link isReleaseLine}
 */
export type SpareCycle = { role: string, row: number | null, at: number, clean: boolean, why: string, rows?: number[], released?: "stalled" | "blocked" | "merged" | "gone" | "closed" | "wait" };

/**
 * Is this address a PERSISTENT seat -- one whose context is kept and compacted, never wiped before an order (#3415)?
 * Answered from the FILE and not a process list, so it holds for a seat that has no process yet.
 *
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function isPersistentRole(label: string, path: string | URL = SESSIONS_FILE): boolean {
  return persistentRoles(path).includes(label);
}

/**
 * Does this seat KEEP its context across orders -- a per-row instance (#2483) or a persistent seat (#3415)? The one
 * question a caller that REPORTS the delivery asks, so its wording cannot disagree with {@link clearBeforeOrder}.
 *  @param [sessions] the roster, injectable for a test
 */
export function keepsContext(label: string, sessions: string | URL = SESSIONS_FILE) {
  return isPerRowInstance(label) || isPersistentRole(label, sessions);
}

/** What `addressed` asks about the host, so a test can hand it a fixture instead of the real directory. */
export type LaunchFacts = { exists?: (path: string) => boolean, worktreesDir?: string, primary?: string };

export function readSpareRegistry(path: string, read: typeof readFileSync = readFileSync): Record<string, SpareInstance> {
  try {
    return JSON.parse(String(read(path, "utf8")));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Note that a process was STARTED for `role`. A registry entry already there means the previous instance left
 * without the teardown -- closed by hand, crashed -- and THAT is a failed cycle, written now because this is the
 * one moment the role is known to have been absent rather than merely missing from a partial list.
 */
export function registerSpawn(paths: { registry: string; cycles: string; }, role: string, now: number = Date.now()) {
  const registry = settleAbsentInstance(paths, role, now);
  registry[role] = { spawnedAt: now, rows: [] };
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
}

/**
 * A registry entry for a role that holds NO process is an instance that left without the teardown (closed by hand,
 * crashed): a FAILED cycle, written here and the entry dropped, because this is the one moment the role is known to
 * have been absent rather than merely missing from a partial list. Returns the registry without it.
 *
 * ASKED BEFORE A SPAWN'S CLAIM AS WELL AS AFTER IT (#2407): the claim runs as the new instance, and `row-claim`
 * refuses a spare a second row on the strength of this very registry, so a leftover entry would refuse the first
 * claim of the next instance to take that address -- and the lowest free address is chosen every tick, so nothing
 * would ever spawn again. Idempotent: the second call finds nothing.
 */
export function settleAbsentInstance(paths: { registry: string; cycles: string; }, role: string, now: number = Date.now()): Record<string, SpareInstance> {
  const registry = readSpareRegistry(paths.registry);
  if (registry[role] === undefined) return registry;
  appendSpareCycle(paths.cycles, absentInstanceCycle(role, registry[role], now));
  delete registry[role];
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
  return registry;
}

/**
 * The failed cycle for an instance that left without the teardown, shared by {@link settleAbsentInstance} (a spawn
 * finds the leftover) and {@link settleGoneInstances} (the tick finds it, #2860).
 */
export function absentInstanceCycle(role: string, instance: SpareInstance, now: number): SpareCycle {
  const { rows } = instance;
  return { role, row: rows.length > 0 ? rows[rows.length - 1] : null, at: now, clean: false, rows,
    why: "the previous instance left without the teardown (closed by hand or crashed)" };
}

export function appendSpareCycle(path: string, cycle: SpareCycle) {
  writeFileSync(path, `${JSON.stringify(cycle)}\n`, { flag: "a" });
}

/**
 * THE OUTSIDE REVIEWER'S PANE, read FAR deeper than {@link paneReader}'s forty lines: its verdict block is written at the end of a long review,
 * and the block is what the gate posts (#1311). The gate reads it once a tick, so the cost is one herdr call per outside reviewer.
 */
export function outsidePaneReader(run: (args: string[]) => string): (label: string) => string | null {
  return (label) => {
    try {
      return run(["--session", "org", "agent", "read", herdrAgentName(label), "--source", "recent", "--lines", "400"]);
    } catch {
      return null;
    }
  };
}

/**
 * #1311: THE GATE POSTS EACH OUTSIDE REVIEWER'S VERDICT, outside the sandbox, from the pane the reviewer wrote it in. It reads the registry for
 * the outside entries, and only those: an inside reviewer posts its own verdict through the door as it always did. The door runs with the
 * reviewer's identity (`reviewerEnvironment`), which the sandboxed reviewer never had.
 */
export function postOutsideVerdictsOf(registry: Record<string, ReviewerEntry>, run: (args: string[]) => string, doorRun?: DoorRun, dir: string = REVIEWER_STATE_DIR): string[] {
  const outside = Object.entries(registry).flatMap(([session, entry]) => {
    if (entry.trust !== OUTSIDE) return [];
    const pr = reviewerInstance(session)?.number ?? null;
    return pr === null ? [] : [{ session, pr }];
  });
  if (outside.length === 0) return [];
  // agent-org#1649: each pane is read ONCE a tick. With `reviews.verdictDelivery` OFF nothing is recorded and no bulleted block is read: the verdict signal reads
  // nothing, and the panes are read as they always were. ON, the bulleted blocks are recorded (the signal's clock starts when a verdict is first seen) and posted.
  const panes = new Map<string, string | null>();
  const read = (session: string): string | null => {
    if (!panes.has(session)) panes.set(session, outsidePaneReader(run)(session));
    return panes.get(session) ?? null;
  };
  const delivery = machineryFlagOn(readReenqueueState(dir), VERDICT_DELIVERY_FLAG);
  const written = delivery ? outside.flatMap(({ session, pr }) => {
    const verdict = outsideVerdictBlock(read(session), pr, { bulleted: true });
    return verdict === null ? [] : [{ session, pr, head: verdict.head, verdict: verdict.verdict }];
  }) : [];
  const recorded = delivery ? recordWrittenVerdicts({ dir, written, now: Date.now() }) : null;
  const lines = postOutsideVerdicts({ outside, read, env: (session) => reviewerEnvironment(session), door: reviewerDoorPath(), run: doorRun, delivery });
  return recorded === null ? lines : [recorded, ...lines];
}
