// @ts-check
// module: what the watchdog has done, in one file (A11-363) -- the restarts it made and why, and when the instance last stopped answering
//
// `watchdog.json` in the board's tickets directory, replaced whole by rename as the queue is. The WATCHDOG is its one writer: it runs outside the board (a timer's oneshot service), so a stalled board cannot keep it from
// writing, and the board only reads it (`/api/health` serves the view, `doctor` reads it, and the defect sweep asks for a ticket from it). Restarts are kept for a week; `count` is every restart since the file was made.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Why the watchdog restarted the instance: queued runs could start and none did, no `fill()` pass completed, or `/api/health` did not answer. */
export type WatchdogReason = "no-start" | "no-fill" | "no-answer";
export const WATCHDOG_REASONS: readonly WatchdogReason[] = ["no-start", "no-fill", "no-answer"];

/** One restart: when, why, and the sentence the watchdog logged for it. */
export type WatchdogRestart = Readonly<{ at: number; reason: WatchdogReason; detail: string }>;

export type WatchdogRecord = Readonly<{
  /** Every restart the watchdog has made, counted. */
  count: number;
  /** The restarts of the last RETAINED_MS, oldest first. */
  restarts: readonly WatchdogRestart[];
  /** When `/api/health` first failed to answer in the run of failures that is still going on, or null while it answers. */
  unansweredSince: number | null;
}>;

/** More restarts than this in an hour ask for a defect ticket. */
export const DEFECT_RESTARTS = 2;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** How long a restart stays in the record. */
export const RETAINED_MS = 7 * DAY_MS;
/** The most restarts the record keeps, however recent: a watchdog that restarts every minute must not grow a file the page's thread parses. */
export const RETAINED_RESTARTS = 200;

export const emptyRecord = (): WatchdogRecord => ({ count: 0, restarts: [], unansweredSince: null });

/** The file the record is kept in. */
export const watchdogPath = (stateDir: string): string => join(stateDir, "tickets", "watchdog.json");

const isReason = (value: unknown): value is WatchdogReason => WATCHDOG_REASONS.includes(value as WatchdogReason);

const isRestart = (value: unknown): value is WatchdogRestart => {
  if (typeof value !== "object" || value === null) return false;
  const { at, detail, reason } = value as Partial<WatchdogRestart>;
  return typeof at === "number" && typeof detail === "string" && isReason(reason);
};

const isRecord = (value: unknown): value is Pick<WatchdogRecord, "count" | "restarts"> & Partial<WatchdogRecord> => {
  if (typeof value !== "object" || value === null) return false;
  const { count, restarts } = value as Partial<WatchdogRecord>;
  return typeof count === "number" && Array.isArray(restarts) && restarts.every(isRestart);
};

/** The record on disk, or an empty one when there is no file. A file that cannot be read THROWS: reading it as empty would forget the restarts and the hour a defect was asked for. */
export function readRecord(path: string): WatchdogRecord {
  if (!existsSync(path)) return emptyRecord();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} is not a watchdog record`);
  return { count: parsed.count, restarts: parsed.restarts, unansweredSince: typeof parsed.unansweredSince === "number" ? parsed.unansweredSince : null };
}

/** Why the record at `path` cannot be read (the first line of the reader's refusal), or null when it can be, or is not there yet. */
export function recordProblem(path: string): string | null {
  try {
    readRecord(path);
    return null;
  } catch (err) {
    return String((err as Error)?.message ?? err).split("\n")[0] ?? "it cannot be read";
  }
}

/**
 * Sets an unreadable record aside, beside itself as `<path>.unreadable-<stamp>`, so the watchdog starts a record of its own without writing over the one it could not read (a person can look at it, and what it held is kept).
 * Answers where it went, or null when it could not be moved.
 */
export function setUnreadableAside(path: string, at: number): string | null {
  const aside = `${path}.unreadable-${new Date(at).toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(path, aside);
    return aside;
  } catch {
    return null;
  }
}

/** Replace the file whole: write beside it, then rename over it. */
export function writeRecord(path: string, record: WatchdogRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(next, path);
}

/** The record with a restart added, and the ones older than RETAINED_MS dropped. PURE. */
export function withRestart(record: WatchdogRecord, restart: WatchdogRestart): WatchdogRecord {
  return { count: record.count + 1, restarts: [...record.restarts, restart].filter(({ at }) => at > restart.at - RETAINED_MS).slice(-RETAINED_RESTARTS), unansweredSince: null };
}

/** The restarts in the hour that starts at `hourStart` (ms since the epoch, a whole hour). PURE. */
export const restartsInHour = (record: WatchdogRecord, hourStart: number): readonly WatchdogRestart[] => record.restarts.filter(({ at }) => at >= hourStart && at < hourStart + HOUR_MS);

/** The whole hour `at` is in, as ms since the epoch. PURE. */
export const hourOf = (at: number): number => Math.floor(at / HOUR_MS) * HOUR_MS;

/** What `/api/health` serves of the record, and the header and `doctor` flag: any restart in the last day. */
export type WatchdogView = Readonly<{ restartsLastHour: number; restartsLastDay: number; restartsTotal: number; last: WatchdogRestart | null;
  /** Why the record cannot be read, when it cannot: its restarts are then not counted, and the header and `doctor` say so instead of showing none. */
  unreadable?: string }>;

/** The view of a record at `now`. PURE. */
export function watchdogView(record: WatchdogRecord, now: number): WatchdogView {
  const within = (ms: number) => record.restarts.filter(({ at }) => at > now - ms).length;
  return { restartsLastHour: within(HOUR_MS), restartsLastDay: within(DAY_MS), restartsTotal: record.count, last: record.restarts[record.restarts.length - 1] ?? null };
}

/** The view of the record at `path` at `now`: none when the watchdog has restarted nothing, and a view that says it cannot be read when the file is there and is not a record. */
export function viewOfFile(path: string, now: number): WatchdogView | null {
  const unreadable = recordProblem(path);
  if (unreadable !== null) return { restartsLastHour: 0, restartsLastDay: 0, restartsTotal: 0, last: null, unreadable };
  const record = readRecord(path);
  return record.count === 0 ? null : watchdogView(record, now);
}

/** How long the page's thread keeps the view it read, in ms: the record changes a few times a day, and `/api/health` is read every few seconds. */
export const VIEW_CACHE_MS = 5_000;

/** The view of the record at `path`, read at most every VIEW_CACHE_MS, and null when the record has no restart on it (so `/api/health` says nothing of a watchdog that never acted). */
export function cachedWatchdogView(path: string, now: () => number = Date.now): () => WatchdogView | null {
  let kept: Readonly<{ at: number; view: WatchdogView | null }> | null = null;
  return () => {
    const at = now();
    if (kept === null || at - kept.at >= VIEW_CACHE_MS) {
      kept = { at, view: viewOfFile(path, at) };
    }
    return kept.view;
  };
}
