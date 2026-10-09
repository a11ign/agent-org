// command: (not a command) the ONE reader of "this row is waiting on something", imported, never retyped.
//
// EVERY SESSION READS STRUCTURED STATE AND WRITES PROSE, AND THAT IS THE OPEN LOOP.
//
// The gate is a pure function of what GitHub RECORDS. A session's conclusions are sentences in comments.
// So the org can act on what it is told by GitHub and cannot act on anything it LEARNS -- measured
// 2026-09-19: 0 open rows carried a machine-readable blocker, 5 stated one in prose.
//
// Three hours of that day, each the same shape:
//
//   `orchestrator`  wrote "blocked by #1772" in a comment. #1772 closed 64 minutes later. Nothing
//                   connected the two, so it sat idle with a healthy fleet and five rows it could run.
//   `ceo`           wrote "no need to re-check before tomorrow's 07:10 fire" on #1234, a row gated on
//                   WALL-CLOCK TIME. Nothing reads that, so the cause re-fires every 2h -- about 18
//                   more identical wakes before the date it is waiting for.
//   `orchestrator`  worked out the control-plane SSH route, wrote it down, and stopped -- the note was
//                   addressed to a reader that does not exist.
//
// WHY `blocked` DOES NOT ALREADY SOLVE THIS, and this is the distinction the whole module rests on:
// `blocked` is A CLAIM WITH NO REFERENT. It says something blocks this row and never says what, so
// nothing can ever check it and only a human re-reading the row can clear it. Measured the same day: 11
// rows carried it, several waiting on conditions that had long since become true, and #1768 carries
// `blocked` while its native `blockedBy` is empty.
//
// A WAITING CONDITION MUST NAME WHAT IT WAITS ON, in a form a machine can evaluate. All three of these
// do, and all three therefore CLEAR THEMSELVES -- which is the property `blocked` lacks and the reason
// `blocked` rots.
//
// THE THIRD ONE WAS MISSING FROM THIS MODULE FOR THREE DAYS, AND THAT IS #2005. The chairman's direction
// names THREE waiting conditions -- a session (`answer:<session>`), a row (`--blocked-by`) and a date
// (`Not-before:`). This file implemented two, so the one whose referent is a SESSION -- the one reached
// for when a DECISION rather than a dependency is outstanding -- was the one that did not hold a row.
//
// MEASURED LIVE AT 2026-09-22T20:49:41Z. `product-manager` put `answer:ceo` on #2002 (`pnpm run
// host:install`) at 20:47Z because the ruling it depends on was still open. The next tick promoted #2002
// to `ready` while it carried that label, then emitted `WOKE worker-capture <- engineers/
// ready-row-unclaimed/2002`. `worker-capture` was one turn from claiming a row whose whole point was
// that it must not run yet -- running it would have made an unruled decision real on the host.
//
// IT WAS NOT THAT NOTHING READ THE LABEL. `work-gate.ts` reads it on every tick and wakes the session
// that owes the answer (`answerOrders`). The gate KNEW the row was waiting; the waiting-condition reader
// was simply never told, so every OTHER question -- is this promotable, is this offerable, is this
// reachable -- was answered as if the row were free.

// #2619 (child 3d of #69): the `answer:` prefix, moved to the project's declared vocabulary.
import { ANSWER_PREFIX, SESSION_PREFIX } from "./project-vocabulary.ts";
import { nextNotBefore, readingsDeclared, roundTripsUtc } from "./reading-schedule.ts";

/**
 * The label prefix that says which session owes an answer on a row.
 *
 * IT LIVES HERE NOW RATHER THAN IN `work-gate.ts` (#2005), and the move is the fix rather than tidying.
 * A waiting condition spelled in the file that CONSUMES it can only ever be read by that consumer's own
 * code paths; this module's first line says it is the one reader of "this row is waiting on something",
 * imported and never retyped, and that promise is only true of conditions declared in it. `work-gate.ts`
 * re-exports this name, so every existing importer is untouched.
 *
 * @see `answerOwedBy` for why the label, and not an assignee, is the mechanism.
 *
 * IMPORTED, NOT REDECLARED (#2619, child 3d of #69): `project-vocabulary.ts`'s field, re-exported under
 * this file's own established name so every existing importer -- `work-gate.ts` included -- keeps
 * working unchanged.
 */
export { ANSWER_PREFIX };

