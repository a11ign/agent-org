/**
 * (agent-org#1307) WHEN THE CLAUDE ALLOWANCE IS SPENT, CLAUDE WORK PAUSES ACCOUNT-WIDE, AND RESUMES BY ITSELF AT THE RESET.
 *
 * ONE LIMITED SESSION IS THE ACCOUNT LIMITED: a Claude seat whose last reply is the allowance message holds every Claude seat back, because they share
 * one allowance. While the pause holds, the gate claims no row for a Claude spawn, starts no Claude worker or manager, starts no `claude -p` decision
 * run, sends no prompt to a Claude seat, and does not release a claimed row. Codex reviewers, review orders, arming, the merge queue, CI reruns and the
 * release and close-row sweeps go on, as they do in every tick.
 *
 * THE RECORD is `{ limitedUntil, seenOn, text }` per ACCOUNT, in `account-limit.json` beside the canary state. The account is the home directory the seats'
 * transcripts are read from (every seat reads under the same one today, so one account is the whole org; a second account would be a second home). The
 * pause ends by itself at `limitedUntil`; a session refused again after that re-enters with the new reset time.
 *
 * FAIL CLOSED: a record that cannot be read is not the allowance being back, so it holds Claude work until the file is repaired or removed, or the flag is
 * switched off. A flag whose state cannot be read is not a switched-off flag, so a pause already recorded still holds.
 *
 * ONE FLAG, DEFAULT OFF: `gate.accountLimitPause`, switched by `machinery:flag`. Off, nothing is read beyond the flag, nothing is written and nothing is
 * paused, which is the current behaviour. Switching it off is the revert.
 *
 * ENTERING AND LEAVING are each said ONCE, as one line and one record in `account-limit.ndjson`. Nothing is said per tick. The pure transition
 * ({@link nextLimit}) decides which, and the tick writes them. THE TIME IS AN ARGUMENT everywhere, so the rules are pinned without waiting for one.
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { machineryFlagOn, type CanaryState } from "./org-health.ts";
import { readReenqueueState } from "./work-gate/causes/pr-ejected.ts";
import { REVIEWER_STATE_DIR } from "./work-gate/vocabulary.ts";
import { ACCOUNT_LIMIT_FILE, ACCOUNT_LIMIT_FLAG, UNREADABLE_PAUSE, UNREADABLE_RECORD, pauseRecorded, readAccountLimits, type AccountLimit, type AccountLimits } from "./account-limit-record.ts";

// The record and its reader live in `account-limit-record.ts`, a leaf the canary reads too; re-exported here so the gate's importers keep their names.
export { ACCOUNT_LIMIT_FILE, ACCOUNT_LIMIT_FLAG, UNREADABLE_RECORD, pausedAt, readAccountLimits, type AccountLimit, type AccountLimits } from "./account-limit-record.ts";

/** One line per entering or leaving: the record the chairman's line is written from. */
export const ACCOUNT_LIMIT_LOG = "account-limit.ndjson";
export type LimitEvent = { kind: "enter" | "leave"; account: string; at: number; limitedUntil: number; seenOn: string; text: string; line: string; };
/** Whether the flag is on, off, or unknown because the canary state it is read from cannot be read. */
export type FlagReading = "on" | "off" | "unknown";

/**
 * The flag, read from the canary state at `dir` (or the `state` a test gives). `unknown` when that state cannot be read, which the flag's own reader reports
 * and reads OFF; an unknown flag is not a switched-off one.
 */
export function accountLimitFlag(dir: string = REVIEWER_STATE_DIR, state?: CanaryState): FlagReading {
  let unreadable = false;
  const canary = state ?? readReenqueueState(dir, () => { unreadable = true; });
  if (unreadable) return "unknown";
  try {
    return machineryFlagOn(canary, ACCOUNT_LIMIT_FLAG) ? "on" : "off";
  } catch {
    return "unknown";
  }
}

