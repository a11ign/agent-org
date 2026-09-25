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
// MEASURED LIVE AT 2026-09-22T20:49:41Z. `product-manager` put `answer:ceo` on #2002 (`npm run
// host:install`) at 20:47Z because the ruling it depends on was still open. The next tick promoted #2002
// to `ready` while it carried that label, then emitted `WOKE worker-capture <- engineers/
// ready-row-unclaimed/2002`. `worker-capture` was one turn from claiming a row whose whole point was
// that it must not run yet -- running it would have made an unruled decision real on the host.
//
// IT WAS NOT THAT NOTHING READ THE LABEL. `work-gate.mjs` reads it on every tick and wakes the session
// that owes the answer (`answerOrders`). The gate KNEW the row was waiting; the waiting-condition reader
// was simply never told, so every OTHER question -- is this promotable, is this offerable, is this
// reachable -- was answered as if the row were free.

/**
 * The label prefix that says which session owes an answer on a row.
 *
 * IT LIVES HERE NOW RATHER THAN IN `work-gate.mjs` (#2005), and the move is the fix rather than tidying.
 * A waiting condition spelled in the file that CONSUMES it can only ever be read by that consumer's own
 * code paths; this module's first line says it is the one reader of "this row is waiting on something",
 * imported and never retyped, and that promise is only true of conditions declared in it. `work-gate.mjs`
 * re-exports this name, so every existing importer is untouched.
 *
 * @see `answerOwedBy` for why the label, and not an assignee, is the mechanism.
 */
export const ANSWER_PREFIX = "answer:";

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
export function answerOwedBy(row) {
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
export function answersOwedBy(row) {
  const sessions = [];
  for (const label of row?.labels ?? []) {
    const name = String(/** @type {any} */ (label)?.name ?? label);
    if (!name.startsWith(ANSWER_PREFIX)) continue;
    const session = name.slice(ANSWER_PREFIX.length).trim();
    if (session) sessions.push(session);
  }
  return sessions;
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
const notBeforeIso = (declared) =>
  declared.length === DATE_ONLY_LENGTH ? `${declared}T00:00:00Z` : declared;

/**
 * Whether a digit-shaped UTC timestamp is a date the calendar actually has.
 *
 * `Date.parse` SILENTLY ROLLS OVER a date that does not exist rather than refusing it --
 * `2026-02-31T04:00:00Z` parses to 2026-03-03, three days later than typed (#1841's reviewer finding on
 * `Fleet-hold-until:`). So the matched text is round-tripped through `Date` and compared back against
 * itself; a date `Date` had to repair is refused rather than silently accepted with a different meaning
 * than its author typed.
 *
 * SHARED BY BOTH FIELDS RATHER THAN COPIED ONTO THE SECOND ONE (#2113). `Not-before:` did not need this
 * while it compared strings -- a lexical comparison cannot roll a date over, because it never parses one.
 * The moment that comparison became a parsed one the trap arrived with it, so the rule is borrowed from
 * `fleetHoldUntil` here rather than re-derived beside it.
 *
 * @param {string} iso
 */
function roundTripsUtc(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 19) === iso.slice(0, 19);
}

/**
 * The `Not-before:` value, or `null` -- a `YYYY-MM-DD` date, or a `YYYY-MM-DDTHH:MM:SSZ` instant.
 *
 * A BODY FIELD RATHER THAN A LABEL, deliberately. GitHub has no native "wait until a date", so this one
 * needs a convention -- and a `not-before:<date>` LABEL would mint a new label per date into a
 * vocabulary that already shows exactly that rot: `branch:agent/task-inertness-caveat-792`,
 * `worktree:/private/tmp/wt-rla851` and a dozen more are per-instance labels nobody ever collected.
 *
 * A DECLARED BODY FIELD IS THIS REPOSITORY'S OWN PROVEN PATTERN, not an invention: `Acceptance:` and
 * `Closes:` are parsed out of PR bodies by `acceptance-commands.mjs` and BLOCK THE MERGE. This is that
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
export function notBeforeDate(body) {
  const m = /^[ \t]*#{0,6}[ \t]*Not-before:[ \t]*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)[ \t]*$/im
    .exec(String(body ?? ""));
  if (!m) return null;
  return roundTripsUtc(notBeforeIso(m[1])) ? m[1] : null;
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
function notBeforeIsFuture(declared, today, nowMs) {
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
 * @param {{blockedBy?: {nodes?: {number?: number, state?: string}[]}, body?: string,
 *   labels?: ({name?: string} | string)[]}} row
 * @param {string} [today] an ISO `YYYY-MM-DD`
 * @param {number} [nowMs] the caller's clock, injected the way `fleetWaitingOn` already injects one --
 *   a test moves time without a global stub. ONLY A TIMESTAMPED `Not-before:` READS IT; a date-only
 *   value is measured against `today`, so every caller that never had a clock is unchanged.
 * @returns {{kind: "row", numbers: number[]} | {kind: "date", date: string}
 *   | {kind: "answer", session: string} | null}
 */
export function waitingOn(row, today = todayIso(), nowMs = Date.now()) {
  const open = (row?.blockedBy?.nodes ?? []).filter((n) => String(n?.state ?? "OPEN").toUpperCase() === "OPEN");
  if (open.length > 0) return { kind: "row", numbers: open.map((n) => Number(n.number)) };
  const date = notBeforeDate(row?.body);
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
 * that: `ANSWER_PREFIX` was spelled in `work-gate.mjs`, so every OTHER reader of "is this row waiting on
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
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function fleetHoldUntil(body) {
  const m = /^[ \t]*#{0,6}[ \t]*Fleet-hold-until:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)[ \t]*$/im
    .exec(String(body ?? ""));
  if (!m) return null;
  return roundTripsUtc(m[1]) ? m[1] : null;
}

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
export function fleetWaitingOn(row, today = todayIso(), nowMs = Date.now()) {
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
export function describeWaiting(waiting) {
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
 * `wake.mjs` mechanised it, and the author-prompt path bypassed even that. A rule with no witness decays
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
export function proseBlockers(issues) {
  const found = [];
  for (const issue of issues ?? []) {
    if ((issue?.blockedBy?.totalCount ?? 0) > 0) continue;
    if (notBeforeDate(issue?.body) !== null) continue;
    // A ROW THAT CARRIES `answer:<session>` HAS ALREADY DONE WHAT THIS CAUSE ASKS FOR, and nagging a
    // session that complied is how a smell becomes noise -- the same finding #1780 recorded when
    // `unfiledEpics` re-asked `product-manager` about an epic whose blocker it had just recorded.
    if (answerOwedBy(/** @type {any} */ (issue)) !== null) continue;
    const m = /(?:blocked (?:by|on)|waiting (?:on|for))[^.\n]{0,80}/i.exec(String(issue?.body ?? ""));
    if (m) found.push({ number: Number(issue.number), quote: m[0].trim() });
  }
  return found;
}