/**
 * The session that owes an answer on this row, or `null`.
 *
 * A LABEL AND NOT AN ASSIGNEE, and the data decided that rather than taste: `repos/:o/:r/assignees`
 * answers with FOUR accounts which the EIGHT sessions share, so an assignee structurally cannot say
 * WHICH session owes the answer -- the only thing this needs to express.
 *
 * ONE PER SESSION, NOT ONE PER INSTANCE, so it joins `session:*` and `hold:*` rather than rotting the
 * vocabulary the way `branch:agent/...` and `worktree:/private/tmp/...` already have.
 *
 * AN EMPTY SESSION NAME IS NOT A SESSION. A bare `answer:` names nobody, so it is no more a referent than
 * `blocked` is -- and a wait on nobody is exactly the referent-less claim this module exists to refuse.
 * It reads as NOT waiting, which leaves the row visible for someone to find: the same fail-open choice
 * `notBeforeDate` makes for a malformed date.
 *
 * FIRST MATCH WINS on a row carrying two. That cannot happen by the label's own rule (one per session),
 * and if it ever does, naming one owner beats naming none -- the row is held either way, and the
 * `answer-owed` cause wakes BOTH of them independently.
 *
 * @param {{labels?: ({name?: string} | string)[]}} row
 * @returns {string | null}
 */
export function answerOwedBy(row: { labels?: ({ name?: string; } | string)[]; }): string | null {
  return answersOwedBy(row)[0] ?? null;
}

/**
 * EVERY session that owes an answer on this row, in label order -- `answerOwedBy` is this list's first
 * entry, so there is ONE decision about what counts as a session name (#2202). The close path needs the
 * whole list rather than the first: a row that closes while two sessions owe it an answer has two
 * questions outstanding, and naming one of them would be the silent-void defect at half the size.
 *
 * WHY THE CLOSE PATH ASKS AT ALL. This wait is the one that is EXTINGUISHED rather than cleared by an
 * unrelated event: `readOpenRows` is `--state open`, so the instant a merge closes the row it leaves the
 * population `answer-owed` reads, and the wake stops with nothing saying it stopped. Measured
 * 2026-09-22 on #1936, #1970 and #2034 -- each labelled 5m23s to 14m45s before a merged PR closed it,
 * none of the three questions ever answered (`docs/operational-lessons.md`, "a merged PR's close voids
 * `answer:<session>`"). A waiting condition must clear ITSELF, and being answered is the only event that
 * may do it.
 *
 * @param {{labels?: ({name?: string} | string)[]}} row
 * @returns {string[]}
 */
export function answersOwedBy(row: { labels?: ({ name?: string; } | string)[]; }): string[] {
  const sessions = [];
  for (const label of row?.labels ?? []) {
    const name = String((label as any)?.name ?? label);
    if (!name.startsWith(ANSWER_PREFIX)) continue;
    const session = name.slice(ANSWER_PREFIX.length).trim();
    if (session) sessions.push(session);
  }
  return sessions;
}

/**
 * How long an `answer:<session>` label may stand with nothing posted before it is called unexplained.
 * Five minutes, where the one measured case needed under two: label 06:32:28Z, question 06:34:30Z on #3566 (2m02s),
 * read from its timeline. The window is cheap to be generous with -- a genuinely bare label is still called, a few minutes later.
 */
export const ANSWER_LABEL_GRACE_MS = 5 * 60 * 1000;

/**
 * Whether an `answer:<session>` label was applied to this row with NOTHING that looks like an attempt to
 * satisfy it -- no comment posted at or after the label's own timeline event. `null` when the label was
 * never applied at all (#2711): the row's own evidence is `answer:ceo` labelled and removed from PR #2649
 * TWICE with no comment either time, so the addressee had no way to tell a real question from a label
 * added by habit or by mistake except by going and looking -- the exact cost this module exists to save
 * every OTHER waiting condition from.
 *
 * THE TIMELINE, NOT `issues/{n}/events`: the events endpoint carries label churn only and never a
 * `commented` entry, so it cannot answer "was anything posted after" -- #2711's own Open-check read the
 * timeline for exactly that reason, and this reads the same shape.
 *
 * THE LAST `labeled` EVENT FOR THIS NAME, because a label removed and reapplied is a NEW wait: a comment
 * that predates the current application answered a question that is no longer the one outstanding.
 *
 * PRESENCE, NOT CONTENT: this asks whether ANYTHING was posted, never what it says. Judging whether a
 * comment "plausibly names a question" is exactly the reasoning #2711 exists to save a human from doing
 * by hand on every bare label, so it is left to the reader the resulting wake reaches, not guessed at here.
 *
 * A LABEL YOUNGER THAN {@link ANSWER_LABEL_GRACE_MS} IS NOT YET BARE: a session that labels first and
 * comments second is in the bare state for the seconds it takes to type the question, and ordering it to
 * "post the question" then is noise. Measured on #3566 (2026-10-05): label 06:32:28Z, the order to the
 * labeller 06:34:23Z, the question itself 06:34:30Z -- seven seconds after the order.
 *
 * @param {{event?: string, label?: {name?: string}, created_at?: string}[] | null | undefined} timeline
 * @param {string} session
 * @param {number} [nowMs] the caller's clock; injected so a test moves time without a global stub
 * @returns {{labelledAt: string} | null}
 */
