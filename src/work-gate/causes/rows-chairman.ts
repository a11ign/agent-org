import { subjectMention, subjectRef } from "../../review-attribution.ts";
import { PROVENANCE as CHAIRMAN_ANSWER_PROVENANCE } from "../../messaging/answers.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "../../project-vocabulary.ts";
import { readWaitFacts } from "../org-health.ts";
import { chairmanAskOrders } from "../chairman-ask-orders.ts";
import { defaultRun, repoNow } from "../reads/read-memo-and-exit.ts";
import { rows } from "../../plugins/rows.ts";
import { CHAIRMAN_LOGINS, MAX_ROW_ORDERS_PER_TICK, labelledRows } from "../vocabulary.ts";

/**
 * Rows waiting on the chairman, oldest first.
 *
 * WHY THIS EXISTS, MEASURED: #63 (the org transfer) sat four days with its last comment from the chairman
 * on 2026-09-14, blocking eight publish-gated rows. `ceo` escalated correctly and `product-manager`
 * reported it correctly in every sweep. THE ESCALATION PATH SIMPLY ENDS AT `ceo`, whose onward route is a
 * sentence in a brief rather than a mechanism -- so it surfaced only because the chairman happened to read
 * a sweep in a terminal. That is the same shape as the standing crons #912 retired: a rule written down
 * with nothing behind it.
 *
 * THE GATE CANNOT WAKE A HUMAN, and this does not pretend to. It wakes `ceo`, which is the session whose
 * brief says it briefs the chairman, and it makes the count and the staleness loud enough to be read.
 *
 * `updatedAt` IS LAST ACTIVITY, NOT TIME SPENT WAITING, and the difference matters enough to say in the
 * prompt. Any edit bumps it -- a comment, a label, a milestone -- so a row genuinely stalled for four days
 * reads as fresh the moment somebody labels it, which is exactly what happened to #63 the first time this
 * ran. Measuring true waiting time would need the timeline API per row; last activity is what one cheap
 * list call honestly supports, and it answers the question that matters here: has ANYTHING happened.
 *
 *
 * @returns `null` when refused -- never [], which would read as "nobody is waiting"
 */
export function readChairmanBlocked(run: (args: string[]) => string = defaultRun): any[] | null {
  try {
    const parsed = labelledRows({ label: CHAIRMAN_LABEL, state: "OPEN", select: "number title updatedAt", newest: 100, run });
    return withChairmanEventTimes(parsed.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))), run);
  } catch {
    return null;
  }
}

