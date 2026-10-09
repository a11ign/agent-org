// @ts-check
// Row #2622 (the split, child 4 of #69): the shadow-run rehearsal instrument, ADR 0040 decision 5.
//
// WHAT THIS IS FOR. The extraction (child 5, #2623) moves the org's running machinery -- `work-tick`,
// `wake`, the gate, the handoff queue, the ledgers -- into a standalone tool. That cut-over needs a
// rehearsal before it touches anything real: the extracted (candidate) gate reads BESIDE the live one for
// a stated window, and its orders are diffed against the live gate's, tick for tick. A difference is a
// defect until it is explained (decision 5). This file is the instrument that runs that diff; it does not
// perform the cut-over and it does not run the real 1,440-tick window -- that is the extraction row's job,
// against the real state, once this instrument exists and has been rehearsed here on a copy.
//
// WHY BOTH GATES ARE PARAMETERS, NOT `decide` FROM `work-gate.mjs` IMPORTED DIRECTLY. `decide()` is today's
// live gate, and the "candidate" (extracted) gate does not exist yet -- it is child 5's output. Taking both
// as plain functions keeps this instrument usable the day the candidate exists, and lets it be rehearsed
// today against fixture gates, without reaching GitHub or the fleet/lab (the resource ban in
// `.agent-org/roles/engineer.md` -- this file makes no network call of its own, ever).
//
// THE ONE THING THIS FILE MUST NEVER DO IS WRITE. Not a state file, not a ledger line, not a marker, not
// the handoff queue -- decision 5's "it never writes a state file, a ledger, a marker, or the handoff
// queue" is a structural property here: there is no write call anywhere below. `shadow-gate.test.ts` proves
// it is not merely an absence of a bug by snapshotting a real state-directory copy's files before and
// after a run and asserting the bytes are identical.
//
// THE REFUSAL COMES BEFORE ANY READ. Decision 5: "it REFUSES a state directory equal to the live one, by
// resolved real path (a symlink to it is refused too)". `refuseLiveStateDir` is called first in both
// `shadowRun` and `simulateCutover`, before either gate is ever invoked -- so a caller that points this at
// the live directory learns that before a single tick's reads are touched, not after.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateEntryPath } from "./host-config.ts"; // #2799

/**
 * Decision 5's live state directory -- the ONE directory this instrument must never operate against,
 * whether named directly or reached through a symlink. It is THE HOST'S `stateDir` (#2799), and a host that declares none
 * gets `~/.cache/a11ign`, measured live in decision 5's reading 1 (`ls ~/.cache/a11ign`): 13 state entries, all under this one path.
 */
export const LIVE_STATE_DIR = stateEntryPath("");

/**
 * `dir`'s resolved real path, or its plain resolved (unresolved-symlink) path when it does not exist.
 *
 * A directory that is not there yet cannot be a symlink to the live one, but a LITERAL path match must
 * still be caught before anything is created -- so absence falls back to a normalised compare rather than
 * throwing, the same shape `worktree-resolution.mjs`'s `realOrNull` uses one level up (there returning
 * `null` for the caller to classify; here the caller is a single equality check, so the fallback value
 * itself is the answer).
 * @param {string} dir @param {typeof realpathSync} realpath
 */
