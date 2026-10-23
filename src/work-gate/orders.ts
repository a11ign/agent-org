import { waitingOn, todayIso, describeWaiting } from "../waiting-condition.ts";
import { subjectMention } from "../review-attribution.ts";
import { START_CAUSES } from "../cause-declaration.ts";
import { BLOCKED_LABEL, SESSION_PREFIX } from "../project-vocabulary.ts";
import { DRAIN_MARKER, defaultRun } from "./reads/read-memo-and-exit.ts";
import { labelsOf } from "./vocabulary.ts";
import { rows } from "../plugins/rows.ts";

/**
 * How many open rows COULD move, and what is stopping the rest -- derived from the rows THE TICK ALREADY
 * HAS, never asked for again.
 *
 * FREE, AND THAT IS #1938. This used to be `readOpenRowState`, a second `gh issue list --state open
 * --limit 500` asking for `number,body,blockedBy` -- a strict subset of the fields `readOpenRows` had
 * already fetched over the identical population, in the same process, earlier in the same tick. It was
 * conditional, so it was cheap, but the cheapest read is the one already in hand.
 *
 * `null` IN, `null` OUT, AND THAT IS THE POINT. A REFUSED read is not an empty tracker (#1286): the
 * caller passes the UN-COALESCED `readOpenRows` result, and a refusal stays `null` the whole way into
 * `stalledOrder`. Deriving this from `main`'s `readOpenRows ?? []` instead would read a `gh` outage as
 * a healthy silent org and silence the dead man's switch on exactly the tick it matters most.
 *
 * IT RETURNS THE BREAKDOWN AS WELL AS THE COUNT, and that is the whole of #1935: this has always called
 * `waitingOn` on every open row and then thrown the answer away, keeping only `.length`. The condition --
 * date or row, WHICH date, WHICH row -- was computed and discarded at the same expression, and `ceo` then
 * spent an hour hand-reading twenty rows to recover it.
 *
 * @param rows the un-coalesced `readOpenRows` result
 * @param [today] an ISO `YYYY-MM-DD`
 * @returns `null` when the
 *   read was refused -- never a zero count, which would read as "the tracker is empty"
 */
export function openRowState(rows: any[] | null | undefined, today: string = todayIso()): { reachable: number; waiting: ReturnType<typeof waitingBreakdown>; } | null {
  if (!Array.isArray(rows)) return null;
  // ROWS THAT ARE CORRECTLY WAITING ARE NOT A STALL, and counting them as one would be this switch
  // crying wolf -- the exact failure its own comment says matters more than the missing-switch one.
  // A queue where every row declares what it waits on is WORKING; the switch must fire on rows that
  // COULD move and are not moving.
  return { reachable: rows.filter((r) => waitingOn(r, today) === null).length,
    waiting: waitingBreakdown(rows, today) };
}

/**
 * The reachable open rows that are IN MOTION: a claimed row (a `session:` label) whose session herdr's listing reads `working` (#4205).
 *
 * `openRowState` counts every row that declares no wait and reads no claim, so on 2026-10-08T19:05Z nine claimed rows, two of their workers started minutes before,
 * paged `ceo` as "could move and are not moving". A claimed row with a working session IS moving. The listing is the one the follow-ups' wave already read for
 * `closedClaimsWhenWorkerListed` (the claim-stall tick's own liveness read), handed in, so this makes no call.
 *
 * ONLY A READ `working` LEAVES A ROW OUT. A session that is idle, `blocked`, absent from the listing, or a listing that could not be read (`null`) leaves the row
 * counted: an unreadable liveness is not "working", and a stall under a dead claim must still page. A row that waits is not reachable and is not subtracted twice.
 * @param rows the un-coalesced `readOpenRows` result
 * @param agents herdr's listing, `null` when herdr could not be asked
 * @param [today] an ISO `YYYY-MM-DD`
 */
export function workingClaims(rows: any[] | null | undefined, agents: { label: string; status: string; }[] | null | undefined, today: string = todayIso()): any[] {
  if (!Array.isArray(rows) || !Array.isArray(agents)) return [];
  const working = new Set(agents.filter((a) => a.status === "working").map((a) => a.label));
  return rows.filter((r) => waitingOn(r, today) === null
    && labelsOf(r).some((n: string) => n.startsWith(SESSION_PREFIX) && working.has(n.slice(SESSION_PREFIX.length))));
}

