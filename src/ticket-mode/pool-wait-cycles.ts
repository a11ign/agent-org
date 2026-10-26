// @ts-check
// module: the chairman's session hears of a wait cycle once (A11-272) -- one tracker comment on the cycle's smallest key and one log line, and the record that says it was told
//
// `pool-ticket-wait.ts` breaks what it can of every cycle `board-view/wait-cycles.ts` finds, on the tick, and this module tells what was found. The comment says what the board did (a run released and queued behind its
// ticket) or what it could not do and a person must (a cycle of blockers alone, a pull request wait, a batch's shared run). It is posted once the board has done what it can, so a workspace herdr would not close is
// told on the tick after it closes. "Once" is `tickets/wait-cycles.json` in the state folder, written whole after the tracker accepted the comment, so a refused one is tried again on the next tick; a cycle the
// board no longer finds is removed from it, so one that forms again later is told again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cycleSentence, waitCycles, type WaitCycle, type WaitEdge } from "./board-view/wait-cycles.ts";
import { waitersOn } from "./board-view/waits-on.ts";
import { log, messageOf } from "./pool-state.ts";
import { find } from "./queue/queue-entries-and-outcomes.ts";
import { POLL_EVERY_MS } from "./wait-on/wait-watch.ts";
import { type PoolContext } from "./pool-context.ts";

/** The record's file in the state folder. */
const LEDGER_FILE = "wait-cycles.json";

/** A cycle that was told: when, and the key of the ticket the comment is on. */
type Told = Readonly<{ at: number; on: string }>;

/** A notice for the tracker: the cycle it is of, the ticket it is posted on, and its words. */
type Notice = Readonly<{ id: string; on: string; body: string }>;

/** A notice the tracker refused, kept to be posted again, at most once a minute, even if its cycle has cleared since: the tracker is awaited on the tick, and a slow one is not asked on every pass. */
type Refused = Readonly<{ notice: Notice; retryAt: number }>;

/**
 * What the board remembers of the cycles it told: the record on disk, the notices still to post, and the cycles it found while a release was unfinished (`awaiting`). A cycle can clear before its release is done: the
 * ticket a run waits on starts on the files the run still holds, and the cycle is gone, though the run is not.
 */
type Ledger = { told: Record<string, Told>; pending: Map<string, Refused>; awaiting: Map<string, WaitCycle>; refusedLogged: Set<string> };

const ledgers = new WeakMap<PoolContext, Ledger>();

const ledgerPath = (ctx: PoolContext): string => join(ctx.settings.stateDir, "tickets", LEDGER_FILE);

/** The record on disk, or an empty one when there is none or it cannot be read, which is said. */
function readTold(ctx: PoolContext): Record<string, Told> {
  const path = ledgerPath(ctx);
  if (!existsSync(path)) return {};
  try {
    const told: unknown = JSON.parse(readFileSync(path, "utf8")).told;
    return typeof told === "object" && told !== null ? (told as Record<string, Told>) : {};
  } catch (err) {
    log(`${path} could not be read (${messageOf(err)}), so the wait cycles it recorded may be told again`);
    return {};
  }
}

const ledgerOf = (ctx: PoolContext): Ledger => {
  const held = ledgers.get(ctx) ?? { told: readTold(ctx), pending: new Map(), awaiting: new Map(), refusedLogged: new Set() };
  ledgers.set(ctx, held);
  return held;
};

/** Write the record whole, saying so when it cannot be written: the cycles it holds are then told again after a restart. */
function writeTold(ctx: PoolContext, told: Readonly<Record<string, Told>>): void {
  const path = ledgerPath(ctx);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ told })}\n`);
  } catch (err) {
    log(`${path} could not be written (${messageOf(err)}), so a restart tells these wait cycles again`);
  }
}

/** Whether the pass has anything to do about wait cycles: one is found, one was told and may have cleared, or a notice is waiting to be posted. */
export function waitCyclesDue(ctx: PoolContext, found: readonly WaitCycle[]): boolean {
  const ledger = ledgerOf(ctx);
  return found.length > 0 || Object.keys(ledger.told).length > 0 || ledger.pending.size > 0 || ledger.awaiting.size > 0;
}

/**
 * The files edges of a cycle that the overlap hold already lifts (A11-272): the run that holds the files waits on the ticket it holds them against, directly or through the tickets in between, so that ticket starts on them and
 * the cycle is broken by the queue itself (A11-298).
 */
function liftedHolds(ctx: PoolContext, cycle: WaitCycle): WaitEdge[] {
  const entries = ctx.store.get().entries;
  return cycle.edges.filter(({ kind, from, to }) => kind === "files" && waitersOn(from, entries).has(to));
}

/** What the board did about a cycle by lifting the holds above: each holder that waits on the ticket it holds files against, and the ticket that starts on them. */
const liftedWords = (lifted: readonly WaitEdge[]): string =>
  `The board lifts ${lifted.map(({ from, to }) => `${to}'s hold on ${from}`).join(" and ")}, since ${lifted.length === 1 ? "that run waits" : "those runs wait"} on the ticket${lifted.length === 1 ? "" : "s"} held back, so ${lifted.map(({ from }) => from).join(" and ")} can start on those files.`;

/** What a person must do about a cycle the board cannot break: remove a blocker relation where the cycle has one, else end one of its waits or narrow a plan. */
function personMust(cycle: WaitCycle): string {
  const blockers = cycle.edges.filter(({ kind }) => kind === "blocked-by");
  if (blockers.length > 0) return `The board cannot break it: a person must remove one blocker relation in the tracker (${blockers.map(({ from, to }) => `${to} blocks ${from}`).join("; ")}).`;
  return "The board cannot break it: a person must end one of these waits or narrow one of the plans so their files do not overlap.";
}

/** What the board did about the members of a cycle, as the comment says it: each run it released and the tickets it was queued behind. */
function releasedWords(ctx: PoolContext, released: ReadonlySet<string>): string[] {
  return [...released].sort().map((key) => {
    const behind = find(ctx.store.get(), key)?.stoppedForBlocker?.keys ?? [];
    return `released ${key}'s run and queued it behind ${behind.join(", ")}; it resumes its own session once ${behind.length === 1 ? "that ticket is" : "those tickets are"} done`;
  });
}

