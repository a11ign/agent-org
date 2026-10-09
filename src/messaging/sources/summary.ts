// THE DAILY SUMMARY SOURCE (a11ign/a11ign#2903, done-whens 3 and 4): COUNTS READ FROM GITHUB, AT THE CONFIGURED LOCAL TIME, ONCE PER LOCAL
// DATE, SILENT. A LEAF module: it imports nothing from the tool and reads GitHub only through the injected reader.
//
// **ONCE PER LOCAL DATE IS THE KEY'S JOB, AND THE CLOCK ONLY DECIDES WHEN THE KEY EXISTS.** The source emits `summary:<local date>` on every
// tick from the configured time to midnight, and the core's ledger lets the first through and calls the rest duplicates. So a timer that
// fires late (`Persistent=true` after a reboot), twice, or after a restart cannot send two, and a summary missed at 08:00 is sent when the
// next tick comes, its "as of" stamp saying how late. The summary does not "remind" and does not resolve: the date changes the key.
//
// **THE LOCAL DATE AND TIME COME FROM `Intl`, NEVER FROM AN OFFSET.** "08:00 in Europe/London" is 08:00Z in winter and 07:00Z in summer; a
// fixed offset is right for half the year, and the day after a change is when it is wrong. `Intl.DateTimeFormat(..., { timeZone })` knows
// the zone's own rules, and the tests pin both sides of both 2026 changes.
//
// **A COUNT IS READ, OR IT IS SAID TO BE UNREAD, AND IT IS NEVER ZERO BY DEFAULT.** A read that failed prints `unread` and the reason; it
// does not print 0, because "0 red" and "I could not look" are different states and the second must not wear the first's face. When EVERY
// read fails nothing is emitted (GitHub is down, and a summary of five "unread" lines tells nobody anything): the next tick tries again.

export const READY_LABEL = "ready";
export const IN_PROGRESS_LABEL = "in-progress";
export const NEEDS_CHAIRMAN_LABEL = "needs:chairman";
const DAY_MS = 86_400_000;
const MINUTES_PER_HOUR = 60;
/** Where `HH:MM` sits in an ISO timestamp (`2026-10-02T07:00:00.000Z`). */
const ISO_CLOCK = Object.freeze({ from: 11, to: 16 });
/** More than this is read as "cut off" and refused, rather than counted as if it were the whole. */
export const SUMMARY_LIST_LIMIT = 500;

/**
 * Which instant the local clock reads. `hourCycle: "h23"` because `hour12: false` makes some runtimes print midnight as "24".
 * `ms` is epoch milliseconds and `timeZone` an IANA zone; returns the local calendar date as YYYY-MM-DD, and minutes since local midnight.
 */
export function localClock(ms: number, timeZone: string): { date: string; minutes: number; } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, minutes: Number(part("hour")) * MINUTES_PER_HOUR + Number(part("minute")) };
}

/** Minutes since midnight, from `at` as "HH:MM". */
function minutesOf(at: string): number {
  const [hour, minute] = at.split(":").map(Number);
  return hour * MINUTES_PER_HOUR + minute;
}

/**
 * `at` has been reached TODAY, in the zone's own clock. `>=` and not `===`: a tick that arrives at 08:03 is on time, and one that arrives
 * at 14:00 after the machine was off still owes the day's summary. A time the zone skips (01:30 on a spring-forward day) is reached
 * at the first minute after the gap.
 */
export function summaryDue({ nowMs, at, timeZone }: { nowMs: number; at: string; timeZone: string; }): { due: boolean; date: string; } {
  const clock = localClock(nowMs, timeZone);
  return { due: clock.minutes >= minutesOf(at), date: clock.date };
}

/** `date` is the LOCAL date, YYYY-MM-DD. */
export function summaryKey(date: string): string {
  return `summary:${date}`;
}

type Reading = { ok: true; count: number } | { ok: false; reason: string };
export type SummaryCounts = { waiting: Reading; ready: Reading; merged: Reading; red: Reading; stalled: Reading };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `keep` says which of the rows count; the cut-off test is on the list as READ, before this.
 * The count is the LENGTH of what the reader returned, so a fixture returning three rows yields 3 and nothing here can type a number.
 */
