#!/usr/bin/env node
// @ts-check
// RULE: DOES THIS ROW'S BODY WAIT IN PROSE WHILE DECLARING NO NATIVE `blocked-by`/`blocking` LINK? --
// #1832, follow-up implementation for `ceo`'s ruling on #1734 (2026-09-19T11:32:02Z, "Adopt C: record
// dependencies as dependencies").
//
// C made `--blocked-by`/`--blocking` the machine-readable form of a waiting relationship
// (`waiting-condition.mjs`, `gh issue edit --add-blocking`) -- but nothing caught the gap AT FILING TIME
// between a body that SAYS it waits and one that DECLARES it. `ceo`'s own comment named the checkable
// shape directly: a guard that flags a row whose body matches a waiting-language pattern ("waits for",
// "blocked by", "after the ... publish/lands/merges") but declares no native `blocked-by`/`blocking`
// link -- caught here the same way a missing Open-check already is, not discovered after the fact the
// way #1734's own four instances were.
//
// A WARNING, NEVER A REFUSAL -- the same shape `directoryRegionWarning` and `unrecognisedRegionWarning`
// (`row-file.mjs`) already use. English is not reliably parseable: "the audit that ran after the sweep"
// is not a blocking relationship, and refusing on a heuristic pattern match would block correct filings
// to prevent a possible false positive. The failure this row is about is SILENCE; a line on stderr ends
// it without taking the decision away.
//
// A ROW THAT ALREADY CARRIES A `## Not-before: <date>` FIELD IS NEVER WARNED, even when its prose also
// reads as waiting language -- that field is already the machine-readable form for a date-shaped wait
// (the other half of C), and this guard is only about the row-shaped kind that today has no
// representation at all. `notBeforeDate` is imported from `waiting-condition.mjs` unchanged, the one
// reader of that field, never a second copy.
//
// NOT A SECOND `proseBlockers`. `waiting-condition.mjs`'s own `proseBlockers` reads ALREADY-FILED rows
// from GitHub (a nightly hygiene sweep over the whole tracker, per that file's own header) and excludes
// any row that already carries an open `blockedBy` edge or a `Not-before:` field. This reads a BODY
// BEFORE FILING, against the flags THIS invocation is about to send -- a row cannot yet have a
// `blockedBy` edge of its own at filing time, so what stands in for it here is whether `argv` declares
// one. The two check different moments and cannot share an implementation, only the same vocabulary.
import { notBeforeDate } from "../waiting-condition.mjs";

/**
 * `ceo`'s three named patterns, case-insensitive, illustrative wording rather than a required exact
 * regex (the row's own words). Each is scoped narrowly enough that ordinary prose using the same words
 * without a blocking sense does not trip it -- "wait" alone, or "after" alone, is not enough.
 */
const WAITING_LANGUAGE_PATTERNS = [
  // "waits for" / "waits on" / "wait for" / "wait on" -- not bare "wait", which reads in plenty of prose
  // with no blocking sense ("please wait a moment").
  /\bwaits?\s+(?:for|on)\b/i,
  // "blocked by" -- not bare "blocked", which can describe a moment that already passed ("was blocked,
  // but only briefly") without naming what to link to.
  /\bblocked\s+by\b/i,
  // "after the ... publish(es/ed/ing)/lands(ing)/merges(ing/ed)" -- not bare "after", which is ordinary
  // prose ("after the meeting, we regrouped") far more often than it names a dependency.
  /\bafter\b[^.\n]{0,60}\b(?:publish(?:es|ed|ing)?|lands?|landing|merges?|merging|merged)\b/i,
];

/**
 * Does `argv` declare a native blocking relationship for THIS filing -- `--blocked-by=` or
 * `--blocking=`, the two flags `gh issue create` and `gh issue edit` already read? A body that waits in
 * prose but whose filing also carries one of these is not the gap this row is about: the wait is already
 * recorded in a form a machine can evaluate, alongside the sentence that explains it.
 * @param {string[]} argv
 * @returns {boolean}
 */
function declaresNativeBlocker(argv) {
  return (argv ?? []).some((arg) => arg.startsWith("--blocked-by=") || arg.startsWith("--blocking="));
}

/**
 * THE VERDICT, PURE -- a warning string when `body` reads as waiting on something in prose and neither a
 * `## Not-before:` field nor a `--blocked-by=`/`--blocking=` flag in `argv` gives that wait a
 * machine-readable form; `null` otherwise.
 * @param {string} body
 * @param {string[]} argv
 * @returns {string | null}
 */
export function waitingLanguageWarning(body, argv) {
  if (!WAITING_LANGUAGE_PATTERNS.some((pattern) => pattern.test(body))) return null;
  if (notBeforeDate(body) !== null) return null;
  if (declaresNativeBlocker(argv)) return null;
  return "WARNING -- this row's body reads as waiting on something, but the filing declares no native "
    + "blocking link. A sentence saying a row waits is not something anything else can act on -- if this "
    + "row waits on ANOTHER ROW, refile with `--blocked-by=#N` (or add it after with `gh issue edit "
    + "--add-blocked-by`); if it waits on a DATE, add a `## Not-before: YYYY-MM-DD` line to the body. If "
    + "the prose is not actually a wait -- just discussing blockers, not stating one -- nothing to do.";
}