/**
 * Says how many claimed rows were left out of the reachable count (#4205), so a reader can tell "nothing moves" from "everything that moves is claimed".
 */
function leftOutParagraph(leftOut: number) {
  return leftOut > 0 ? `NOT IN THAT COUNT: ${leftOut} claimed row(s) with a working session were left out, because a claim whose session is working is moving.\n` : "";
}

/**
 * The open rows that ARE waiting, grouped by what they wait on.
 *
 * GROUPED BY DATE RATHER THAN LISTED PER ROW, because the aggregate is the fact nobody could see. Every
 * one of the four rows parked to 2026-09-23 on 2026-09-22 was individually correct and recorded its
 * reasoning on its own row; what no reader had was "the pool's promotable stock went to zero at 11:45Z
 * and four sessions idled for seven hours". A per-row list says it in twelve lines and buries the date
 * the org un-stalls by itself.
 *
 * DATES SORT LEXICALLY, which is why `Not-before:` is ISO-only, so `[0]` is the earliest with no
 * comparator and no `Date` parsing.
 *
 * A THIRD GROUP, AND IT NEEDED AN EXPLICIT BRANCH RATHER THAN AN `else` (#2005). The two-kind version
 * read `kind === "date"` and treated EVERYTHING ELSE as a row-blocker, so the moment `waitingOn` gained
 * a third kind it would have pushed `{ number, on: undefined }` and reported an answer-waiting row as
 * "blocked by " with nothing after it -- a wrong fact, in the one report built to stop `ceo` hand-reading
 * twenty rows. An `else` over a closed set of two is a correct expression that becomes a false one
 * silently; the set is now matched by name and the `date` branch is no longer the discriminator.
 *
 * ANSWERS ARE GROUPED BY SESSION for the same reason dates are grouped by date: "3 rows are waiting on
 * `ceo`" is the fact a reader acts on, and three separate lines naming `ceo` is that fact spelled so it
 * has to be re-derived.
 *
 *  @param today an ISO `YYYY-MM-DD`
 */
export function waitingBreakdown(rows: any[], today: string = todayIso()): {
    dates: { date: string; numbers: number[]; }[]; blocked: { number: number; on: number[]; }[];
    answers: { session: string; numbers: number[]; }[]; total: number;
} {
  const byDate = new Map();
  const bySession = new Map();
  const blocked = [];
  for (const row of rows ?? []) {
    const waiting = waitingOn(row, today);
    if (waiting === null) continue;
    if (waiting.kind === "date") byDate.set(waiting.date, [...(byDate.get(waiting.date) ?? []), Number(row.number)]);
    else if (waiting.kind === "answer") {
      bySession.set(waiting.session, [...(bySession.get(waiting.session) ?? []), Number(row.number)]);
    } else blocked.push({ number: Number(row.number), on: waiting.numbers });
  }
  const dates = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, numbers]) => ({ date, numbers }));
  const answers = [...bySession.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([session, numbers]) => ({ session, numbers }));
  return { dates, blocked, answers,
    total: dates.reduce((n, d) => n + d.numbers.length, 0) + blocked.length
      + answers.reduce((n, a) => n + a.numbers.length, 0) };
}

/**
 * At most this many row numbers are spelled out per group; the rest are counted.
 *
 * A PROMPT IS READ BY A SESSION WITH A CONTEXT BUDGET. Five hundred open rows could all be waiting, and a
 * paragraph naming every one of them is a page nobody finishes reading -- the same failure as a switch
 * that pages until it is ignored. The counts stay exact either way; only the enumeration is capped.
 */
const WAITING_ROWS_NAMED = 12;

