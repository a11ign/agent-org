/**
 * (agent-org#1307, a11ign#5497) THE ACCOUNT PAUSE RECORD, read in ONE place by the gate (`account-limit.ts`) and by the canary (`org-health.ts`).
 *
 * A LEAF: it imports `node:*` only. `account-limit.ts` reaches the work gate, and the gate reaches `org-health.ts`, so `org-health.ts` cannot import
 * `account-limit.ts` back without a cycle that breaks the messaging tools' import graph (messaging-units-start). This module is what both can import.
 *
 * FAIL CLOSED: a record that cannot be read is not the allowance being back, so {@link pauseRecorded} holds {@link UNREADABLE_PAUSE} until the file is
 * repaired or removed. A record whose reset has passed holds nothing. The flag is NOT read here: each caller reads it from the state it has.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ACCOUNT_LIMIT_FLAG = "gate.accountLimitPause";
/** The record of each account's pause, keyed by account. */
export const ACCOUNT_LIMIT_FILE = "account-limit.json";
/** The `seenOn` of a pause held because the record cannot be read. It is never written: it holds until the file is repaired, or the flag is switched off. */
export const UNREADABLE_RECORD = "unreadable record";

export type AccountLimit = { limitedUntil: number; seenOn: string; text: string; };
export type AccountLimits = Record<string, AccountLimit>;

/** The pause held while the record cannot be read: no end, so it holds until the file is repaired or the flag is switched off. */
export const UNREADABLE_PAUSE: AccountLimit = { limitedUntil: Infinity, seenOn: UNREADABLE_RECORD, text: `${ACCOUNT_LIMIT_FILE} cannot be read` };

/**
 * The records held, keyed by account: `{}` when there is no file. `null` when the file cannot be read or is not a record, which is NOT the same as no
 * pause: the caller holds Claude work (see {@link pauseRecorded}).
 */
export function readAccountLimits(path: string): AccountLimits | null {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.values(parsed).every(isLimit) ? parsed as AccountLimits : null;
  } catch {
    return null;
  }
}

function isLimit(value: unknown): value is AccountLimit {
  const limit = value as AccountLimit;
  return typeof limit === "object" && limit !== null && Number.isFinite(limit.limitedUntil) && typeof limit.seenOn === "string" && typeof limit.text === "string";
}

/** The pause that holds at `now` for an account, or `null`: a record whose reset has passed holds nothing. */
export function pausedAt(limits: AccountLimits, now: number, account: string = homedir()): AccountLimit | null {
  const limit = limits[account];
  return limit !== undefined && limit.limitedUntil > now ? limit : null;
}

/**
 * The pause the record in `dir` holds at `now`, with the flag not read: the one reader both the gate and the canary use. A record that cannot be read holds
 * {@link UNREADABLE_PAUSE}.
 */
export function pauseRecorded(now: number, dir: string, account: string = homedir()): AccountLimit | null {
  const limits = readAccountLimits(join(dir, ACCOUNT_LIMIT_FILE));
  if (limits === null) return UNREADABLE_PAUSE;
  return pausedAt(limits, now, account);
}