export function bareAnswerLabel(timeline: { event?: string; label?: { name?: string; }; created_at?: string; }[] | null | undefined, session: string, nowMs: number = Date.now()): { labelledAt: string; } | null {
  const name = `${ANSWER_PREFIX}${session}`;
  const events = timeline ?? [];
  const labelEvents = events.filter((e) => e?.event === "labeled" && e?.label?.name === name);
  if (labelEvents.length === 0) return null;
  const labelledAt = String(labelEvents[labelEvents.length - 1]?.created_at ?? "");
  if (!labelledAt) return null;
  const answered = events.some((e) => e?.event === "commented" && String(e?.created_at ?? "") >= labelledAt);
  if (answered) return null;
  // An unparseable time reads as NaN, which compares false, so the label stays bare: the old verdict.
  return nowMs - Date.parse(labelledAt) < ANSWER_LABEL_GRACE_MS ? null : { labelledAt };
}

/**
 * How long after an `answer:<session>` label comes OFF the gate still tells the claimant (#3632).
 *
 * STRICTLY UNDER `JUDGMENT_TTL_MS` (two hours), AND THAT IS WHAT MAKES THE ORDER ONE ORDER: the ledger
 * re-sends a key once its TTL has passed, so a reading that kept emitting the same removal for longer than
 * the TTL would order the claimant about one answer twice. `answer-given` is a judgment cause for that
 * reason, and `work-gate.test.ts` pins this window under that TTL so neither can move alone. 90 minutes is
 * also what `claim-stalled`'s 120-minute nudge makes the upper end of useful: past it the claimant has
 * been nudged anyway.
 */
export const ANSWER_GIVEN_WINDOW_MS = 90 * 60 * 1000;

/**
 * The `answer:<other>` labels taken OFF a claimed row inside {@link ANSWER_GIVEN_WINDOW_MS}, each with the
 * comment that carries the answer -- what the claimant is told when somebody else answers its question
 * (#3632). Removing the label IS the act of answering, and it wakes nobody on its own: an answered claimant
 * that had gone idle waited for `claim-stalled`'s next nudge, up to 120 minutes.
 *
 * THE ANSWER IS THE NEWEST COMMENT BY THE REMOVING ACCOUNT AT OR BEFORE THE REMOVAL. Accounts are shared
 * between sessions, so this can say which account wrote and never which session; the removal's own `actor`
 * is the only anchor the timeline gives, and `commentId` is `null` when that account posted nothing first
 * (a label removed without a word is still an answer the claimant should be told about).
 *
 * NOT A REMOVAL THAT IS NO LONGER ONE: a label put back after it came off is a question standing again, and
 * a removal from before the claimant took the row answered somebody else's question. A label named for the
 * claimant itself is skipped too: the claimant is not waiting on themselves. Returned oldest first, one
 * entry per removal, so a label re-applied and removed again is a second answer and one answer is one.
 *
 * @param {{event?: string, label?: {name?: string}, actor?: string, id?: number, created_at?: string}[] | null | undefined} timeline
 * @param {string} claimant the `session:` label's holder
 * @param {number} [nowMs] the caller's clock
 * @returns {{answered: string, removedAt: string, removedBy: string | null, commentId: number | null}[]}
 */