/** What the pass did about a cycle: the runs it released, and whether the cycle is still there after it. */
type Outcome = Readonly<{ released: ReadonlySet<string>; remains: boolean }>;

/** The comment for a cycle: its sentence, then what the board did or what a person must. */
function noticeOf(ctx: PoolContext, cycle: WaitCycle, { released, remains }: Outcome): Notice {
  const did = releasedWords(ctx, new Set(cycle.keys.filter((key) => released.has(key))));
  const lifted = liftedHolds(ctx, cycle);
  const tail = [did.length === 0 ? null : `The board ${did.join(", and ")}.`, lifted.length === 0 ? null : liftedWords(lifted), remains && lifted.length === 0 ? personMust(cycle) : null].filter((part) => part !== null);
  return { id: cycle.id, on: cycle.keys[0], body: [cycleSentence(cycle), ...tail].join(" ") };
}

/** Post a notice on its ticket and record it told, or say once that the tracker refused it and keep it for the next tick. A tracker with no `comment` gets the log line only, and the cycle is marked told. */
async function post(ctx: PoolContext, ledger: Ledger, notice: Notice): Promise<void> {
  const { now, source } = ctx;
  try {
    await source.comment?.(notice.on, notice.body);
  } catch (err) {
    ledger.pending.set(notice.id, { notice, retryAt: now() + POLL_EVERY_MS });
    if (!ledger.refusedLogged.has(notice.id)) log(`${notice.on}: the tracker refused the wait cycle comment (${messageOf(err)}), so the board asks again on every pass`);
    ledger.refusedLogged.add(notice.id);
    return;
  }
  log(`${notice.on}: ${notice.body}${source.comment === undefined ? " (this tracker cannot post comments, so the board's log is all that says it)" : ""}`);
  ledger.pending.delete(notice.id);
  ledger.refusedLogged.delete(notice.id);
  ledger.told[notice.id] = { at: now(), on: notice.on };
  writeTold(ctx, ledger.told);
}

/** Drop from the record the cycles that neither pass found: when one forms again it is told again. */
function forgetCleared(ctx: PoolContext, ledger: Ledger, alive: ReadonlySet<string>): void {
  const kept = Object.fromEntries(Object.entries(ledger.told).filter(([id]) => alive.has(id)));
  if (Object.keys(kept).length === Object.keys(ledger.told).length) return;
  ledger.told = kept;
  writeTold(ctx, kept);
}

/**
 * Tell the chairman's session of the wait cycles one pass found (A11-272), once each. `before` is what the pass found first, `released` the runs it let go, and `unfinished` the runs it meant to release and could not yet: a
 * cycle with one of them is told on a later pass, even if it has cleared by then, but only when the board released a run of it meanwhile. A cycle that is still there after the pass says a person must break it.
 * Notices the tracker refused earlier are posted again first.
 */
export async function tellWaitCycles(ctx: PoolContext, before: readonly WaitCycle[], released: ReadonlySet<string>, unfinished: ReadonlySet<string>): Promise<void> {
  const ledger = ledgerOf(ctx);
  const after = waitCycles(ctx.store.get().entries);
  for (const { notice, retryAt } of [...ledger.pending.values()]) if (ctx.now() >= retryAt) await post(ctx, ledger, notice);
  const found = new Set(before.map(({ id }) => id));
  const earlier = [...ledger.awaiting.values()].filter(({ id }) => !found.has(id));
  for (const cycle of [...before, ...earlier]) {
    if (cycle.keys.some((key) => unfinished.has(key))) {
      ledger.awaiting.set(cycle.id, cycle);
      continue;
    }
    ledger.awaiting.delete(cycle.id);
    const clearedByItself = !found.has(cycle.id) && !cycle.keys.some((key) => released.has(key));
    if (clearedByItself || ledger.told[cycle.id] !== undefined || ledger.pending.has(cycle.id)) continue;
    await post(ctx, ledger, noticeOf(ctx, cycle, { released, remains: after.some(({ id }) => id === cycle.id) }));
  }
  forgetCleared(ctx, ledger, new Set([...before, ...after, ...ledger.awaiting.values()].map(({ id }) => id)));
}