function resolvedOrLiteral(dir: string, realpath: typeof realpathSync) {
  try {
    return realpath(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * REFUSES before any read: `dir` (or a symlink chain from it) must not resolve to the live state
 * directory. Throws rather than returning a verdict, because every caller here has exactly one thing to
 * do with a positive answer -- stop.
 * @param {string} dir @param {{ liveStateDir?: string, realpath?: typeof realpathSync }} [opts]
 */
export function refuseLiveStateDir(dir: string, { liveStateDir = LIVE_STATE_DIR, realpath = realpathSync }: { liveStateDir?: string; realpath?: typeof realpathSync; } = {}) {
  const resolvedDir = resolvedOrLiteral(dir, realpath);
  const resolvedLive = resolvedOrLiteral(liveStateDir, realpath);
  if (resolvedDir === resolvedLive) {
    throw new Error(`REFUSING: ${dir} resolves to the live state directory (${liveStateDir}). `
      + "The shadow instrument operates only on a COPY, never the live directory or a symlink to it "
      + "(ADR 0040 decision 5).");
  }
}

/** the shape `work-gate.mjs`'s `decide()` returns. */
export type Order = { causeKey: string, session?: string, cause?: string, subject?: string, discriminator?: string, prompt?: string };

/**
 * Two order arrays for ONE tick, compared by `causeKey` -- the same identity `wake.mjs`'s `undelivered()`
 * dedupes by and the ledger keys on, so a difference reported here is a difference a real delivery would
 * also see. An order present on only one side, or present on both with any other field different, is a
 * difference; the same orders in a different array order are not.
 * @param {Order[]} liveOrders @param {Order[]} candidateOrders
 * @returns {{ causeKey: string, live: Order | null, candidate: Order | null }[]}
 */
export function diffOrders(liveOrders: Order[], candidateOrders: Order[]): { causeKey: string; live: Order | null; candidate: Order | null; }[] {
  const live = new Map(liveOrders.map((order) => [order.causeKey, order]));
  const candidate = new Map(candidateOrders.map((order) => [order.causeKey, order]));
  const causeKeys = new Set([...live.keys(), ...candidate.keys()]);
  const differences: { causeKey: string; live: Order | null; candidate: Order | null; }[] = [];
  for (const causeKey of causeKeys) {
    const liveOrder = live.get(causeKey) ?? null;
    const candidateOrder = candidate.get(causeKey) ?? null;
    if (JSON.stringify(liveOrder) !== JSON.stringify(candidateOrder)) differences.push({ causeKey, live: liveOrder, candidate: candidateOrder });
  }
  return differences;
}

/**
 * Every file directly under `dir`, by name, with its bytes -- so a caller can prove a run touched none of
 * them by snapshotting before and after and comparing. Not recursive: every state entry decision 5 names
 * (`wake-ledger`, `prompt-session-handoffs`, `claim-stalls.json`, ...) sits directly in the directory.
 * @param {string} dir @returns {Record<string, string>}
 */
export function stateSnapshot(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isFile()) snapshot[name] = readFileSync(full, "utf8");
  }
  return snapshot;
}

/**
 * a live or candidate gate: the same reads the tick took, plus the (copy) state directory it may read its own local state from.
 */
export type GateFn = (reads: unknown, stateDir: string) => Order[];

/**
 * The read-only mode: both gates fed the SAME reads and the SAME copy of the state directory for one
 * tick, decision 5's "because both gates read the SAME reads, the shadow adds no GitHub calls of its
 * own" -- this function makes none either; `liveGate`/`candidateGate` are the only things that read
 * anything.
 * @param {{ ticks: { tick: number, reads: unknown }[], liveGate: GateFn, candidateGate: GateFn,
 *   stateDir: string, liveStateDir?: string, realpath?: typeof realpathSync }} args
 */
export function shadowRun({ ticks, liveGate, candidateGate, stateDir, liveStateDir, realpath }: {
        ticks: { tick: number; reads: unknown; }[]; liveGate: GateFn; candidateGate: GateFn;
        stateDir: string; liveStateDir?: string; realpath?: typeof realpathSync;
    }) {
  refuseLiveStateDir(stateDir, { liveStateDir, realpath });
  const perTick = ticks.map(({ tick, reads }) => {
    const live = liveGate(reads, stateDir);
    const candidate = candidateGate(reads, stateDir);
    return { tick, live, candidate, differences: diffOrders(live, candidate) };
  });
  const differences = perTick.flatMap((t) => t.differences.map((d) => ({ tick: t.tick, ...d })));
  return { perTick, differences, firstDifference: differences[0] ?? null };
}

/**
 * The second mode: a recorded sequence of ticks replayed across a simulated cut-over on a COPY of the
 * state -- `oldGate` answers every tick before `cutAtTick`, `newGate` answers it and every tick after,
 * mirroring decision 5's "the cut is a swap of two units in the gap between ticks". Proves no tick is
 * skipped (every tick in `ticks` is answered by exactly one gate) and no order is dropped (every order
 * either gate produced appears in `allOrders`); it does not itself deliver anything -- delivery is
 * `wake.mjs`'s job, out of scope for a read-only rehearsal instrument (decision 5, "and never writes a
 * state file, a marker or the queue").
 * @param {{ ticks: { tick: number, reads: unknown }[], cutAtTick: number, oldGate: GateFn, newGate: GateFn,
 *   stateDir: string, liveStateDir?: string, realpath?: typeof realpathSync }} args
 */
export function simulateCutover({ ticks, cutAtTick, oldGate, newGate, stateDir, liveStateDir, realpath }: {
        ticks: { tick: number; reads: unknown; }[]; cutAtTick: number; oldGate: GateFn; newGate: GateFn;
        stateDir: string; liveStateDir?: string; realpath?: typeof realpathSync;
    }) {
  refuseLiveStateDir(stateDir, { liveStateDir, realpath });
  const perTick = ticks.map(({ tick, reads }) => {
    const acrossCut = tick >= cutAtTick;
    const gate = acrossCut ? newGate : oldGate;
    return { tick, gate: acrossCut ? "new" : "old", orders: gate(reads, stateDir) };
  });
  const ticksCovered = perTick.map((t) => t.tick);
  const skippedTicks = ticks.map((t) => t.tick).filter((tick) => !ticksCovered.includes(tick));
  const allOrders = perTick.flatMap((t) => t.orders);
  return { perTick, ticksCovered, skippedTicks, allOrders };
}
