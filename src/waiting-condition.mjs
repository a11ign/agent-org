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
// A WAITING CONDITION MUST NAME WHAT IT WAITS ON, in a form a machine can evaluate. Both of these do,
// and both therefore CLEAR THEMSELVES -- which is the property `blocked` lacks and the reason `blocked`
// rots.

/**
 * The `Not-before:` line, or `null`.
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
 * ISO DATES ONLY, because they compare lexically and every other format invites a parser that guesses.
 * A malformed date is NOT a wait -- it fails OPEN, so a typo leaves the row visible and someone finds
 * it, rather than hiding it silently until a human happens to read the body.
 *
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function notBeforeDate(body) {
  const m = /^[ \t]*Not-before:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/im.exec(String(body ?? ""));
  return m ? m[1] : null;
}

/**
 * What this row is waiting on, or `null` when nothing is stopping it.
 *
 * PURE, and the two kinds are deliberately different mechanisms:
 *
 *   a row  -> GITHUB'S OWN `blockedBy`. Not a convention this org invented: `gh issue create` already
 *             takes `--blocked-by`, `gh issue list --json blockedBy` already returns it, the GitHub UI
 *             already renders it, and the gate already makes that call. Zero new vocabulary, and the
 *             edge is enforced by GitHub rather than by a parser of ours.
 *   a date -> the `Not-before:` field above, because GitHub has no equivalent.
 *
 * ONLY AN OPEN BLOCKER COUNTS. `blockedBy.nodes` keeps closed rows in the list, and a closed blocker is
 * a condition that HAS CLEARED -- reading it as still blocking is the rot this module exists to remove.
 *
 * @param {{blockedBy?: {nodes?: {number?: number, state?: string}[]}, body?: string}} row
 * @param {string} today an ISO `YYYY-MM-DD`
 * @returns {{kind: "row", numbers: number[]} | {kind: "date", date: string} | null}
 */
export function waitingOn(row, today) {
  const open = (row?.blockedBy?.nodes ?? []).filter((n) => String(n?.state ?? "OPEN").toUpperCase() === "OPEN");
  if (open.length > 0) return { kind: "row", numbers: open.map((n) => Number(n.number)) };
  const date = notBeforeDate(row?.body);
  if (date !== null && date > today) return { kind: "date", date };
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
 * @param {{kind: string, numbers?: number[], date?: string}} waiting
 */
export function describeWaiting(waiting) {
  if (waiting.kind === "row") return `blocked by ${(waiting.numbers ?? []).map((n) => `#${n}`).join(", ")}`;
  return `not before ${waiting.date}`;
}