export function answersGiven(timeline: { event?: string; label?: { name?: string; }; actor?: string; id?: number; created_at?: string; }[] | null | undefined, claimant: string, nowMs: number = Date.now()): { answered: string; removedAt: string; removedBy: string | null; commentId: number | null; }[] {
  const events = (timeline ?? []).filter((e) => e?.created_at);
  const claimedAt = events.filter((e) => e.event === "labeled" && e.label?.name === `${SESSION_PREFIX}${claimant}`)
    .map((e) => String(e.created_at)).pop() ?? "";
  const given = [];
  for (const removal of events) {
    const name = String(removal.label?.name ?? "");
    if (removal.event !== "unlabeled" || !name.startsWith(ANSWER_PREFIX)) continue;
    const removedAt = String(removal.created_at);
    const answered = name.slice(ANSWER_PREFIX.length).trim();
    const reapplied = events.some((e) => e.event === "labeled" && e.label?.name === name && String(e.created_at) > removedAt);
    // A window the clock cannot be read against is NaN, which compares false: refused, never ordered.
    const inWindow = nowMs - Date.parse(removedAt) <= ANSWER_GIVEN_WINDOW_MS;
    if (!answered || answered === claimant || reapplied || !inWindow || removedAt < claimedAt) continue;
    const comment = events.filter((e) => e.event === "commented" && e.actor === removal.actor && String(e.created_at) <= removedAt).pop();
    given.push({ answered, removedAt, removedBy: removal.actor ?? null, commentId: comment?.id ?? null });
  }
  return given;
}

/** The length of `YYYY-MM-DD` -- what tells a date-only `Not-before:` value from a timestamped one. */
const DATE_ONLY_LENGTH = 10;

/**
 * The instant a `Not-before:` value names, as an ISO timestamp.
 *
 * A DATE-ONLY VALUE IS MIDNIGHT UTC OF THAT DATE, and that reading is what makes #2113 a WIDENING rather
 * than a behaviour change: `waitingOn` used to shelve a row while `date > today` compared two ten-character
 * strings, and midnight-to-midnight gives the identical answer on every calendar-valid date-only value.
 * `waiting-condition.test.ts` pins that equivalence against the lexical rule it replaces rather than
 * against a handful of remembered cases.
 *
 * @param {string} declared a value `notBeforeDate` returned
 */
export const notBeforeIso = (declared: string) =>
  declared.length === DATE_ONLY_LENGTH ? `${declared}T00:00:00Z` : declared;

/**
 * The `Not-before:` value, or `null` -- a `YYYY-MM-DD` date, or a `YYYY-MM-DDTHH:MM:SSZ` instant.
 *
 * A BODY FIELD RATHER THAN A LABEL, deliberately. GitHub has no native "wait until a date", so this one
 * needs a convention -- and a `not-before:<date>` LABEL would mint a new label per date into a
 * vocabulary that already shows exactly that rot: `branch:agent/task-inertness-caveat-792`,
 * `worktree:/private/tmp/wt-rla851` and a dozen more are per-instance labels nobody ever collected.
 *
 * A DECLARED BODY FIELD IS THIS REPOSITORY'S OWN PROVEN PATTERN, not an invention: `Acceptance:` and
 * `Closes:` are parsed out of PR bodies by `acceptance-commands.ts` and BLOCK THE MERGE. This is that
 * pattern applied to the other object type.
 *
 * THE OPTIONAL TIME IS #2113, AND IT IS WHY THE COMPARISON MOVED (see `waitingOn`). A date-only field
 * cannot express a wait shorter than a day, so a row whose last done-when turns true at a named HOUR
 * reads as startable from midnight: #2002 declared `Not-before: 2026-09-23` for a run the host timer
 * fires at 06:10Z, and from 00:20Z the org reported it as waiting on NOTHING for the ~5h50m in between.
 *
 * SECONDS REQUIRED WHEN A TIME IS GIVEN, matching `Fleet-hold-until:` -- and the widening is the reason
 * the whole comparison had to move to parsed time rather than gaining a regex. A `Not-before:` date is
 * always ten characters, so a lexical comparison was a chronological one for free; a timestamp is not,
 * and `waitingOn` compared `date > today` against a ten-character `today`. **A string is greater than its
 * own prefix**, so under a regex-only widening `Not-before: 2026-09-23T06:10:00Z` would have shelved the
 * row for ALL of 2026-09-23 and cleared at 2026-09-24T00:00Z: a 6-hour wait turned into an 18-hour-late
 * one, silently. Today's defect reads the row startable ~6h early; that one reads it shelved ~18h late.
 *
 * A MALFORMED VALUE IS NOT A WAIT -- it fails OPEN, so a typo leaves the row visible and someone finds
 * it, rather than hiding it silently until a human happens to read the body. A time without seconds, a
 * time without its `Z`, and an offset other than UTC are all malformed by that rule and all fail open.
 *
 * AN OPTIONAL `#{0,6}` HEADING PREFIX, because `Region`, `Done-when` and `Acceptance` are all written as
 * `## <Field>` in this repo's own row convention and `Not-before:` was written the same way on #1663 --
 * a bare-line-only regex silently read that row as having nothing stopping it (#1822).
 *
 * THE NAME STAYS `notBeforeDate` THOUGH THE VALUE MAY CARRY AN HOUR: it is the parser of the
 * `Not-before:` field, which is the thing every caller and every row body names.
 *
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function notBeforeDate(body: string | null | undefined): string | null {
  const m = /^[ \t]*#{0,6}[ \t]*Not-before:[ \t]*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)[ \t]*$/im
    .exec(String(body ?? ""));
  if (!m) return null;
  return roundTripsUtc(notBeforeIso(m[1])) ? m[1] : null;
}

/**
 * The date a row is held until: its reading schedule's next reading when the row declares one AND the caller supplied its comments, else
 * its `Not-before:` line (#4638).
 *
 * `Reading: <n> at T` lines supersede `Not-before:` because the schedule is the whole truth and the older line is what the last taker
 * left behind. WITHOUT THE COMMENTS THE SCHEDULE CANNOT BE READ -- the receipts are comments -- so a caller that never fetched them gets
 * today's `Not-before:` answer, unchanged, rather than a wait on a reading that was posted yesterday. A row with no `Reading:` line takes
 * the old path whatever the caller holds.
 */
