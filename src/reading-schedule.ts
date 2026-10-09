// A multi-reading row's schedule, as DATA the gate reads (#4638, class timed-reading-holds-a-worker).
//
// A row that needs a measurement three days running used to hand off by prose -- "whoever takes the next reading
// sets the Not-before for reading 3" (#3870) -- and nothing reads that sentence, so reading 3 depended on a taker
// remembering. The row now declares every reading up front and the gate derives the wait from what has been posted.
//
// ONE FIELD AND ONE RECORD, both line-anchored so a quoted or inline mention is not mistaken for either:
//   `Reading: <n> at YYYY-MM-DDTHH:MM:SSZ`   in the BODY -- reading n is due at that instant
//   `Reading <n> posted`                      in a COMMENT -- the taker's receipt for reading n
// The timestamp shape is `Not-before:`'s (seconds and the `Z` required, #2113) and so is the guard: a line that is
// malformed, or names a date the calendar does not have, is IGNORED -- it fails OPEN, never into a hold nobody can read.

/** A declared reading: its number and the instant it is due. */
export type Reading = { n: number; at: string };

const READING_FIELD = /^[ \t]*#{0,6}[ \t]*Reading:[ \t]*(\d+)[ \t]+at[ \t]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)[ \t]*$/gim;
const READING_POSTED = /^[ \t]*Reading[ \t]+(\d+)[ \t]+posted\b/gim;

/**
 * Whether a digit-shaped UTC timestamp is a date the calendar actually has. `Date.parse` silently rolls
 * `2026-02-31T04:00:00Z` over to 2026-03-03, three days later than typed, so the text is round-tripped and compared back
 * against itself (#1841). Lives here, and `waiting-condition.ts` imports it, because the dependency can only point one way.
 */
export function roundTripsUtc(iso: string): boolean {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 19) === iso.slice(0, 19);
}

/** The body's declared readings in reading order. A repeated number keeps its FIRST line, so a later edit cannot quietly move a reading. */
export function readingsDeclared(body: string | null | undefined): Reading[] {
  const byNumber = new Map<number, Reading>();
  for (const m of String(body ?? "").matchAll(READING_FIELD)) {
    const n = Number(m[1]);
    if (!byNumber.has(n) && roundTripsUtc(m[2])) byNumber.set(n, { n, at: m[2] });
  }
  return [...byNumber.values()].sort((a, b) => a.n - b.n);
}

/** The reading numbers any comment records as posted. */
export function readingsPosted(comments: readonly { body?: string | null }[] | null | undefined): Set<number> {
  const posted = new Set<number>();
  for (const comment of comments ?? []) {
    for (const m of String(comment?.body ?? "").matchAll(READING_POSTED)) posted.add(Number(m[1]));
  }
  return posted;
}

/**
 * The instant of the first declared reading with no `Reading <n> posted` on the row, or `null` when the body declares
 * none or every one is posted -- so when the last receipt lands the wait is gone and the row can close.
 *
 * PURE AND CLOCKLESS: it names the next reading whether or not it is already due. Whether that instant is still in
 * the future is `waitingOn`'s question, asked of every date wait the same way.
 */
export function nextNotBefore({ body, comments }: { body: string | null | undefined; comments: readonly { body?: string | null }[] | null | undefined }): string | null {
  const posted = readingsPosted(comments);
  return readingsDeclared(body).find((r) => !posted.has(r.n))?.at ?? null;
}
