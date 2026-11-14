/**
 * (agent-org#2256, A11-434) THE ALLOWANCE MESSAGE CLAUDE CODE WRITES WHEN THE CLAUDE ALLOWANCE IS SPENT, AND WHEN IT SAYS THE ALLOWANCE RETURNS.
 *
 * A LEAF: it imports `node:*` only, so row mode (`wake/exit-and-limits.ts`) and ticket mode (`ticket-mode/allowance.ts`) read the message with the same rules,
 * and ticket mode does not reach the work gate to do it.
 *
 * TWO PLACES SAY IT: the transcript, as the session's own reply (the only place the message has a TIME, so the only place a short-form reset can be fixed to a
 * day), and the pane, where Claude Code draws it above its limit menu. Both are read here; finding the session's transcript and pane is the caller's.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * The line Claude Code writes as the session's own reply when the allowance is spent. MEASURED in the host's transcripts, two forms and one qualifier:
 * `resets 8am (Europe/London)` (494 lines) and, when the reset is more than a day off, `resets Sep 17, 8am (Europe/London)` (1,171), both after
 * `hit your weekly limit`. The qualifier is matched by SHAPE (`[\w-]+`), so a `session` or `5-hour` limit is read the same way but has NOT been seen.
 * The separator is matched loosely: only `·` has been captured, and `∙` or `•` are taken too, so a redrawn dot is not a missed limit. Anchored at both ends: a session QUOTING the sentence inside a
 * paragraph (this module's own text does) is not limited.
 */
const LIMIT_MESSAGE = /^You[’']ve hit your (?:[\w-]+ )?limit [·∙•] resets (?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long a limit message whose reset time cannot be read still holds a session back. A matched message with an unreadable reset is a limited session all
 * the same, so it is not offered work; but it must not hold for ever on a guess, and an hour is short beside the two it takes six deliveries to reach the cap.
 */
export const LIMIT_UNREADABLE_HOLD_MS = 60 * 60_000;

/** How much of a transcript's end is read for its last entry: the limit line is a few hundred bytes. */
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/** What leads the message on a pane line: the reply glyph Claude Code draws (`⎿`) and the spaces around it, a no-break space among them (captured 2026-10-14). */
const PANE_LEAD = /^[\s ⎿]+/u;

/** Whether `text` is the allowance message, as the whole of the session's reply or of one pane line. PURE. */
export function isLimitMessage(text: string): boolean {
  return LIMIT_MESSAGE.test(String(text).replace(PANE_LEAD, "").trim());
}

/**
 * A zone's offset from UTC at an instant. `Intl` is the tz database the host already has; nothing here carries one.
 *   @returns milliseconds
 */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric",
    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time falls on in a zone. `day` may overflow (`Date.UTC` carries it), and the offset is read
 * a second time at the first answer, so a time either side of a clock change lands on the right side.
 * @param wall `month` is 0-based
 */
function zonedInstant({ year, month, day, hour, minute }: { year: number; month: number; day: number; hour: number; minute: number; }, timeZone: string): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  return asUtc - zoneOffsetMs(asUtc - zoneOffsetMs(asUtc, timeZone), timeZone);
}

function dateInZone(instant: number, timeZone: string): { year: number; month: number; day: number; } {
  const shifted = new Date(instant + zoneOffsetMs(instant, timeZone));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * When a limit message says the allowance returns, as an instant -- or `null` when this is not a limit message or its
 * time cannot be read. THE MESSAGE CARRIES NO YEAR AND, IN ITS SHORT FORM, NO DATE, so the instant it was WRITTEN is
 * what fixes them: the first occurrence of that clock time after it. That is why a caller reads the transcript's
 * timestamp where it can and not the pane -- the same words a day later would name a different instant.
 *  @param writtenAt epoch ms
 */
export function limitResetAt(text: string, writtenAt: number): number | null {
  const m = LIMIT_MESSAGE.exec(String(text).replace(PANE_LEAD, "").trim());
  if (!m) return null;
  const [, monthName, dayOfMonth, hour12, minute = "0", meridiem, timeZone] = m;
  if (Number(hour12) < 1 || Number(hour12) > 12) return null;
  const hour = (Number(hour12) % 12) + (meridiem === "pm" ? 12 : 0);
  try {
    const today = dateInZone(writtenAt, timeZone);
    const at = (date: object) => zonedInstant({ ...today, ...date, hour, minute: Number(minute) }, timeZone);
    if (monthName) {
      const month = MONTHS.indexOf(monthName);
      if (month < 0) return null;
      const dated = at({ month, day: Number(dayOfMonth) });
      return dated > writtenAt ? dated : at({ year: today.year + 1, month, day: Number(dayOfMonth) });
    }
    const sameDay = at({});
    return sameDay > writtenAt ? sameDay : at({ day: today.day + 1 });
  } catch (err: any) {
    // An unknown zone name is the one thing `Intl` throws here; anything else is a bug and must not read as "no reset".
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/** A spent allowance as one session said it: the message, and when the allowance returns. */
export type SpentAllowance = Readonly<{ text: string; until: number; }>;

/**
 * The allowance a session's reply says is spent, or `null` when the reply is not the message. A message whose reset cannot be read holds
 * {@link LIMIT_UNREADABLE_HOLD_MS} from when it was said. PURE.
 * @param said the session's last reply as an assistant, with when it was written
 */
export function spentIn(said: Readonly<{ text: string; at: number; }>): SpentAllowance | null {
  const text = said.text.trim();
  if (!isLimitMessage(text)) return null;
  return { text, until: limitResetAt(text, said.at) ?? (said.at + LIMIT_UNREADABLE_HOLD_MS) };
}

/**
 * The allowance message a pane shows on a line of its own, or `null`. A pane has no time, so the reset is fixed from `seenAt`, the moment the pane was read:
 * the message is on screen then, so it was written no later. PURE.
 */
export function spentOnPane(pane: string, seenAt: number): SpentAllowance | null {
  const line = pane.split("\n").find(isLimitMessage);
  return line === undefined ? null : spentIn({ text: line.replace(PANE_LEAD, ""), at: seenAt });
}

/**
 * The last thing said in a transcript's tail. Lines are JSON; the first line of a tail is usually cut and a line that does not parse is skipped, so a file
 * being written cannot make this throw. Sub-agent (`isSidechain`) and bookkeeping entries are not the conversation. PURE.
 */
export function lastSaidInTail(tail: string): { role: string; text: string; at: number; } | null {
  for (const line of tail.split("\n").reverse()) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; } // a cut or half-written line: not an entry
    if ((entry?.type !== "user" && entry?.type !== "assistant") || entry.isSidechain) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content
      : (Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("") : "");
    return { role: entry.type, text, at: Date.parse(entry.timestamp) };
  }
  return null;
}

/** The last thing said in a transcript, read from its last {@link TRANSCRIPT_TAIL_BYTES}. */
export function lastSaidIn(path: string): { role: string; text: string; at: number; } | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return lastSaidInTail(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