function declaredNotBefore(row: { body?: string; comments?: { body?: string }[] } | undefined): string | null {
  const body = row?.body;
  if (!Array.isArray(row?.comments) || readingsDeclared(body).length === 0) return notBeforeDate(body);
  return nextNotBefore({ body, comments: row.comments });
}

/**
 * Whether a declared `Not-before:` value is still in the future -- PARSED TIME, never a string compare.
 *
 * TWO INSTANTS RATHER THAN ONE, and the field's own granularity chooses between them. A date-only value
 * declares a CALENDAR DAY, so it is measured against the caller's `today` at midnight UTC -- which is
 * exactly the old lexical rule, and is what keeps every existing row's answer identical. A timestamped
 * value declares an INSTANT, so it is measured against the caller's clock; nothing else can tell 00:20Z
 * from 07:14Z on the same date, which is the whole of #2113.
 *
 * @param {string} declared @param {string} today an ISO `YYYY-MM-DD` @param {number} nowMs
 */
function notBeforeIsFuture(declared: string, today: string, nowMs: number) {
  const measuredAgainst = declared.length === DATE_ONLY_LENGTH
    ? Date.parse(`${today}T00:00:00Z`)
    : nowMs;
  return Date.parse(notBeforeIso(declared)) > measuredAgainst;
}

/**
 * What this row is waiting on, or `null` when nothing is stopping it.
 *
 * PURE, and the three kinds are deliberately different mechanisms:
 *
 *   a row     -> GITHUB'S OWN `blockedBy`. Not a convention this org invented: `gh issue create` already
 *                takes `--blocked-by`, `gh issue list --json blockedBy` already returns it, the GitHub UI
 *                already renders it, and the gate already makes that call. Zero new vocabulary, and the
 *                edge is enforced by GitHub rather than by a parser of ours.
 *   a date    -> the `Not-before:` field above, because GitHub has no equivalent. SINCE #2113 that field
 *                may also name an HOUR, and this is why the comparison is PARSED TIME rather than the
 *                string compare it was: `date > today` against a ten-character `today` reads a timestamp
 *                as greater than its own date-prefix, which would shelve a 6-hour wait for a whole day.
 *   a session -> the `answer:<session>` LABEL, because the referent is neither a row nor a date and
 *                GitHub's assignee field cannot name one of eight sessions sharing four accounts.
 *
 * ONLY AN OPEN BLOCKER COUNTS. `blockedBy.nodes` keeps closed rows in the list, and a closed blocker is
 * a condition that HAS CLEARED -- reading it as still blocking is the rot this module exists to remove.
 *
 * THE ORDER OF THE THREE IS NOT ARBITRARY: the existing two are asked FIRST, so every row that already
 * had a wait reports the same condition it reported before #2005. The new kind can only ever change the
 * answer for a row that was previously reported as waiting on NOTHING -- which is the whole defect and
 * nothing else.
 *
 * @param {{blockedBy?: {nodes?: {number?: number, state?: string}[]}, body?: string, comments?: {body?: string}[],
 *   labels?: ({name?: string} | string)[]}} row
 * @param {string} [today] an ISO `YYYY-MM-DD`
 * @param {number} [nowMs] the caller's clock, injected the way `fleetWaitingOn` already injects one --
 *   a test moves time without a global stub. ONLY A TIMESTAMPED `Not-before:` READS IT; a date-only
 *   value is measured against `today`, so every caller that never had a clock is unchanged.
 * @returns {{kind: "row", numbers: number[]} | {kind: "date", date: string}
 *   | {kind: "answer", session: string} | null}
 */