/** `#1 #2 #3 +4 more` -- exact count, capped enumeration. */
function nameRows(numbers: number[]) {
  const shown = numbers.slice(0, WAITING_ROWS_NAMED).map((n) => `#${n}`).join(" ");
  const rest = numbers.length - WAITING_ROWS_NAMED;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/**
 * The waiting conditions, as a paragraph, or `""` when no row carries one.
 *
 * `describeWaiting` RATHER THAN A SECOND COPY OF THE WORDING. `waiting-condition.ts` is the one reader
 * of "this row is waiting on something" and it already owns how a wait is said out loud -- re-typing
 * "not before <date>" here is exactly the second-copy-of-a-predicate shape that module's own header
 * refuses.
 *
 * EMPTY IS A REAL ANSWER AND MUST STAY ONE. A stall where nothing declares a wait is the original
 * defect -- every row stopped by a label, a lane or a claim -- and the existing wording below is what
 * says so. This returns "" for that state rather than a paragraph saying "0 rows are waiting", so the
 * unexplained stall reads exactly as it did before #1935.
 *
 *
 * @param reachable the rows that could move, which is what `openRows` counts
 */
function waitingParagraph(waiting: ReturnType<typeof waitingBreakdown> | null | undefined, reachable: number) {
  if (!waiting || waiting.total === 0) return "";
  const lines = [`SEPARATELY, AND NOT IN THAT ${reachable}: ${waiting.total} of the `
    + `${reachable + waiting.total} open row(s) carry a machine-readable waiting condition, which this `
    + "gate read on this tick. They are filtered out of the count above because they genuinely are not "
    + "startable -- but they are why the pool is empty, and nothing has ever said so.\n"];
  if (waiting.dates.length > 0) {
    lines.push(`  ${waiting.dates.reduce((n, d) => n + d.numbers.length, 0)} on a date: `
      + `${waiting.dates.map((d) => `${d.numbers.length} ${describeWaiting({ kind: "date", date: d.date })} `
        + `(${nameRows(d.numbers)})`).join("; ")}. THE EARLIEST IS ${waiting.dates[0].date}.\n`);
  }
  if (waiting.blocked.length > 0) {
    lines.push(`  ${waiting.blocked.length} on another row: ${waiting.blocked
      .slice(0, WAITING_ROWS_NAMED)
      .map((b) => `#${b.number} ${describeWaiting({ kind: "row", numbers: b.on })}`).join("; ")}`
      + `${waiting.blocked.length > WAITING_ROWS_NAMED ? ` +${waiting.blocked.length - WAITING_ROWS_NAMED} more` : ""}.\n`);
  }
  // THIS GROUP IS THE ONE A READER CAN CLEAR IN THE SAME TURN, and that is why it names the session
  // rather than counting. A date cannot be hurried and a blocking row is someone else's work; a question
  // owed is a session that can be asked now -- so of the three groups this is the one whose line turns
  // into an action, and burying it in "12 rows are waiting" is what made #2005 invisible for three days.
  if (waiting.answers.length > 0) {
    lines.push(`  ${waiting.answers.reduce((n, a) => n + a.numbers.length, 0)} on a session's answer: `
      + `${waiting.answers.map((a) => `${a.numbers.length} `
        + `${describeWaiting({ kind: "answer", session: a.session })} (${nameRows(a.numbers)})`).join("; ")}`
      + ". THAT SESSION REMOVING THE LABEL IS THE ACT OF ANSWERING, and it is the only thing that "
      + "releases these rows.\n");
  }
  // THE SELF-CLEARING PROPERTY IS WEAKER THAN IT READS, and this is the line that stops the reader
  // filing the whole paragraph under "fine, it clears tomorrow". A date-parked row can be waiting on
  // something that cannot happen WHILE it is parked: #1931 was `Not-before: 2026-09-23` with a done-when
  // of "the next merged PR carrying a `convinced` verdict", and no PR could merge because no row was
  // claimable -- so #1756, blocked by #1931, could not move either side of the date.
  lines.push("\"The org is waiting until <date>\" is a SCHEDULE and a valid answer -- say it and stop, "
    + "rather than reading twenty rows to re-derive it. But check the earliest date actually clears "
    + "something: a date-parked row whose done-when needs a merge cannot close while nothing is "
    + "claimable, so a stall can sustain itself across a date boundary.\n");
  return lines.join("");
}

/**
 * THE CAUSE THAT FIRES ON THE ABSENCE OF CAUSES -- a dead man's switch for the org.
 *
 * EVERY OTHER CAUSE FIRES ON A POSITIVE STATE: a draft exists, a row is unclaimed, a check is red. None
 * can fire on NOTHING HAPPENING, and nothing happening is the failure mode this org actually has. The
 * gate exits QUIET when no known cause matched, and that one exit covers two different worlds -- "there
 * is genuinely nothing to do" and "there is plenty to do and no cause can see it". Indistinguishable, so
 * the ABSENCE OF A SIGNAL was reported as health.
 *
 * MEASURED REPEATEDLY OVER 48 HOURS: a worker unable to capture for 4.9 days; #63's step 9 unstarted for
 * 18 hours with the publish blocked behind it; ten rows gated on a condition that had become true;
 * twenty-four rows waiting on a fleet healthy for two hours; a session stopped behind a menu. In every
 * case the gate was honestly QUIET, every session honestly idle, and the only thing that noticed was a
 * human reading a terminal. #928's own title records the shape from before this file existed: "main's
 * trunk-guard red for 27.8 hours unattended -- both sets of eyes were retired the same day."
 *
 * THE DISCRIMINATOR IS THE COUNT, so a stall of the same shape is one question and a tracker that moved
 * is a new one. As a JUDGMENT cause it holds for two hours rather than re-asking every twenty minutes:
 * the canonical write-up of this pattern is titled "A Dead-Man's Switch That Pages Once and Goes Quiet Is
 * Worse Than None", and the opposite failure is one that pages until nobody reads it.
 *
 * WHY `ceo` AND NOT `product-manager`: this is not a queue question. `product-manager` already answers
 * "is anything promotable" through `ready-queue-empty`, and has answered it correctly every time. This
 * asks "the org has open work and no way to reach any of it" -- a management question, and #912 deleted
 * the standing crons that made it somebody's job without replacing that half.
 *
 * WHAT IT NOW HANDS OVER, AND WHY THAT IS THE WHOLE ROW (#1935). Its prompt used to enumerate the things
 * that stop a row as "`blocked`, `fleet-gated`, `epic`, a lane, a claim" and never mention `Not-before:`
 * or `blockedBy` -- THE TWO FORMS THE 2026-09-19 CHAIRMAN DIRECTION MADE THE PREFERRED ONES over
 * `blocked`. So the one cause built to answer "the org has open work and no way to reach any of it"
 * could not name the most common modern reason a row is unreachable. Measured on the 2026-09-22T18:30Z
 * wake that found this: 12 of 20 open backlog rows carried one, four of them clearing the next day, and
 * `ceo` spent an hour hand-reading rows the gate had already read that same tick.
 *
 * THE DISCRIMINATOR STAYS THE REACHABLE COUNT, deliberately. A date clearing MOVES a row from waiting to
 * reachable, so the count changes, so the causeKey changes and the dedupe stops matching -- the existing
 * key already re-fires on exactly the event that matters, and folding the breakdown into it would page
 * again whenever any blocker anywhere changed shape without the org becoming any more reachable.
 *
 * @param state `leftOut` (#4205): the claimed rows whose sessions are working, which `openRows` does not count
 */
export function stalledOrder({ orders, openRows, waiting = null, leftOut = 0 }: {
        orders: unknown[]; openRows: number | null;
        waiting?: ReturnType<typeof waitingBreakdown> | null; leftOut?: number;
    }) {
  // ONLY WHEN NOTHING ELSE FIRED. One order anywhere means some cause can still reach the org.
  if (orders.length > 0) return null;
  // A REFUSED READ IS NOT AN EMPTY TRACKER (#1286), and an empty one is not a stall: an org with no open
  // rows has finished, which is the one silence that is genuinely healthy.
  if (openRows === null || openRows === 0) return null;
  return {
    session: "ceo",
    cause: "org-stalled",
    subject: "org",
    discriminator: String(openRows),
    prompt: `NOTHING IS REACHABLE. The work gate found no cause of any kind this tick and ${openRows} `
      + "row(s) are open and could move, so every session is idle and will stay idle: no draft needs a "
      + "verdict, no row is claimable, no check is red, nothing is promotable.\n"
      + "That is NOT the org being finished. It means every one of those rows carries something that "
      + `stops it -- \`${BLOCKED_LABEL}\`, \`fleet-gated\`, \`epic\`, a lane, a claim -- and no cause can see past it.\n`
      + leftOutParagraph(leftOut)
      + waitingParagraph(waiting, openRows)
      + "READ THE BACKLOG AND SAY WHY, then act. Shapes measured here in the last two days: a gate whose "
      + "condition became TRUE and nobody lifted the label; a row waiting on a capability that has since "
      + "recovered; a runbook step that exists only as prose, so no cause can name it; a session stopped "
      + "on a question, which `herdr --session org agent list` shows as `blocked` and which no wake will "
      + "ever reach.\n"
      + "You are the only session asked this. Every minute the org is stalled is capacity nobody is "
      + "using, and until now the only thing that noticed was the chairman reading a terminal.",
    causeKey: `ceo/org-stalled/${openRows}`,
  };
}

/**
 * Do the work the gate is allowed to do itself, and return only what still needs a session.
 *
 * THE RELAY TURN THIS REMOVES, MEASURED ON MERGED PULL REQUESTS. #1730 and #1748 both carried a
 * `convinced` verdict from a reviewer, and on both a session then woke, read the verdict the gate had
 * ALREADY PARSED, ran one `gh pr ready`, and wrote a comment restating it: *"Marked ready by
 * product-manager. reviewer-2's verdict at f47c2ee6 says convinced"*. Across the last 25 merged PRs the
 * median open-to-merge was SIX MINUTES, so this was never a queue problem -- it was a model turn spent
 * relaying a machine-readable fact between two machines.
 *
 * AND THE ROLE DOC ALREADY SAID SO. `.agent-org/roles/reviewer.md` line 129: "a provisional
 * `convinced` IS the verdict: **the author marks ready on it**". `product-manager` was never supposed to
 * be in this path; the gate put them there by having no way to act, only to wake.
 *
 * FAILURE FALLS BACK RATHER THAN DISAPPEARING. A refused or errored `gh` call re-delivers the original
 * order, so the worst case is exactly today's behaviour and a line on stderr saying why. An action that
 * silently swallowed its failure would turn a visible wake into an invisible nothing, which is the
 * direction this repository has paid for before.
 *
 * A DRAIN DOES NOT WITHHOLD IT, and that is not an oversight: `draft-convinced-not-ready` is not in
 * `START_CAUSES` because marking a reviewed draft ready FINISHES work in flight rather than starting
 * any. A drain wants exactly this to happen.
 */
export function performActions(orders: any[], run: (args: string[]) => string = defaultRun, log: (line: string) => void = (line) => process.stderr.write(line)): { delivered: any[]; performed: number; } {
  const delivered = [];
  let performed = 0;
  for (const order of orders) {
    const { action, ...rest } = order;
    if (!action) { delivered.push(order); continue; }
    try {
      // A pull request in another repository is ready-flipped THERE: `repo` rides on the action only when it is not the primary's.
      rows().markPullReady({ number: action.pr, repo: action.repo, run });
      performed += 1;
      log(`DID ${action.kind} pr-${action.pr} (${order.cause}) -- no session woken\n`);
    } catch (error: any) {
      log(`COULD NOT ${action.kind} pr-${action.pr}: ${error?.message ?? error} `
        + `-- delivering to ${rest.session} instead\n`);
      delivered.push(rest);
    }
  }
  return { delivered, performed };
}

/**
 * Everything the gate decided NOT to say, said on stderr where the tick log already reads.
 *
 * TWO KINDS OF SILENCE, ONE PLACE TO READ THEM. A row shelved on B4 and a cause withheld by a drain
 * are both work the gate can see and is deliberately not offering -- and both are invisible from the
 * orders alone, which is exactly how a starved queue reads as a quiet one. Neither costs a model turn.
 *
 * THE DRAIN LINE NAMES THE FILE ON PURPOSE. A marker left behind after a transfer would starve the org
 * for as long as nobody thought to look for it, so every tick says where it is and how to remove it.
 *
 * (Split out of `main`, which reached `complexity` 16 when the drain branch landed.)
 */
export function reportWithheld({ drain, blocked }: { drain: boolean; blocked: { number: number; repoKey?: string; reason: string; }[]; }) {
  if (drain) {
    process.stderr.write(`DRAINING (${DRAIN_MARKER} exists): finishing work in flight, starting none. `
      + `Withheld: ${START_CAUSES.join(", ")}. Remove that file to reopen the queue.\n`);
  }
  for (const row of blocked) {
    process.stderr.write(`SHELVED row ${subjectMention(row)}: ${row.reason}\n`);
  }
}