/** @param times ISO times @returns the newest, or `null` for none */
function newestTime(times: string[]): string | null {
  const dated = times.filter((t) => Number.isFinite(Date.parse(t)));
  return dated.length === 0 ? null : dated.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/**
 * When `needs:chairman` was LAST applied to the row, or `null` when no `labeled` event could be read for it. The last one, because a
 * label taken off and applied again is a new ask -- that is how a row is re-asked, as data rather than prose.
 */
function readChairmanLabelledAt(number: number, run: (args: string[]) => string) {
  return newestTime(rows().labeledEventTimesOf({ number, label: CHAIRMAN_LABEL, run }));
}

/**
 * When the chairman last acted on the row: a comment by the chairman's own login, or the answer comment `answers.ts` writes (a bot's
 * account carrying `PROVENANCE` as its FIRST words -- a line quoted further down is somebody repeating it, not the chairman answering).
 * `null` when there is none. The body is cut in the projection: the provenance line is the first line and nothing else is read.
 */
function readChairmanEventAt(number: number, run: (args: string[]) => string) {
  const events = rows().commentActivityOf({ number, run }).filter((c) => CHAIRMAN_LOGINS.includes(c.author) || String(c.body).startsWith(CHAIRMAN_ANSWER_PROVENANCE));
  return newestTime(events.map((c) => String(c.at)));
}

/**
 * Each row with `labelledAt` and `chairmanEventAt` (ISO or `null`) attached -- the two times `chairmanAnsweredOrders` compares.
 * ONE PAIR OF REST CALLS PER LABELLED ROW and none when nothing carries the label (`GH_READS.conditionalOnChairmanLabelledRow`).
 *
 * A ROW WHOSE READ WAS REFUSED, OR WHOSE LABEL TIME COULD NOT BE FOUND, CARRIES `chairmanReadRefused` AND NEITHER TIME: "could not
 * determine" shares a value with neither "answered" nor "not answered" (`chairmanReadsRefused` reports them, the tick says so).
 */
export function withChairmanEventTimes(rows: any[], run: (args: string[]) => string) {
  return rows.map((row) => {
    try {
      const labelledAt = readChairmanLabelledAt(Number(row.number), run);
      if (labelledAt === null) return { ...row, chairmanReadRefused: true };
      return { ...row, labelledAt, chairmanEventAt: readChairmanEventAt(Number(row.number), run) };
    } catch {
      return { ...row, chairmanReadRefused: true };
    }
  });
}

/** @param rows rows from {@link readChairmanBlocked} @returns the rows whose timeline could not be read */
export function chairmanReadsRefused(rows: any[]): number[] {
  return rows.filter((row) => row.chairmanReadRefused === true).map((row) => Number(row.number));
}

/**
 * #3390: ONE ORDER TO `ceo` PER `needs:chairman` ROW WHOSE NEWEST CHAIRMAN-SIDE EVENT IS NEWER THAN ITS NEWEST LABEL EVENT.
 *
 * #3228 was labelled 2026-10-03T14:05:56Z, the chairman's session commented 2026-10-04T10:17:05Z, and the label stood for hours:
 * the daily reminder covers the whole set and cannot tell an answered row from an unanswered one. THE GATE WRITES NO LABELS, so it
 * orders the session whose job it is: take the label off, or take it off and apply it again after stating the new act (a newer label
 * event ends the order, so re-asking is data and not prose).
 *
 * KEYED ON THE ROW AND THE CHAIRMAN EVENT'S TIME: a new event is a new question, the same one is not asked as new. A row without both
 * times (never read, or refused) is skipped here and reported by {@link chairmanReadsRefused}; `NaN > NaN` is false, so absence is not "answered".
 */
export function chairmanAnsweredOrders(rows: any[]): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  const answered = rows.filter((row) => Date.parse(row.chairmanEventAt) > Date.parse(row.labelledAt));
  return answered.slice(0, MAX_ROW_ORDERS_PER_TICK).map((row) => {
    const ref = subjectRef(row.repoKey, row.number);
    const stamp = String(row.chairmanEventAt).replace(/[-:]/g, "");
    return {
      session: "ceo",
      cause: "chairman-answered",
      subject: `row-${ref}`,
      discriminator: stamp,
      prompt: `${subjectMention(row)} STILL CARRIES \`${CHAIRMAN_LABEL}\` AND THE CHAIRMAN HAS ACTED ON IT SINCE: the label was last `
        + `applied at ${row.labelledAt}, and the chairman-side event (their own comment, or the answer comment carrying the messaging `
        + `provenance line) is at ${row.chairmanEventAt}.\n`
        + "Read the row and do ONE of two things:\n"
        + `- it was answered: \`gh issue edit ${row.number} --remove-label ${CHAIRMAN_LABEL}\`, and record what you will do about it;\n`
        + "- it was NOT answered and something is still owed: remove the label and apply it again, after stating the NEW act the chairman "
        + "must take. The label's newer event is what ends this order, so re-asking is a field and not a sentence.\n"
        + "A stale label re-alerts the chairman and makes the count meaningless (#3228 held it for hours).",
      causeKey: `ceo/chairman-answered/row-${ref}/${stamp}`,
    };
  });
}

/**
 * Whole days between an ISO timestamp and `now`. Floor, so "today" reads 0 rather than a fraction.
 */
export function daysSince(iso: string, now: number = Date.now()) {
  const at = Date.parse(String(iso));
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

/**
 * #4020: THE TICK'S DECLARED-ASK STEP over the open rows, with the gate's own runner and reader. It reads nothing for an org in which no row declares an ask.
 */
export const chairmanAsksNow = (openRowsRead: any[] | null): any[] => chairmanAskOrders({ rows: openRowsRead, now: Date.now() },
  { run: defaultRun, repo: repoNow, readItemFacts: readWaitFacts, limit: MAX_ROW_ORDERS_PER_TICK });