export function waitingOn(row: {
        blockedBy?: { nodes?: { number?: number; state?: string; }[]; }; body?: string; comments?: { body?: string; }[];
        labels?: ({ name?: string; } | string)[];
    }, today: string = todayIso(), nowMs: number = Date.now()): { kind: "row"; numbers: number[]; } | { kind: "date"; date: string; } |
{ kind: "answer"; session: string; } | null {
  const open = (row?.blockedBy?.nodes ?? []).filter((n) => String(n?.state ?? "OPEN").toUpperCase() === "OPEN");
  if (open.length > 0) return { kind: "row", numbers: open.map((n) => Number(n.number)) };
  const date = declaredNotBefore(row);
  if (date !== null && notBeforeIsFuture(date, today, nowMs)) return { kind: "date", date };
  const session = answerOwedBy(row ?? {});
  if (session !== null) return { kind: "answer", session };
  return null;
}

/**
 * The `Fleet-hold-until:` line, or `null` -- THE FOURTH WAITING CONDITION, AND IT LIVED SOMEWHERE ELSE.
 *
 * IT WAS DECLARED IN `packages/control/src/fleet-playbook.mjs` (#1839), whose own comment calls it "the
 * fourth" of this file's shapes while implementing it a package away. #2005 had already paid for exactly
 * that: `ANSWER_PREFIX` was spelled in `work-gate.ts`, so every OTHER reader of "is this row waiting on
 * something" answered `no` for three days about rows the gate itself was holding. A waiting condition
 * declared in the file that CONSUMES it can only ever be read by that consumer's own code paths, and this
 * module's first line promises it is the ONE reader, imported and never retyped. That promise is only
 * true of conditions declared here. `fleet-playbook.mjs` now imports and re-exports this name, so every
 * existing caller and test is untouched.
 *
 * IT SAYS TWO THINGS, AND ONLY ONE OF THEM WAS EVER WRITTEN DOWN (#2113, `orchestrator`'s reading).
 * Documented, it REFUSES `fleet:deploy`/`fleet:provision` -- a gate on two commands. Used, on five live
 * rows as of 2026-09-23 (#2114, #2160, #37, #1918, #2152), it means "MY CAPTURE SEQUENCE OWNS THE WORKERS
 * UNTIL T", which is a claim on the hardware that no command reads: `evidence:check` skips a busy worker
 * rather than queueing behind it, and nothing consults this field before dispatching into an occupied
 * fleet. Both meanings are real and a reader needs both; a session that knows only the first will read a
 * held row as dispatchable. **AND NO FIFTH FIELD IS MINTED FOR THE SECOND ONE** -- this one already
 * carries a full timestamp because a capture round's window is minutes to hours wide, so a
 * `Worker-hold-until:` beside it would state one fact twice.
 *
 * SECONDS REQUIRED, not optional -- and `Not-before:` now carries the same rule for the same reason
 * (#2113). A timestamp does not compare lexically: `T10:30Z` sorts AFTER `T10:30:15Z` (`Z` > `:`), which
 * would read a later-declared, earlier-expiring hold as still live. Callers compare PARSED time, which
 * removes the trap either way; requiring seconds means a malformed field is refused as a whole rather
 * than half-parsed.
 *
 * A MALFORMED TIMESTAMP IS NOT A HOLD -- it fails OPEN, matching `notBeforeDate`'s rule for a malformed
 * date: a typo must leave the row visible to a human, never hide a live sequence silently.
 *
 * DIGIT-SHAPED IS NOT CALENDAR-VALID -- `roundTripsUtc`, which both fields now share, records why
 * (reviewer, #1841). The direction of that error is what makes it a refusal here: a typo would silently
 * EXTEND a live sequence's window rather than failing open the way this function's own rule requires.
 *
 * NARROWED TO NAMED WORKERS SINCE `ceo`'s #928 RULING (point 2), AND STILL PARSED HERE ONLY. The line may
 * carry an optional trailing, comma-separated worker list -- `Fleet-hold-until: <timestamp>
 * a11y-worker-2,a11y-worker-3` -- read by `fleetHoldWorkers` below, this function's own sibling. A line
 * with no worker list is UNCHANGED: `fleetHoldUntil` still returns just the timestamp, and the row still
 * holds the WHOLE FLEET, which is #928's own required back-compat for every row already carrying an
 * unscoped field. The worker list is matched by THIS regex too (not left to a second, looser one), because
 * a hold whose trailing text does not fit either shape must fail exactly as open as a bad timestamp does --
 * see `fleetHoldWorkers`'s own comment for why a typo'd worker name is not read as "unscoped".
 *
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function fleetHoldUntil(body: string | null | undefined): string | null {
  const m = FLEET_HOLD_LINE.exec(String(body ?? ""));
  if (!m) return null;
  return roundTripsUtc(m[1]) ? m[1] : null;
}

/**
 * The workers a `Fleet-hold-until:` line names, or `[]` when it names none -- `[]` MEANS "the whole
 * fleet", the same default #928 requires of `fleetHoldUntil` itself, so a caller can treat an empty array
 * and an absent list identically without a second branch.
 *
 * A TYPO'D WORKER NAME FAILS THE WHOLE LINE, NOT JUST THE SCOPE, because `FLEET_HOLD_LINE` matches the
 * worker list or nothing at all -- there is no shape where the timestamp parses but a garbled worker list
 * is silently dropped. That matches `fleetHoldUntil`'s own rule for a bad timestamp (a malformed field is
 * not a hold; it fails OPEN) rather than inventing a second, looser failure mode for the half of the line
 * this function reads: a hold that silently reverted to fleet-wide because of a typo would strand the rest
 * of the fleet exactly the way #1839 was filed to stop.
 *
 * NO IMPORT OF THE WORKER-NAME PATTERN `fleet-playbook.mjs` OWNS (`LIMIT_PATTERN`'s atom): this package
 * has no `node_modules` (ADR 0012) and this module is meant to stay a leaf other packages can pull in
 * without dragging `control` along, so the same `a11y-worker-[0-9]{1,3}` shape is inlined here rather than
 * shared. `fleet-playbook.test.ts` pins both against real worker names so the two cannot drift silently.
 *
 * @param {string | null | undefined} body
 * @returns {string[]}
 */