async function count<T>(read: () => Promise<T[]>, keep: (row: T) => boolean = () => true): Promise<Reading> {
  try {
    const rows = await read();
    if (!Array.isArray(rows)) return { ok: false, reason: "the reader did not return a list" };
    if (rows.length >= SUMMARY_LIST_LIMIT) return { ok: false, reason: `${rows.length} or more, the limit of the read` };
    return { ok: true, count: rows.filter(keep).length };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

export type SummaryReader = {
  issuesLabelled: (query: { repo: string; label: string; limit?: number }) => Promise<{ updatedAt?: string }[]>;
  mergedPullsSince: (query: { repo: string; sinceMs: number; limit?: number }) => Promise<unknown[]>;
  redPulls: (query: { repo: string; limit?: number }) => Promise<unknown[]>;
};

/**
 * "Stalled" here is the cheapest honest reading: a claimed row nobody has touched for a day. The work gate's own two-hour claim nudge
 * and the `stall:no-merge` event (row 5) are finer instruments and are not repeated here.
 */
export async function readSummaryCounts({ github, repo, nowMs }: { github: SummaryReader; repo: string; nowMs: number; }): Promise<SummaryCounts> {
  const limit = SUMMARY_LIST_LIMIT;
  const sinceMs = nowMs - DAY_MS;
  const [waiting, ready, merged, red, stalled] = await Promise.all([
    count(() => github.issuesLabelled({ repo, label: NEEDS_CHAIRMAN_LABEL, limit })),
    count(() => github.issuesLabelled({ repo, label: READY_LABEL, limit })),
    count(() => github.mergedPullsSince({ repo, sinceMs, limit })),
    count(() => github.redPulls({ repo, limit })),
    count(() => github.issuesLabelled({ repo, label: IN_PROGRESS_LABEL, limit }), (row) => Date.parse(String(row.updatedAt)) < sinceMs),
  ]);
  return { waiting, ready, merged, red, stalled };
}

function show(reading: Reading): string {
  return reading.ok ? String(reading.count) : `unread (${reading.reason})`;
}

/** HH:MMZ, the stamp the design's "as of" uses. */
function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(ISO_CLOCK.from, ISO_CLOCK.to)}Z`;
}

/**
 * Each line says what it counted, because "stalled" and "red" mean what a reader assumes unless told.
 */
export function formatSummary({ date, asOfMs, counts }: { date: string; asOfMs: number; counts: SummaryCounts; }): string {
  return [
    `Daily summary ${date} (as of ${stamp(asOfMs)})`,
    `Waiting on you: ${show(counts.waiting)}`,
    `Ready rows: ${show(counts.ready)}`,
    `Merged in the last 24 h: ${show(counts.merged)}`,
    `Red (open pull requests with a failing check): ${show(counts.red)}`,
    `Stalled (in-progress rows untouched for 24 h): ${show(counts.stalled)}`,
  ].join("\n");
}

/**
 * Zero events before the time, one after it. THROWS nothing for a failed read (see the head of this file): all failed is zero events.
 * `unread` names each read that failed, for the caller's log.
 */
export async function observeSummary({ github, repo, now, summary }: { github: SummaryReader; repo: string; now: number; summary: { at: string; timezone: string; }; }): Promise<{ events: Record<string, unknown>[]; unread: string[]; }> {
  const { due, date } = summaryDue({ nowMs: now, at: summary.at, timeZone: summary.timezone });
  if (!due) return { events: [], unread: [] };
  const counts = await readSummaryCounts({ github, repo, nowMs: now });
  const readings = Object.entries(counts);
  const unread = readings.flatMap(([name, reading]) => (reading.ok ? [] : [`${name}: ${reading.reason}`]));
  if (unread.length === readings.length) return { events: [], unread };
  return {
    events: [{
      key: summaryKey(date), kind: "summary", severity: "info", firstSeenAt: now,
      text: formatSummary({ date, asOfMs: now, counts }), links: [], resolved: false,
    }],
    unread,
  };
}