/** Written whole, to a sibling file renamed into place, so a reader never sees half a record. */
export function writeAccountLimits(path: string, limits: AccountLimits): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(limits, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The gate's pause for the tick that asks, or `null`. A flag that reads OFF holds nothing whatever the record says, so switching it off is the revert.
 * Otherwise (on, or unknown) the record for `account` decides, and a record that cannot be read holds {@link UNREADABLE_PAUSE}.
 * `dir` is the state directory the canary is read from, so a test points it at a fixture; `state` is given by a test to skip that read.
 */
export function pausedNow(now: number, dir: string = REVIEWER_STATE_DIR, state?: CanaryState, account: string = homedir()): AccountLimit | null {
  if (accountLimitFlag(dir, state) === "off") return null;
  return pauseRecorded(now, dir, account);
}

/** The state directory's log of entering and leaving, appended to by the tick. */
export function accountLimitLogPath(dir: string = REVIEWER_STATE_DIR): string {
  return join(dir, ACCOUNT_LIMIT_LOG);
}

/**
 * The tick's part: the record is moved to what {@link nextLimit} holds, and each entering or leaving is said (`say`) and appended to the log, once.
 * Returns the pause that holds after this tick, or `null`. The record is written only when it changed, so an unchanged tick writes nothing. A record that
 * cannot be read is written over only by a limit seen now; with none seen, the file is left as it is and the pause holds.
 */
export function tickAccountLimit(seen: AccountLimit | null, now: number, say: (line: string) => void, dir: string = REVIEWER_STATE_DIR,
  account: string = homedir()): AccountLimit | null {
  const path = join(dir, ACCOUNT_LIMIT_FILE);
  const limits = readAccountLimits(path);
  const held = limits?.[account];
  const { next, events } = nextLimit(held, seen, now, account);
  if (limits === null && next === undefined) return UNREADABLE_PAUSE;
  if (JSON.stringify(next) !== JSON.stringify(held)) {
    const written: AccountLimits = { ...(limits ?? {}) };
    if (next === undefined) delete written[account];
    else written[account] = next;
    writeAccountLimits(path, written);
  }
  for (const event of events) {
    appendFileSync(accountLimitLogPath(dir), `${JSON.stringify({ ...event, at: new Date(event.at).toISOString() })}\n`);
    say(event.line);
  }
  return next ?? null;
}

/** The line a refused order is given, naming the session that spent the allowance and when the pause ends. */
export function pauseRefusal(limit: AccountLimit): string {
  if (limit.seenOn === UNREADABLE_RECORD) {
    return `${ACCOUNT_LIMIT_FILE} cannot be read, so the account's Claude allowance is not known to be back (${ACCOUNT_LIMIT_FLAG}): `
      + "no Claude seat is started or prompted, and no row is claimed, until the file is repaired or removed";
  }
  return `the account's Claude allowance is spent on "${limit.seenOn}" until ${new Date(limit.limitedUntil).toISOString()} `
    + `(${ACCOUNT_LIMIT_FLAG}): no Claude seat is started or prompted, and no row is claimed, until then`;
}

function enterEvent(limit: AccountLimit, account: string, at: number): LimitEvent {
  const line = `Claude allowance spent on "${limit.seenOn}" until ${new Date(limit.limitedUntil).toISOString()}: Claude work is paused `
    + "account-wide; Codex reviews and merges go on, and Claude work resumes by itself at that reset.";
  return { kind: "enter", account, at, limitedUntil: limit.limitedUntil, seenOn: limit.seenOn, text: limit.text, line };
}

function leaveEvent(limit: AccountLimit, account: string, at: number): LimitEvent {
  const line = `Claude allowance is back (the pause that began on "${limit.seenOn}" ended at ${new Date(limit.limitedUntil).toISOString()}): Claude work resumes.`;
  return { kind: "leave", account, at, limitedUntil: limit.limitedUntil, seenOn: limit.seenOn, text: limit.text, line };
}

/**
 * THE TRANSITION, pure. `prev` is the record held, `seen` is the limit a Claude session shows NOW (or `null`), and the result is the record to hold and
 * what is said about it:
 *  - a pause already holding is EXTENDED silently by a newer reset, and a session still showing the old message says nothing (no per-tick line);
 *  - a limit seen with no pause holding is ENTERED, and a record whose reset has passed is LEFT first when a new limit replaces it (refused again);
 *  - no limit seen and a pause still holding keeps it, silently, until its reset (the session that spent it may have gone);
 *  - a record whose reset has passed, with no limit seen, is LEFT once and the record is dropped.
 */
export function nextLimit(prev: AccountLimit | undefined, seen: AccountLimit | null, now: number, account: string = homedir()):
  { next: AccountLimit | undefined; events: LimitEvent[]; } {
  const holding = prev !== undefined && prev.limitedUntil > now;
  // A limit whose reset has passed is no limit: a session still showing the old message is not a new pause.
  const live = seen !== null && seen.limitedUntil > now ? seen : null;
  if (live !== null) {
    if (holding) return { next: prev.limitedUntil >= live.limitedUntil ? prev : live, events: [] };
    return { next: live, events: [...(prev === undefined ? [] : [leaveEvent(prev, account, now)]), enterEvent(live, account, now)] };
  }
  if (prev === undefined) return { next: undefined, events: [] };
  if (holding) return { next: prev, events: [] };
  return { next: undefined, events: [leaveEvent(prev, account, now)] };
}