export function fleetHoldWorkers(body: string | null | undefined): string[] {
  const m = FLEET_HOLD_LINE.exec(String(body ?? ""));
  if (!m || !roundTripsUtc(m[1])) return [];
  return m[2] ? m[2].split(",") : [];
}

/**
 * `Fleet-hold-until:`'s own line, shared by `fleetHoldUntil` and `fleetHoldWorkers` so the two can never
 * read a different timestamp, or agree on a match the other refuses, from the same body.
 */
const FLEET_HOLD_LINE = /^[ \t]*#{0,6}[ \t]*Fleet-hold-until:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?:[ \t]+(a11y-worker-[0-9]{1,3}(?:,a11y-worker-[0-9]{1,3})*))?[ \t]*$/im;

/**
 * What a FLEET-GATED row is waiting on -- `waitingOn` plus the one condition only the fleet has.
 *
 * A SEPARATE FUNCTION RATHER THAN A FOURTH BRANCH INSIDE `waitingOn`, and the scope is the argument.
 * `waitingOn` decides whether a row is promotable, offerable and reachable for the WHOLE org; a
 * `Fleet-hold-until:` says a capture sequence owns the fleet until a named second, which stops a fleet
 * batch and stops nothing else. Folding it in would have shelved held rows out of the engineer pool too
 * -- a behaviour change nobody asked for, on a population nobody measured.
 *
 * THE GENERAL CONDITIONS ARE ASKED FIRST, matching `waitingOn`'s own rule: a row that already reported a
 * wait reports the same one, so this can only ever change the answer for a row previously reported as
 * waiting on NOTHING.
 *
 * @param {{blockedBy?: {nodes?: {number?: number, state?: string}[]}, body?: string,
 *   labels?: ({name?: string} | string)[]}} row
 * @param {string} [today] an ISO `YYYY-MM-DD`
 * @param {number} [nowMs] injected for the same reason `todayIso` takes `now` -- a test moves the clock
 * @returns {{kind: "row", numbers: number[]} | {kind: "date", date: string}
 *   | {kind: "answer", session: string} | {kind: "fleet-hold", until: string} | null}
 */
export function fleetWaitingOn(row: {
        blockedBy?: { nodes?: { number?: number; state?: string; }[]; }; body?: string;
        labels?: ({ name?: string; } | string)[];
    }, today: string = todayIso(), nowMs: number = Date.now()): { kind: "row"; numbers: number[]; } | { kind: "date"; date: string; } |
{ kind: "answer"; session: string; } | { kind: "fleet-hold"; until: string; } | null {
  // THE CLOCK GOES DOWN WITH THE DATE (#2113). `waitingOn` now reads a sub-day `Not-before:` against a
  // clock; passing only `today` would leave a fleet-gated row's two waiting conditions measured against
  // two different clocks, so a test that moved time would move one of them.
  const general = waitingOn(row, today, nowMs);
  if (general) return general;
  const until = fleetHoldUntil(row?.body);
  if (until !== null && Date.parse(until) > nowMs) return { kind: "fleet-hold", until };
  return null;
}

/**
 * Today as `YYYY-MM-DD`, UTC -- the same alphabet `Not-before:` is written in.
 *
 * VIA `Date.now()` RATHER THAN A BARE `new Date()`, so a test can move the clock without threading a
 * `today` parameter through every caller. `new Date()` with no argument reads the host clock directly
 * and ignores a stubbed `Date.now`, which is exactly how the first version of this passed a date test
 * that was not actually testing a date.
 */
export const todayIso = (now = new Date(Date.now())) => now.toISOString().slice(0, 10);

/**
 * One line saying what a row is waiting on, for a report a person reads.
 *
 * THE SESSION IS NAMED, not counted. #2005's own done-when asks for the shelving reason to name who owes
 * the answer "the same way `blocked by #1918` is reported today" -- and it has to, because unlike a date
 * this condition is cleared by a PERSON, so the report is only actionable if it says which one.
 *
 * @param {{kind: string, numbers?: number[], date?: string, session?: string, until?: string}} waiting
 */
export function describeWaiting(waiting: { kind: string; numbers?: number[]; date?: string; session?: string; until?: string; }) {
  if (waiting.kind === "row") return `blocked by ${(waiting.numbers ?? []).map((n) => `#${n}`).join(", ")}`;
  if (waiting.kind === "answer") return `waiting on ${waiting.session} to answer`;
  // NAMED, NOT COUNTED, for the same reason the session is: a fleet hold is cleared by the SEQUENCE that
  // declared it reaching its end, so a reader deciding whether to wait needs the timestamp itself.
  if (waiting.kind === "fleet-hold") return `holding the fleet until ${waiting.until}`;
  return `not before ${waiting.date}`;
}

/**
 * THE GUARD ON THE RULE ITSELF -- rows that state a wait in PROSE and nowhere a machine can read it.
 *
 * WITHOUT THIS, THE FIX IS THE DEFECT. `agent-practices.md` now says a waiting condition goes in a field
 * rather than a sentence -- and that instruction is itself a sentence, in a document nothing checks. This
 * repository has proved twice over that it cannot keep such a rule by habit: `/clear` was one until
 * `wake.ts` mechanised it, and the author-prompt path bypassed even that. A rule with no witness decays
 * to exactly the state it was written to fix.
 *
 * A SMELL, NOT A VERDICT, and reported as one. A row may legitimately DISCUSS blocking -- this very
 * paragraph would match. So it names rows for a human to look at and never refuses anything; the
 * remedy is one `gh issue edit --add-blocked-by` or one `Not-before:` line, and "this row is only
 * talking about blockers" is a valid answer that costs a reader ten seconds.
 *
 * NIGHTLY RATHER THAN PER-TICK, deliberately: it is a hygiene question about the whole tracker, not a
 * question about whether there is work right now, and the gate's per-tick reads must stay small.
 *
 * @param {{number?: number, body?: string, blockedBy?: {totalCount?: number}}[]} issues
 * @returns {{number: number, quote: string}[]}
 */
export function proseBlockers(issues: { number?: number; body?: string; blockedBy?: { totalCount?: number; }; }[]): { number: number; quote: string; }[] {
  const found = [];
  for (const issue of issues ?? []) {
    if ((issue?.blockedBy?.totalCount ?? 0) > 0) continue;
    if (notBeforeDate(issue?.body) !== null) continue;
    // A ROW THAT CARRIES `answer:<session>` HAS ALREADY DONE WHAT THIS CAUSE ASKS FOR, and nagging a
    // session that complied is how a smell becomes noise -- the same finding #1780 recorded when
    // `unfiledEpics` re-asked `product-manager` about an epic whose blocker it had just recorded.
    if (answerOwedBy((issue as any)) !== null) continue;
    const m = /(?:blocked (?:by|on)|waiting (?:on|for))[^.\n]{0,80}/i.exec(String(issue?.body ?? ""));
    if (m) found.push({ number: Number(issue.number), quote: m[0].trim() });
  }
  return found;
}
