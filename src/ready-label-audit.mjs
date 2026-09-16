#!/usr/bin/env node
// @ts-check
// command: audit the tracker's ready label for contradictions, debris, and rows absent from the board
// `ready` MUST BE MUTUALLY EXCLUSIVE WITH EVERY LABEL THAT ALREADY MEANS "NOT ACTUALLY PICKABLE".
//
// Tonight (2026-09-06) `dispatcher` labelled #13 and #75 `ready` to hit a floor `ceo` had asked for, while
// #13's own comment thread said "DISPUTED, and not Ready until it is ruled on" and #75 carried no Region
// or Acceptance a worker could run. Both labels were removed once caught -- "a floor met by a label I
// control is not a measurement". `ready`/`fleet-gated` was already ruled mutually exclusive the same
// night, for the identical reason: a row with a completable offline half should be SPLIT, never
// double-labelled. This generalises that rule to every label that already carries the same meaning, and
// makes it a command rather than a memory.
//
// `disputed`, `decision`, `awaiting-merge` and `blocked` each already say, in their own GitHub label
// description, that the row is not currently pickable. `review-only` is new -- for #27's shape, a row
// filed to solicit review or a decision and never meant to be started as work, which had no label at all
// until now and was dispatched twice for lack of one.
//
// #378: THIS AUDIT ITSELF WAS THE FOURTH INSTANCE, IN ONE DAY, OF A CHECK THAT CANNOT SEE THE CASE IT
// EXISTS FOR. It reads `--state open`, and its own docstring says "which OPEN issues carry `ready`..." --
// so 119 CLOSED rows still carrying `ready`, `in-progress` or a `session:*` label (spotted when three of
// worker-audit's own completed rows kept reading "still Ready" after merge) sat entirely outside its
// population. Two of the 119 (#291, #292) carry `ready` while closed, so any Ready count taken by label
// rather than by state was silently wrong by two.
//
// A CLOSED row and an OPEN row need DIFFERENT verdicts, reported as separate populations, never collapsed:
// on an open row `ready` beside `blocked` is a CONTRADICTION to resolve; on a closed row it is DEBRIS --
// nobody is going to pick it up, and reporting it as a contradiction would bury real ones under 119 pieces
// of noise. The mutex check on open rows (#246) is UNCHANGED by this -- `fetchOpenIssues` still reads
// `--state open` and `mutexViolations` still means exactly what it meant before. `fetchAllIssues` and
// `closedDebris` below are additive, reading `--state all` for the population the mutex check cannot see.
//
// This audit REPORTS the debris; it does not strip it. The tracker's labels are `product-manager`'s, and
// `ceo` has ruled that a bulk label mutation is their deliberate act, not a side effect of a script change.
//
//   npm run ready:audit           print every violation and exit 1, or exit 0 with the count
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
// RELATIVE, NOT the `@a11ign/worker-fleet/cli-flags` package specifier: that export map
// points at `dist/`, so it needs both `node_modules` AND a completed build. This file is reachable
// from a pre-install entry (see `pre-install-import-graph.test.ts`, which derives that population
// rather than naming it), and there it dies on startup with ERR_MODULE_NOT_FOUND.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { fetchBoardItems, PROJECT_NUMBER } from "./board-snapshot.mjs";
// `claimsFromEvents`/`describeClaims` are no longer imported: a row that reaches the report has NO claim
// events by construction, so describing them printed "no session ever claimed this row" every time --
// a sentence that was true, said nothing, and read as the whole answer. `attributionFor` says which of
// the three states it is instead.
import { fetchClosedRowEvents, unattributableClosedRows, reportableUnattributable, attributionFor,
  fetchClosingPullRequest, PROVENANCE_REQUIRED_FROM } from "./claim-provenance.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { READY_LABEL, WAS_READY_LABEL } from "./claim-labels.mjs";
// #782: THE PURE DECISION ONLY -- `labelsToStrip` classifies a label, it never calls `gh`. Importing it
// does NOT give this file a mutation capability; the header above's ruling ("this audit REPORTS the
// debris; it does not strip it... a bulk label mutation is product-manager's deliberate act") is
// untouched. Safe from a cycle (#804): `close-rows-for-merged-pr.mjs` imports its own label constants
// from the leaf `claim-labels.mjs`, never from this file, so this file importing FROM it forms no loop.
import { labelsToStrip } from "./close-rows-for-merged-pr.mjs";
// #1130: the label constant comes from where the BOARD reads it, never restated here -- the drift
// check below exists because two copies of one fact disagreed, so it must not add a third.
import { OUT_OF_RELEASE_LABEL } from "./board-data.mjs";

// #804: READY_LABEL/WAS_READY_LABEL are IMPORTED (above) from the leaf claim-labels.mjs and re-exported
// here, not declared in this file -- see claim-labels.mjs's own header for why. Every existing
// `import { READY_LABEL } from "./ready-label-audit.mjs"` call site is unchanged. A bare `export {...}
// from` would forward the binding WITHOUT creating a local one, and this file's own code below needs the
// local name -- hence import-then-export as two separate statements rather than one re-export line.
export { READY_LABEL, WAS_READY_LABEL };

/**
 * Every label that already means "not actually pickable", independent of `ready`.
 *
 * `in-progress` USED TO belong here (#246), and #673 split it out into its own check
 * (`handClaims`/`reportHandClaims`, below). `row-claim.mjs`'s `writeRowLabels` removes `READY_LABEL` in
 * the SAME `gh issue edit` call that adds `in-progress`/`session:*` -- always, atomically -- so a row
 * genuinely claimed through `row-claim.mjs` can never be observed carrying both. `ready` + `in-progress`
 * together is therefore not a generic contradiction the way `ready` + `blocked` is: it is PROOF the claim
 * was made through some other route (`gh issue edit --add-label` by hand, or a direct assignment), never
 * through the mechanism itself. Measured 2026-09-09: #634, #635 and #633 all sat in exactly this state,
 * claimed by hand within hours of being filed, and stayed advertised as pickable until an audit run by
 * hand caught them. Reporting that as "remove one or the other" -- this list's generic remedy -- names
 * the symptom; naming it as a hand claim names the cause AND the remedy in the same sentence (#655's
 * rule), so it gets a dedicated check instead of a place in this generic list.
 *
 * `runner:*` DELIBERATELY DOES NOT JOIN THIS LIST (#444). A row reserved for a specific session
 * (`ready` + `runner:worker-audit`) is still genuinely pickable -- BY ITS RUNNER -- so it is not a
 * contradiction the way `ready` + `blocked` is. Adding `runner:` here would make every reserved row read
 * as a violation nobody can resolve, since the "fix" `mutexViolations` implies (remove one of the two
 * labels) is wrong for a reservation that is working exactly as designed. See `isClosedDebrisLabel`
 * below for the state `runner:` genuinely DOES belong to: a reservation nobody is left to honour, once
 * the row is closed.
 */
export const MUTEX_LABELS =
  ["fleet-gated", "disputed", "decision", "awaiting-merge", "blocked", "review-only"];

/**
 * @typedef {{ number: number, title: string, labels: string[] }} LabelledIssue
 */

/** @type {(cmd: string, args: string[]) => string} */
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });

/**
 * Reads every OPEN issue's labels from the real board. Same discipline as `row-claim.mjs`'s `fetchLabels`:
 * `gh` failing, or answering with a shape this function does not recognise, THROWS -- it never falls
 * through to an empty issue list, which would report "audited: 0 violations" having examined nothing. A
 * clean sweep and a broken query must never print the same thing.
 *
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {LabelledIssue[]}
 */
export function fetchOpenIssues({ run = defaultRun } = {}) {
  return fetchIssues({ run, state: "open", limit: 200 });
}

/**
 * #788: THE ISSUE NUMBERS GITHUB ITSELF REPORTS OPEN, independent of `fetchIssues`'s own `gh issue list`
 * call -- GitHub's search index, asked the identical question a second way, so the two can be compared
 * rather than one trusted alone. `type:issue`/`is:open` (via `is:issue is:open`) deliberately does NOT
 * use the repository API's own `open_issues_count`: that field is the well-documented quirk of counting
 * open issues AND open pull requests together, so it would never equal `fetchIssues`'s issues-only count
 * even on a perfectly healthy tracker.
 *
 * #838: RETURNS THE NUMBERS, NOT JUST A COUNT -- the count-only version could say two reads disagreed,
 * never which row was the difference, so a genuine population shrink and an ordinary single-row race
 * (an issue opened or closed between two reads of a live tracker moving underneath it) printed the
 * identical "examined 66, search reports 65" and were refused identically. `openIssueSetSummary` below
 * needs the actual SET to tell them apart.
 *
 * THROWS on any failure or an unparseable number, same discipline as every other fetcher here: a silent
 * empty list would read as "no issues are open", the opposite of an honest "could not ask".
 *
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {number[]}
 */
export function fetchReportedOpenIssueNumbers({ run = defaultRun } = {}) {
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", `search/issues?q=${encodeURIComponent(`repo:${REPO} is:issue is:open`)}`,
      "--paginate", "--jq", ".items[].number"]);
  } catch (cause) {
    throw new Error(`ready-label-audit: could not read GitHub's reported open-issue numbers -- refusing `
      + `to guess whether the examined population is complete. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    const n = Number(line.trim());
    if (!Number.isFinite(n)) {
      throw new Error(`ready-label-audit: GitHub's reported open-issue numbers included a non-number `
        + `line -- refusing to guess. Got: ${line.slice(0, 200)}`);
    }
    return n;
  });
}

/**
 * Pure: do two SETS of open-issue numbers agree, and if not, which numbers are in one and not the
 * other? #838: named EXPLICITLY as "in one, not the other" rather than a bare count difference -- a
 * count of 66 vs 65 says nothing about WHICH row, and cannot distinguish a genuine population shrink
 * from the two sides each naming 65 of the same 66 rows plus one different straggler apiece (a count
 * that could, by coincidence, even agree while the sets do not).
 * @param {number[]} examined
 * @param {number[]} reported
 * @returns {{ agree: boolean, onlyExamined: number[], onlyReported: number[] }}
 */
export function openIssueSetSummary(examined, reported) {
  const examinedSet = new Set(examined);
  const reportedSet = new Set(reported);
  const onlyExamined = examined.filter((n) => !reportedSet.has(n));
  const onlyReported = reported.filter((n) => !examinedSet.has(n));
  return { agree: onlyExamined.length === 0 && onlyReported.length === 0, onlyExamined, onlyReported };
}

/**
 * #788: `fetchOpenIssues`, but STATES what it examined against what GitHub's own search index reports
 * open, and REFUSES the whole read as partial when they differ -- rather than each of the mutex,
 * hand-claim, stranded, board-membership, dead-claim, already-merged and #788's own labelless-row checks
 * silently examining a population smaller (or larger) than the tracker actually holds and reporting a
 * clean result regardless. #715's own rule, generalised: a guard whose population is a query must assert
 * about the SEARCH, not only about its result -- an audit reporting "OK 74 open issues checked" has
 * examined only the rows its query could see, and #623 was reachable by NO label query at all.
 *
 * #838: A MISMATCH RE-READS ONCE BEFORE REFUSING. Measured live: "examined 66, search reports 65"
 * refused FIVE of nine checks -- two reads a second apart across a tracker that keeps moving, the
 * ORDINARY state for a live board, not a shrunk population. Two reads is not proof against a genuine
 * shrink either, so the SECOND disagreement still refuses -- this buys one honest retry against a race,
 * not infinite trust in whatever the tracker says. A mismatch the retry resolves is NAMED on stderr
 * (which rows raced, and that a second read agreed), never silently swallowed: the audit proceeds, but
 * the fact that it needed a second look is part of the record, not folded into a plain "OK".
 *
 * @param {{ run?: typeof defaultRun, fetchReportedNumbers?: typeof fetchReportedOpenIssueNumbers }} [deps]
 * @returns {{ issues: LabelledIssue[], reportedCount: number }}
 */
export function fetchOpenIssuesChecked(
  { run = defaultRun, fetchReportedNumbers = fetchReportedOpenIssueNumbers } = {}) {
  const issues = fetchOpenIssues({ run });
  const reportedNumbers = fetchReportedNumbers({ run });
  const first = openIssueSetSummary(issues.map((i) => i.number), reportedNumbers);
  if (first.agree) return { issues, reportedCount: reportedNumbers.length };

  const retryIssues = fetchOpenIssues({ run });
  const retryReportedNumbers = fetchReportedNumbers({ run });
  const second = openIssueSetSummary(retryIssues.map((i) => i.number), retryReportedNumbers);
  if (second.agree) {
    process.stderr.write(`ready-label-audit: the first read disagreed with GitHub's search index -- `
      + `examined-only: ${first.onlyExamined.join(", ") || "none"}; search-only: `
      + `${first.onlyReported.join(", ") || "none"}. A live tracker moving between two reads is the `
      + `ordinary state; the second read agrees, so this is named here rather than counted as partial.\n`);
    return { issues: retryIssues, reportedCount: retryReportedNumbers.length };
  }
  throw new Error(`ready-label-audit: examined open issues disagree with GitHub's search index on BOTH `
    + `reads -- refusing to audit a population that may have shrunk (or grown) for real, not merely `
    + `raced. Examined but not in search: ${second.onlyExamined.join(", ") || "none"}. In search but `
    + `not examined: ${second.onlyReported.join(", ") || "none"}.`);
}

/**
 * The most this walk will ask for before refusing to call a full page a total (#1090). A CEILING rather
 * than a cap: it is reached only by doubling, and reaching it is REPORTED as a lower bound rather than
 * treated as an answer -- which is the whole difference between this and the 500 it replaces.
 */
const MAX_ISSUE_FETCH = 8000;

/**
 * Where a walk starts asking. Not a bound on anything: too low costs an extra round trip and too high
 * costs a larger first response, and neither can make the answer wrong, because only a SHORT page ends
 * the walk. Stated once so no caller has to pick a number that looks load-bearing and is not.
 */
const FIRST_ASK = 500;

/**
 * How many asks it takes to double from `first` to the ceiling, inclusive -- DERIVED, so it cannot drift
 * from the two constants it is about.
 *
 * #1098 (worker-capture): the loop terminated because TWO expressions agreed -- `Math.min(limit * 2,
 * MAX_ISSUE_FETCH)` stopped growing and `limit >= MAX_ISSUE_FETCH` threw. Change that `>=` to `>` and it
 * asks for 8000 for ever: measured, `exit 124`, no output at all.
 *
 * **A hang is not a refusal.** This whole walk exists so a partial count is never reported as a total,
 * and a hang reports neither -- in the nightly it is a stuck job rather than a failing one, which is the
 * quietest of the three. So the iteration count is bounded independently of the value comparison, and
 * exhausting it throws and names itself. I had already met this shape and re-spelled the MUTATION around
 * it, which made the measurement possible and left the code able to hang.
 *
 * @param {number} first
 * @returns {number}
 */
function asksToCeiling(first) {
  return Math.ceil(Math.log2(MAX_ISSUE_FETCH / Math.max(first, 1))) + 1;
}

/**
 * #1090: ASK FOR MORE UNTIL THE ANSWER IS SHORT -- the shared walk behind every list in this file.
 *
 * The two closed-list reads below had **no truncation guard at all**: a hand-set `--limit 1000` and no
 * check that the answer was shorter than it. Measured 2026-09-12, 555 closed PRs and 472 closed issues --
 * so they are under the cap today and will pass it silently, which is worse than the 500 cap that went
 * dark LOUDLY by refusing. **A guarded cap fails closed; an unguarded one fails quiet.**
 *
 * @param {{ run: typeof defaultRun, argv: (limit: number) => string[], what: string,
 *           first?: number }} spec
 * @returns {unknown[]}
 */
function listUntilShort({ run, argv, what, first = FIRST_ASK }) {
  const maxAsks = asksToCeiling(first);
  for (let limit = first, asks = 1; ; limit = Math.min(limit * 2, MAX_ISSUE_FETCH), asks++) {
    if (asks > maxAsks) {
      throw new Error(`ready-label-audit: asked gh for ${what} ${asks - 1} times without `
        + `reaching either a short page or the ${MAX_ISSUE_FETCH} ceiling. That cannot happen `
        + `while the doubling and the ceiling check agree, so one of them has been changed -- `
        + `refusing to loop. A hang reports no count at all, which is worse than refusing.`);
    }
    /** @type {string} */
    let raw;
    try {
      raw = run("gh", argv(limit));
    } catch (cause) {
      throw new Error(`ready-label-audit: could not list ${what} from ${REPO} -- refusing to guess. `
        + `${/** @type {Error} */ (cause).message}`, { cause });
    }
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`ready-label-audit: gh's ${what} response was not JSON -- refusing to guess. `
        + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`ready-label-audit: gh's ${what} response was not a list -- refusing to guess. `
        + `Got: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    if (parsed.length < limit) return parsed;
    if (limit >= MAX_ISSUE_FETCH) {
      throw new Error(`ready-label-audit: gh returned exactly ${limit} ${what}, the ceiling this walk `
        + `will ask for. That is indistinguishable from a truncated result and the count is a LOWER `
        + `BOUND, not a total -- refusing to report it as one.`);
    }
  }
}

/**
 * Reads issues from the real board, at the given `--state`. Shared by `fetchOpenIssues` (unchanged
 * behaviour: `--state open`, limit 200, still exactly what the mutex check reads) and `fetchAllIssues`
 * (`--state all`, the population #378 exists to make visible). `gh` failing, answering with a shape this
 * function does not recognise, or returning exactly `limit` rows all THROW -- the last case is a BOUNDED
 * LISTING READ AS AN ANSWER, this repo's own most-repeated shape, and 51 open + 174 closed already exceeds
 * the audit's old 200 cap once both populations are read together.
 *
 * @param {{ run?: typeof defaultRun, state: "open" | "all", limit?: number }} args
 * @returns {(LabelledIssue & { state?: "OPEN" | "CLOSED" })[]}
 */
export function fetchIssues({ run = defaultRun, state, limit = FIRST_ASK }) {
  // #1090: THE REFUSAL WAS RIGHT AND "RAISE THE LIMIT" WAS NOT A FIX.
  //
  // A hand-set cap goes stale silently the day the population passes it -- measured 2026-09-12: 472
  // closed + 59 open = 531 against a 500 cap, so this check had gone dark and correctly refused rather
  // than reporting a partial count as a complete one. Raising it to 1000 defers the same defect by a
  // few months and leaves nothing to notice the next time.
  //
  // A PAGINATION WALK ENDS ON A SHORT PAGE -- a positive statement of having reached the end -- never on
  // a count compared against a literal. `gh issue list --limit N` is a TOTAL rather than a page, so the
  // walk is expressed by ASKING FOR MORE until the answer is short.
  //
  // ONE WALK, NOT THREE. This routes through `listUntilShort` rather than carrying its own copy: the row
  // names the three hand-set caps in this file as the SAME defect, and a fix reaching one call site when
  // the behaviour reaches three is this repository's most expensive recurring shape. `limit` survives as
  // a parameter only because `fetchOpenIssues` starts its walk lower.
  const parsed = listUntilShort({ run, first: limit, what: `${state} issues`,
    argv: (ask) => ["issue", "list", "--repo", REPO, "--state", state, "--limit", String(ask),
      "--json", "number,title,labels,state"] });
  return parsed.map((/** @type {unknown} */ entry, /** @type {number} */ i) => {
    const obj = /** @type {{ number?: unknown, title?: unknown, labels?: unknown, state?: unknown }} */ (entry);
    if (typeof obj?.number !== "number" || typeof obj?.title !== "string" || !Array.isArray(obj?.labels)) {
      throw new Error(`ready-label-audit: entry ${i} is missing number/title/labels -- refusing to guess. `
        + `Got: ${JSON.stringify(entry).slice(0, 300)}`);
    }
    // `state` is READ, not REQUIRED: `fetchOpenIssues` never asked `gh` for it before #378 and every
    // existing caller of the shared parser (including this file's own long-standing test fixtures) omits
    // it -- requiring it here would make a well-formed OLD-shape response throw. Absent reads as neither
    // OPEN nor CLOSED, which `closedDebris` treats as "not closed" -- conservative, since the one thing
    // that function must never do is report a row as closed debris on a guess.
    const state = obj?.state === "OPEN" || obj?.state === "CLOSED" ? obj.state : undefined;
    const names = obj.labels.map((/** @type {unknown} */ l) => {
      const name = /** @type {{ name?: unknown }} */ (l)?.name;
      if (typeof name !== "string") {
        throw new Error(`ready-label-audit: issue #${obj.number} has a label with no name -- refusing to `
          + `guess. Got: ${JSON.stringify(l)}`);
      }
      return name;
    });
    // `state` is OMITTED, not set to `undefined`, when absent -- so `fetchOpenIssues`'s existing shape
    // (no `state` key at all) is byte-identical to before #378, rather than gaining a key whose value is
    // always `undefined` for every caller that never asked `gh` for it.
    return state === undefined
      ? { number: obj.number, title: obj.title, labels: names }
      : { number: obj.number, title: obj.title, labels: names, state };
  });
}

/**
 * Every issue, open and closed, in ONE call -- `--state all`. #378's own population: `mutexViolations`
 * keeps reading only what `fetchOpenIssues` returns, unchanged; this is additive.
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {(LabelledIssue & { state?: "OPEN" | "CLOSED" })[]}
 */
export function fetchAllIssues({ run = defaultRun } = {}) {
  return fetchIssues({ run, state: "all" });
}

/**
 * Pure: which open issues carry `ready` together with a label that already means "not pickable"?
 *
 * @param {LabelledIssue[]} issues
 * @returns {Array<{ number: number, title: string, conflicting: string[] }>}
 */
export function mutexViolations(issues) {
  const violations = [];
  for (const { number, title, labels } of issues) {
    if (!labels.includes(READY_LABEL)) continue;
    const conflicting = MUTEX_LABELS.filter((l) => labels.includes(l));
    if (conflicting.length > 0) violations.push({ number, title, conflicting });
  }
  return violations;
}

/**
 * #673: Pure -- which open issues carry BOTH `ready` and `in-progress`? `row-claim.mjs`'s
 * `writeRowLabels` removes `READY_LABEL` in the same edit that adds `in-progress`/`session:*`, always --
 * so this co-occurrence can only arise from a claim made outside `row-claim.mjs` (a hand-applied label, a
 * direct assignment). A row claimed through the real mechanism never reaches this filter, which is the
 * mutation the issue itself names: claim one through `row-claim` and confirm this stays silent.
 *
 * @param {LabelledIssue[]} issues
 * @returns {Array<{ number: number, title: string, sessions: string[] }>}
 */
export function handClaims(issues) {
  const claims = [];
  for (const { number, title, labels } of issues) {
    if (!labels.includes(READY_LABEL) || !labels.includes("in-progress")) continue;
    const sessions = labels.filter((l) => l.startsWith("session:"));
    claims.push({ number, title, sessions });
  }
  return claims;
}

/**
 * A label on a CLOSED row that means "pickable" or "claimed" -- not a contradiction to resolve, DEBRIS
 * nobody is going to act on.
 *
 * #782: DELEGATES TO `labelsToStrip` for `ready`/`in-progress`/`started`/`session:*`, rather than a
 * second, hand-rolled list -- found 2026-09-09 when a real sweep using `labelsToStrip` caught 52 closed
 * rows carrying only a stale `started` label that this function's own list (missing `started` entirely)
 * had never once flagged. That is the "a fact stated twice, and the copies drifted" shape: two
 * independent answers to "what counts as a stale claim label on a closed row", with nothing comparing
 * them. Delegating means there is exactly one list to drift FROM now.
 *
 * `runner:*` stays as this function's OWN addition, deliberately not folded into `labelsToStrip` (#444): a
 * reservation is the same family as `session:*` -- a claim on a row with nobody left to honour it once the
 * row is closed -- but `labelsToStrip` must never remove it (`row-claim.mjs`'s own comment: it survives a
 * claim on purpose, recording WHO a row was reserved for). A closed, runner-reserved row is not a
 * contradiction (see `mutexViolations`'s own doc for why `runner:` must NOT join `MUTEX_LABELS` instead),
 * it is the identical stale-bookkeeping shape `session:*` debris already is -- reported here, never
 * stripped by either function.
 * @param {string} label
 * @returns {boolean}
 */
export function isClosedDebrisLabel(label) {
  return labelsToStrip([label]).length > 0 || label.startsWith("runner:");
}

/**
 * Pure: which CLOSED issues still carry a label that means pickable/claimed? A SEPARATE population from
 * `mutexViolations`, reported with separate wording -- collapsing the two would bury the real open-row
 * contradictions under however many closed rows carry stale bookkeeping (measured 2026-09-07: 119).
 *
 * @param {(LabelledIssue & { state?: "OPEN" | "CLOSED" })[]} issues
 * @returns {Array<{ number: number, title: string, debris: string[] }>}
 */
export function closedDebris(issues) {
  const found = [];
  for (const { number, title, labels, state } of issues) {
    if (state !== "CLOSED") continue;
    const debris = labels.filter(isClosedDebrisLabel);
    if (debris.length > 0) found.push({ number, title, debris });
  }
  return found;
}

/**
 * #788: Pure -- which open issues carry NO labels at all? Not `unclaimed`, not `not ready`, not
 * `blocked` -- ABSENT. Every check in this file, the Ready lane, the backlog view, the WIP count, the
 * dead-claim check, the hourly table and the section-backfill sweep are all keyed on labels, so a row
 * carrying none is invisible to all of them at once, not merely to one. Measured 2026-09-09: three open
 * rows (#623, #644, #600), fixed by hand -- #623 was the most irreversible row on the 15 September
 * transfer milestone and reachable by no label query at all. Nothing stops a fourth: filing requires no
 * label, and every check that would notice reads by label.
 * @param {LabelledIssue[]} openIssues
 * @returns {LabelledIssue[]}
 */
export function labellessRows(openIssues) {
  return openIssues.filter((i) => i.labels.length === 0);
}

/**
 * Pure: which OPEN issues have NO item on the Project board at all? Neither a label check (the label is
 * correct) nor a Status check (there is no item to read a Status from) can see this on its own -- it is
 * visible only as a comparison between the two populations. Measured 2026-09-08: four `ready` rows
 * existed this way while the Ready lane read empty and idled a worker.
 *
 * #788: WIDENED FROM `ready` ROWS TO EVERY OPEN ROW -- ceo's ruling, 2026-09-09. The `ready`-only version
 * reported nothing while 24 open rows of every OTHER kind had no Project item; it was right to, since it
 * was only ever asked about the `ready` subset. Project 2 is the view the chairman reads, so a row off
 * it is invisible there exactly as a labelless row was invisible to the label-keyed checks -- the same
 * shape at a different layer, closed the same way: widen the population, not the label list.
 * @param {LabelledIssue[]} openIssues
 * @param {Set<number>} boardNumbers issue numbers that have an item on the Project
 * @returns {LabelledIssue[]}
 */
export function openRowsAbsentFromBoard(openIssues, boardNumbers) {
  return openIssues.filter((i) => !boardNumbers.has(i.number));
}

/**
 * @typedef {{ number: number, state: string, mergedAt: string | null }} ClosingPrRef
 */

/**
 * @typedef {{ number: number, title: string, state: "ALREADY-MERGED", closedBy: number, mergedAt: string }
 *   | { number: number, title: string, state: "REOPENED-AFTER-MERGE", closedBy: number, mergedAt: string,
 *       reopenedAt: string }} AlreadyMergedRow
 */

/**
 * Pure: which OPEN `ready`/`in-progress` issues does a MERGED PR already claim to close, and -- #550 --
 * was the row put back DELIBERATELY after that merge, rather than simply forgotten? #443 -- #438 was
 * merged as #440 at 02:31Z, never auto-closed (bot-attributed merges do not close a referenced issue --
 * see `close-rows-for-merged-pr.mjs`'s own header), and sat `ready` until a worker claimed it and had to
 * revert. Every existing check misses this: the collision check asks "does anyone else hold this row",
 * the mutex check asks "is `ready` beside a not-pickable LABEL", `openRowsAbsentFromBoard` asks "is it on
 * the board" -- none of them ask "did the work already ship".
 *
 * DELIBERATELY KEYED ON A CLOSING REFERENCE, never a bare mention -- `closingIssuesReferences` (fed here
 * per issue as `closingRefsByIssue`) is GitHub's OWN resolution of a `Closes #N`-shaped keyword in a PR
 * body, so a PR that only MENTIONS this issue in prose never appears in the map at all. And deliberately
 * MERGED, not merely present: an OPEN PR that declares `Closes #N` is exactly the state a worker taking
 * this row would want to know about, not a reason to hide the row.
 *
 * #550: #492 was closed by #529 (18:37:31Z), reopened (18:51:57Z), closed again by #545 (19:00:41Z), and
 * reopened again (19:06:33Z) -- every clause of the old ALREADY-MERGED sentence was true and the
 * conclusion was not, because a row REOPENED after the merge that referenced it is a refuted fix, not a
 * forgotten one. So this compares the LATEST reopen against the MOST RECENT QUALIFYING MERGE, never the
 * first of either found: a row can cycle through this more than once (as #492 did, TWICE), and only the
 * latest events on each side are the ones actually in a race. Comparing against the first reopen or the
 * first merge is right by luck whenever there is only one of each, and wrong the moment there are two.
 *
 * @param {LabelledIssue[]} readyIssues open issues already filtered to a live-state label
 * @param {Map<number, ClosingPrRef[]>} closingRefsByIssue issue number -> the PRs that would close it
 * @param {Map<number, string | null>} [latestReopenByIssue] issue number -> its LATEST `reopened` event's
 *   timestamp, from the issue's own timeline (never from a label -- a label records what somebody SET,
 *   the timeline records WHEN the row actually came back, and this whole distinction is about ordering
 *   in time). Absent or null means the issue has never been reopened.
 * @returns {AlreadyMergedRow[]}
 */
export function readyRowsAlreadyMerged(readyIssues, closingRefsByIssue, latestReopenByIssue = new Map()) {
  /** @type {AlreadyMergedRow[]} */
  const flagged = [];
  for (const issue of readyIssues) {
    const refs = closingRefsByIssue.get(issue.number) ?? [];
    const merged = refs.filter((ref) => ref.state === "MERGED" && ref.mergedAt);
    if (merged.length === 0) continue;
    const mostRecentMerge = merged.reduce(
      (a, b) => (/** @type {string} */ (a.mergedAt) > /** @type {string} */ (b.mergedAt) ? a : b),
    );
    const mergedAt = /** @type {string} */ (mostRecentMerge.mergedAt);
    const reopenedAt = latestReopenByIssue.get(issue.number);
    if (reopenedAt && reopenedAt > mergedAt) {
      flagged.push({ number: issue.number, title: issue.title, state: "REOPENED-AFTER-MERGE",
        closedBy: mostRecentMerge.number, mergedAt, reopenedAt });
    } else {
      flagged.push({ number: issue.number, title: issue.title, state: "ALREADY-MERGED",
        closedBy: mostRecentMerge.number, mergedAt });
    }
  }
  return flagged;
}


/** A row that ADVERTISES A LIVE STATE -- pickable or claimed. Both are claims about the present, and both
 * are falsified the same way: by the work already being on main.
 * @param {string[]} labels */
export function livesStateLabels(labels) {
  return labels.includes(READY_LABEL) || labels.includes("in-progress");
}

/**
 * Pure: which `in-progress` rows have no open pull request and no push behind them?
 *
 * THE CLAIM IS ABOUT THE PRESENT AND NOTHING CHECKED IT. `in-progress` says a session is working this
 * row right now. Measured 2026-09-08, after the chairman read the board: 24 open rows carried it and
 * 15 were finished or dead -- one claimed THIRTY HOURS earlier with no branch ever pushed. A claim
 * nobody can falsify is not a status, it is a decoration.
 *
 * WHY EACH SIGNAL, AND WHY NONE ALONE. An open PR is proof of work in flight. A recent push is proof of
 * work in progress that has not opened one yet. A recent COMMENT is proof of work that has produced no
 * commit at all -- a measurement posted, a plan written before the act, a deploy reported -- which is a
 * whole class of row on this tracker. Requiring a PR alone would flag every session in its first hour;
 * requiring a push alone flags a session whose only artefact so far is what it wrote on the row. A row is
 * stale only when NONE holds.
 *
 * THE COMMENT LEG IS #723's, AND THIS CHECK DISAGREED WITH IT UNTIL #756. `ceo`'s release rule reads a
 * claim as live on a push OR a comment; this read only the push, so on 2026-09-09 it reported #426 as a
 * DEAD-CLAIM while a comment 47 minutes old sat on it, and `tracker-auditor` had to overrule the tool to
 * follow the rule. A guard that disagrees with the rule it enforces trains its reader to overrule it, and
 * this one survived because it erred safe: nobody was harmed, so nobody fixed it, and what got built was
 * the habit of skipping its output.
 *
 * "BY THE CLAIMANT" IS NOT MEASURABLE HERE, AND SAYING SO IS PART OF THE FIX. `ceo`'s rule says a comment
 * BY THE CLAIMANT. Every session in this repository posts as the same GitHub user -- the identical
 * limitation `docs/board/reported/meta.json` records for the capacity metric ("two assignable accounts and
 * nine sessions") -- so `user.login` cannot name which session wrote a comment. Nor does the text: checked
 * against the live case, all three of #426's recent comments name NEITHER of its two claiming sessions.
 * So this counts any comment on the row, and the gap is filed rather than hidden. The error is toward NOT
 * releasing a claim, which is the safe direction for a release authority, and it is the reading
 * `tracker-auditor` was already applying.
 *
 * `behind` is deliberately NOT a signal here: during a drain every merge puts every branch behind, and
 * #406 sat at behind=55 while entirely healthy.
 *
 * @param {{ number: number, title: string, labels: string[] }[]} issues
 * @param {{ hasOpenPr: Map<number, boolean>, lastPushMinutes: Map<number, number>,
 *           claimedMinutes: Map<number, number>, lastCommentMinutes?: Map<number, number> }} activity
 *   the facts, which travel together. `lastCommentMinutes` is OPTIONAL so an older caller's three-fact
 *   shape still type-checks and still decides -- absent reads as "no comment seen", never as "fresh".
 * @param {number} staleAfterMinutes
 */
export function claimsNobodyIsWorking(issues, activity, staleAfterMinutes = 240) {
  const { hasOpenPr, lastPushMinutes, claimedMinutes, lastCommentMinutes } = activity;
  const stale = [];
  for (const issue of issues) {
    if (!issue.labels.includes("in-progress")) continue;
    if (hasOpenPr.get(issue.number)) continue;

    // THE CLAIM'S OWN AGE IS THE CLOCK, not the branch's. A row claimed ten minutes ago has no branch
    // because the session has not pushed yet, and a row claimed thirty hours ago has none because
    // nobody ever started -- identical evidence, opposite meanings, and only the claim time separates
    // them. MEASURED: the first live run of this check flagged five rows claimed within the hour,
    // because "no branch at all" was treated as the strongest signal regardless of when the claim was
    // made. It fired, and its first firing was five false positives, which is why it was wired before
    // it was trusted.
    const claimAge = claimedMinutes.get(issue.number);
    if (claimAge !== undefined && claimAge < staleAfterMinutes) continue;

    const age = lastPushMinutes.get(issue.number);
    if (age !== undefined && age < staleAfterMinutes) continue;

    // #723's leg, in the same window as the push. Read AFTER the push so the reported `minutes` still
    // describes the branch: a row kept alive by a comment is a different situation from one kept alive by
    // a push, and the line that names it should say which.
    const commentAge = lastCommentMinutes?.get(issue.number);
    if (commentAge !== undefined && commentAge < staleAfterMinutes) continue;

    stale.push({ number: issue.number, title: issue.title,
      sessions: issue.labels.filter((l) => l.startsWith("session:")),
      minutes: age ?? null, claimedMinutesAgo: claimAge ?? null });
  }
  return stale;
}

/**
 * One GraphQL round trip for every `ready` issue's closing PR references, via aliased sub-queries rather
 * than one call per issue -- the Ready lane is small (single digits to low tens), but N separate `gh api`
 * invocations is still N processes for one answer. Empty input makes no call at all, since an empty alias
 * list is not valid GraphQL and "nothing to ask" needs no round trip to answer.
 *
 * THROWS on any failure or unrecognised shape, same discipline as every other fetcher in this file: a
 * silently empty map would read as "no row is already merged", the opposite of an honest "could not ask".
 *
 * @param {number[]} issueNumbers
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {Map<number, ClosingPrRef[]>}
 */
export function fetchClosingPrRefs(issueNumbers, { run = defaultRun } = {}) {
  /** @type {Map<number, ClosingPrRef[]>} */
  const map = new Map();
  if (issueNumbers.length === 0) return map;
  const [owner, name] = REPO.split("/");
  const fields = issueNumbers.map((n, i) => `i${i}: issue(number: ${n}) { number `
    + `closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } }`).join(" ");
  const query = `{ repository(owner: "${owner}", name: "${name}") { ${fields} } }`;
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`ready-label-audit: could not resolve closing PR references -- refusing to guess. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`ready-label-audit: gh's closing-references response was not JSON -- refusing to `
      + `guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const repo = /** @type {any} */ (parsed)?.data?.repository;
  if (!repo || typeof repo !== "object") {
    throw new Error(`ready-label-audit: gh's closing-references response had no repository -- refusing `
      + `to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return closingPrRefsFromRepoNode(repo, issueNumbers);
}

/**
 * One GraphQL round trip for every issue's LATEST `reopened` timeline event -- #550. A separate call from
 * `fetchClosingPrRefs` rather than one field folded into it: the two are independent facts (closing PR
 * state, and the issue's own reopen history) and combining them into one richer return shape would have
 * meant restructuring that function's existing `Map<number, ClosingPrRef[]>` contract for every caller
 * and test, for a Ready lane small enough (single digits to low tens) that a second round trip costs
 * nothing worth avoiding that for.
 *
 * `last: 1` on the server side, not `.pop()` on the client -- GitHub returns timeline items OLDEST
 * first, so the LAST item in an unbounded page is the most recent one, and asking the server for exactly
 * that one item is both the correct answer and the cheaper query.
 *
 * THROWS on any failure or unrecognised shape, same discipline as `fetchClosingPrRefs`: a silently empty
 * map would read as "never reopened" for every issue, which turns every ALREADY-MERGED row into a
 * guaranteed false conclusion rather than an honest refusal.
 *
 * @param {number[]} issueNumbers
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {Map<number, string | null>} issue number -> its latest reopen's ISO timestamp, or null if
 *   the issue has never been reopened
 */
export function fetchLatestReopenedAt(issueNumbers, { run = defaultRun } = {}) {
  /** @type {Map<number, string | null>} */
  const map = new Map();
  if (issueNumbers.length === 0) return map;
  const [owner, name] = REPO.split("/");
  const fields = issueNumbers.map((n, i) => `i${i}: issue(number: ${n}) { number `
    + `timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } } }`)
    .join(" ");
  const query = `{ repository(owner: "${owner}", name: "${name}") { ${fields} } }`;
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`ready-label-audit: could not resolve reopen history -- refusing to guess. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`ready-label-audit: gh's reopen-history response was not JSON -- refusing to guess. `
      + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const repo = /** @type {any} */ (parsed)?.data?.repository;
  if (!repo || typeof repo !== "object") {
    throw new Error(`ready-label-audit: gh's reopen-history response had no repository -- refusing to `
      + `guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return latestReopenedAtFromRepoNode(repo, issueNumbers);
}

/**
 * Reads each aliased `i<N>: issue(...)` node's reopen timeline back out, keyed by the real issue number
 * rather than by alias -- split out of `fetchLatestReopenedAt` purely to keep that function's complexity
 * under gate, per this repo's Stepdown Rule and the identical split `closingPrRefsFromRepoNode` already
 * makes for `fetchClosingPrRefs`; it is the same one concept written out.
 *
 * @param {Record<string, any>} repo
 * @param {number[]} issueNumbers
 * @returns {Map<number, string | null>}
 */
function latestReopenedAtFromRepoNode(repo, issueNumbers) {
  /** @type {Map<number, string | null>} */
  const map = new Map();
  for (let i = 0; i < issueNumbers.length; i++) {
    const node = repo[`i${i}`];
    if (!node || typeof node.number !== "number") {
      throw new Error(`ready-label-audit: issue #${issueNumbers[i]} is missing from the reopen-history `
        + `response -- refusing to guess. Got: ${JSON.stringify(node ?? null).slice(0, 300)}`);
    }
    const nodes = node.timelineItems?.nodes;
    const latest = Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1]?.createdAt ?? null : null;
    map.set(node.number, latest);
  }
  return map;
}

/**
 * Reads each aliased `i<N>: issue(...)` node back out of the GraphQL response, keyed by the real issue
 * number rather than by alias -- split out of `fetchClosingPrRefs` purely to keep that function's
 * complexity under gate, per this repo's Stepdown Rule; it is the same one concept written out.
 *
 * @param {Record<string, any>} repo
 * @param {number[]} issueNumbers
 * @returns {Map<number, ClosingPrRef[]>}
 */
function closingPrRefsFromRepoNode(repo, issueNumbers) {
  /** @type {Map<number, ClosingPrRef[]>} */
  const map = new Map();
  for (let i = 0; i < issueNumbers.length; i++) {
    const node = repo[`i${i}`];
    if (!node || typeof node.number !== "number") {
      // `JSON.stringify(undefined)` returns `undefined`, not a string -- a missing alias (the exact case
      // this branch exists for) would throw INSIDE the error message rather than reporting one.
      throw new Error(`ready-label-audit: issue #${issueNumbers[i]} is missing from the closing-references `
        + `response -- refusing to guess. Got: ${JSON.stringify(node ?? null).slice(0, 300)}`);
    }
    const nodes = node.closedByPullRequestsReferences?.nodes;
    const refs = Array.isArray(nodes)
      ? nodes.map((/** @type {any} */ r) => ({ number: r.number, state: r.state, mergedAt: r.mergedAt ?? null }))
      : [];
    map.set(node.number, refs);
  }
  return map;
}

/** Report the OPEN-row mutex check exactly as before #378 -- unchanged population, unchanged wording. */
function reportMutexViolations() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  const violations = mutexViolations(issues);
  if (violations.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked, none carry `
      + `\`ready\` with a not-pickable label\n`);
    return 0;
  }
  for (const { number, title, conflicting } of violations) {
    process.stdout.write(`VIOLATION  #${number} "${title}" -- ready + ${conflicting.join(", ")}\n`);
  }
  process.stderr.write(`\n${violations.length} row(s) carry \`ready\` alongside a label that already means `
    + `not pickable. Remove one or the other.\n`);
  return violations.length;
}

/**
 * #673: Report rows claimed by hand -- `ready` + `in-progress` together, which `row-claim.mjs`'s own
 * atomic label-write can never produce. Named separately from `reportMutexViolations` because the two
 * need different remedies: a hand claim's fix is to route the claim through `row-claim.mjs`, never to
 * remove one of the two labels as `mutexViolations`' generic wording would suggest.
 */
function reportHandClaims() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  const claims = handClaims(issues);
  if (claims.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked, none carry `
      + `ready + in-progress together -- row-claim's own mechanism can never produce that state\n`);
    return 0;
  }
  for (const { number, title, sessions } of claims) {
    const who = sessions.length > 0 ? sessions.join(", ") : "an unknown session";
    process.stdout.write(`HAND CLAIM  #${number} "${title}" -- claimed by ${who} without row-claim.mjs, `
      + `which never leaves \`ready\` in place\n`);
  }
  process.stderr.write(`\n${claims.length} row(s) were claimed by hand rather than through row-claim.mjs. `
    + `Route the claim through it instead: \`node packages/agent-org/src/row-claim.mjs decline <n> `
    + `--session=<whoever holds it>\`, then claim or dispatch it properly.\n`);
  return claims.length;
}

/**
 * #788: Report open rows carrying NO labels at all -- distinct from every other check here, because
 * those all enumerate BY label and a labelless row has nothing for any of them to key on. Named
 * separately, with wording that says what absence MEANS: not merely unlabelled, but invisible to the
 * Ready lane, the backlog view, the WIP count, the dead-claim check, the hourly table and the
 * section-backfill sweep all at once -- a reader who saw only "unlabelled" could mistake it for
 * cosmetic.
 */
function reportLabelless() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  const rows = labellessRows(issues);
  if (rows.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked, none carry `
      + `zero labels\n`);
    return 0;
  }
  for (const { number, title } of rows) {
    process.stdout.write(`NO LABELS  #${number} "${title}" -- carries no label at all, so it is absent `
      + `from every other check in this audit, and from the Ready lane, the backlog view, the WIP count, `
      + `the dead-claim check, the hourly table and the section-backfill sweep, all of which enumerate by `
      + `label\n`);
  }
  process.stderr.write(`\n${rows.length} row(s) carry no label at all. Add at least one -- \`backlog\` is `
    + `the safe default, and which is right is a human judgement -- so they become visible to every `
    + `check that reads this tracker.\n`);
  return rows.length;
}

/**
 * #449: A ROW THAT SHOULD BE `ready` AND IS NOT -- the population no existing check here can see, since
 * `mutexViolations` only ever compares labels the row DOES carry against each other, and an absent label
 * has nothing to conflict with. `WAS_READY_LABEL` is the marker that makes this population expressible:
 * a row carrying it while neither `ready` nor `in-progress` is exactly #171's shape -- claimed, then
 * correctly declined, and the restore that should have put `ready` back silently did not happen.
 *
 * `declineRow` is the ONLY writer of `WAS_READY_LABEL`, and it always removes it in the same edit that
 * restores `ready` (or, on a `--blocked` decline, in the same edit that adds `blocked` instead --
 * deliberately, since a blocked row is a genuine finding and must not ALSO read as stranded). So a row
 * matching this filter is either a live instance of the restore failing, or a hand-edited label; either
 * way, worth a look rather than a silent gap.
 *
 * @param {LabelledIssue[]} issues open issues
 * @returns {LabelledIssue[]}
 */
export function strandedByIncompleteDecline(issues) {
  return issues.filter((issue) =>
    issue.labels.includes(WAS_READY_LABEL)
    && !issue.labels.includes(READY_LABEL)
    && !issue.labels.includes("in-progress"));
}

/**
 * Report the CLOSED-row debris population #378 exists for -- a SEPARATE listing with separate wording, so
 * it is never read as a contradiction to resolve. Reports only; the tracker's labels are
 * `product-manager`'s to strip, deliberately.
 */
function reportClosedDebris() {
  const issues = fetchAllIssues();
  const debris = closedDebris(issues);
  if (debris.length === 0) {
    process.stdout.write(`OK  no closed issue carries \`ready\`, \`in-progress\` or a \`session:*\` label\n`);
    return 0;
  }
  for (const { number, title, debris: labels } of debris) {
    process.stdout.write(`DEBRIS  #${number} "${title}" -- closed, still carries ${labels.join(", ")}\n`);
  }
  const readyOnClosed = debris.filter((d) => d.debris.includes(READY_LABEL)).length;
  // #752: STATE-AWARE, NOT A SINGLE COMMAND FOR BOTH POPULATIONS -- `decline` needs `in-progress` (a
  // claim to release) and only then removes labels without adding `ready` back on a closed row
  // (row-claim.mjs's own fix for this exact incident: declining #721 while it was already closed had
  // restored `ready`, turning one debris finding into another). A row carrying ONLY `ready`, with no
  // claim for `decline` to act on, has nothing for it to do -- named separately so the remediation never
  // sends a reader to a command that will refuse.
  const claimedDebris = debris.filter((d) => d.debris.includes("in-progress"));
  process.stderr.write(`\n${debris.length} closed row(s) still carry a pickable/claimed label -- nobody `
    + `will act on these, but a Ready count taken by label rather than by state is wrong by `
    + `${readyOnClosed} because of them. Stale bookkeeping, not a contradiction: ${claimedDebris.length} `
    + `still carry \`in-progress\` and can be cleared with \`node packages/agent-org/src/row-claim.mjs decline <n> `
    + `--session=<whoever holds it>\` (safe here -- a closed row is never returned to \`ready\`); the `
    + `rest carry only \`ready\` or a stray \`session:\`/\`runner:\` label, which decline has no claim to `
    + `release and the tracker owner clears by hand.\n`);
  return debris.length;
}

/**
 * Report the #449 population: an open row a correct decline should have made `ready` again, and did not.
 */
function reportStrandedByIncompleteDecline() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  const stranded = strandedByIncompleteDecline(issues);
  if (stranded.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked, none are `
      + "stranded by an incomplete decline\n");
    return 0;
  }
  for (const { number, title } of stranded) {
    process.stdout.write(`STRANDED  #${number} "${title}" -- was ready before a claim, declined, `
      + `never restored to \`ready\`\n`);
  }
  process.stderr.write(`\n${stranded.length} row(s) were ready, got claimed and correctly declined, and `
    + "the restore did not happen -- invisible to the Ready queue. See #449.\n");
  return stranded.length;
}

/**
 * Report the off-the-board population #399 exists for -- a THIRD population, separate from both label
 * checks above, since neither a label comparison nor a Status comparison alone can see a row with no
 * Project item at all.
 *
 * #788: EVERY OPEN ROW, not just `ready` -- ceo's ruling, 2026-09-09. See `openRowsAbsentFromBoard`'s own
 * doc for the 24 rows the `ready`-only version could not see.
 */
function reportAbsentFromBoard() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  const items = fetchBoardItems();
  const boardNumbers = new Set(
    /** @type {number[]} */ (items.map((i) => i.number).filter((n) => n !== null)),
  );
  const missing = openRowsAbsentFromBoard(issues, boardNumbers);
  if (missing.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked, every one has `
      + `an item on Project ${PROJECT_NUMBER}\n`);
    return 0;
  }
  for (const { number, title } of missing) {
    process.stdout.write(`ABSENT  #${number} "${title}" -- open, and not on the board at all\n`);
  }
  process.stderr.write(`\n${missing.length} open row(s) have no Project item -- Project ${PROJECT_NUMBER} `
    + `is the view the chairman reads, and a row off it is invisible there.\n`);
  return missing.length;
}

/**
 * Report the `ready`-but-already-merged population #443 exists for -- a FOURTH population: the row
 * survives every earlier check (nobody holds it, no mutex label, it is on the board) and is still the
 * wrong thing to pick, because a merged PR already declares `Closes #N` on it.
 */

/**
 * The facts `claimsNobodyIsWorking` needs, read from the real repository.
 *
 * SEPARATED FROM THE DECISION so the decision can be driven by fixtures -- the live tracker is clean
 * most of the time, so a check exercised only against it is one that has never been seen to fire.
 *
 * @param {number[]} numbers
 * @param {{ run?: typeof defaultRun }} [deps]
 */
export function fetchClaimActivity(numbers, { run = defaultRun } = {}) {
  /** @type {Map<number, boolean>} */
  const hasOpenPr = new Map();
  /** @type {Map<number, number>} */
  const lastPushMinutes = new Map();
  /** @type {Map<number, number>} */
  const claimedMinutes = new Map();
  /** @type {Map<number, number>} */
  const lastCommentMinutes = new Map();
  if (numbers.length === 0) return { hasOpenPr, lastPushMinutes, claimedMinutes, lastCommentMinutes };

  // #1090: THE FOURTH HAND-SET CAP, and the row named three. It was `--limit 100` with NO truncation
  // guard -- so unlike the 500 below it would not have gone dark, it would have silently stopped seeing
  // open pull requests past the hundredth and reported every row behind them as having none in flight.
  // "This row has no open PR" is what `claimsNobodyIsWorking` acts on, so a quiet under-read here does
  // not refuse; it RELEASES a claim somebody is working. Same walk as the other three.
  /** @type {{number: number, body: string, headRefName: string}[]} */
  const prs = /** @type {any} */ (listUntilShort({ run, what: "open PRs",
    argv: (ask) => ["pr", "list", "--repo", REPO, "--state", "open", "--limit", String(ask),
      "--json", "number,body,headRefName"] }));
  for (const n of numbers) {
    // `Closes #N` in an OPEN PR is work in flight. Matching the row number anywhere in the body would
    // count a passing mention, which is the distinction #446 is about.
    if (prs.some((pr) => new RegExp(`[Cc]loses:?\\s+#${n}(?![0-9])`).test(pr.body ?? ""))) {
      hasOpenPr.set(n, true);
    }
  }

  for (const [n, minutes] of branchAges(numbers, run)) lastPushMinutes.set(n, minutes);
  // WHEN THE CLAIM WAS MADE, from the label event -- the only clock that separates "not started yet"
  // from "never started".
  for (const n of numbers) {
    try {
      const at = run("gh", ["api", `repos/${REPO}/issues/${n}/timeline`, "--paginate", "--jq",
        '[.[]|select(.event=="labeled" and .label.name=="in-progress")]|last|.created_at']).trim();
      if (at) claimedMinutes.set(n, Math.floor((Date.now() - Date.parse(at)) / 60000));
    } catch { /* a row whose timeline cannot be read is left absent, never assumed fresh */ }
  }
  // #723/#756: THE NEWEST COMMENT'S AGE. Comments come back oldest-first, so `last` is the newest --
  // `first` would answer "when was this row first discussed", which is a different question and would
  // make every long-lived row read as dead. See `claimsNobodyIsWorking` for why this counts ANY comment
  // rather than the claimant's: session authorship is not observable through GitHub here.
  for (const n of numbers) {
    try {
      const at = run("gh", ["api", `repos/${REPO}/issues/${n}/comments`, "--paginate", "--jq",
        "[.[].created_at]|last"]).trim();
      if (at) lastCommentMinutes.set(n, Math.floor((Date.now() - Date.parse(at)) / 60000));
    } catch { /* a row whose comments cannot be read is left absent, never assumed fresh */ }
  }
  return { hasOpenPr, lastPushMinutes, claimedMinutes, lastCommentMinutes };
}

/**
 * A branch whose name ends in the row number, newest first. ABSENT means no branch at all, and stays
 * absent rather than becoming a large age -- the caller must tell "not pushed yet" from "never existed".
 * @param {number[]} numbers
 * @param {typeof defaultRun} run
 * @returns {Map<number, number>}
 */
function branchAges(numbers, run) {
  /** @type {Map<number, number>} */
  const ages = new Map();
  const refs = run("git", ["for-each-ref", "--format=%(refname:short) %(committerdate:unix)",
    "refs/remotes/origin"]);
  const now = Math.floor(Date.now() / 1000);
  for (const line of refs.split("\n")) {
    const [name, when] = line.trim().split(/\s+/);
    if (!name || !when) continue;
    const m = /-(\d+)$/.exec(name);
    if (!m || !numbers.includes(Number(m[1]))) continue;
    const n = Number(m[1]);
    const minutes = Math.floor((now - Number(when)) / 60);
    const prev = ages.get(n);
    if (prev === undefined || minutes < prev) ages.set(n, minutes);
  }
  return ages;
}

/**
 * #755: the line names the criterion it applied (#723), the same way the clean-path `OK` line already
 * did -- so a reader who sees DEAD-CLAIM and later sees the row alive can tell "the rule changed" from
 * "the row changed" without going to read `claimsNobodyIsWorking` itself. Pulled out to a pure formatter
 * so the string is unit-testable without spawning `gh` the way `reportDeadClaims` itself would require.
 *
 * @param {{ number: number, title: string, sessions: string[], minutes: number | null }} claim
 */
export function formatDeadClaimLine({ number, title, sessions, minutes }) {
  const held = sessions.length > 0 ? sessions.join(", ") : "nobody (no session label)";
  const age = minutes === null ? "no branch at all" : `last push ${minutes} min ago`;
  return `DEAD-CLAIM  #${number} "${title}" -- held by ${held}, no open PR, ${age}, `
    + "no comment in the window -- none of `ceo`'s three legs (#723)\n";
}

/** Reports the claims nobody is working. Returns the count, so the caller decides severity. */
function reportDeadClaims() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  const claimed = issues.filter((i) => i.labels.includes("in-progress"));
  const stale = claimsNobodyIsWorking(claimed, fetchClaimActivity(claimed.map((i) => i.number)));
  if (stale.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked; every `
      + "`in-progress` row has an open PR, a push, or a comment in the last four hours -- the same "
      + "three legs as `ceo`'s release rule (#723)\n");
    return 0;
  }
  for (const claim of stale) {
    process.stdout.write(formatDeadClaimLine(claim));
  }
  process.stderr.write(`\n${stale.length} \`in-progress\` row(s) nobody is working. A claim with no `
    + "holder is invisible to everyone reading the board.\n");
  return stale.length;
}

function reportAlreadyMerged() {
  const { issues, reportedCount } = fetchOpenIssuesChecked();
  // EVERY ROW ADVERTISING A LIVE STATE, not just `ready`. This filtered on `ready` alone, so on
  // 2026-09-08 it reported OK while FIFTEEN `in-progress` rows were finished or dead -- eleven of them
  // closed by a merged PR that declared `Closes #N`. The check was right and its population was half the
  // question, which is the shape this file exists to catch, turned on the file itself.
  const liveRows = issues.filter((i) => livesStateLabels(i.labels));
  const numbers = liveRows.map((i) => i.number);
  const refsByIssue = fetchClosingPrRefs(numbers);
  const reopenByIssue = fetchLatestReopenedAt(numbers);
  const flagged = readyRowsAlreadyMerged(liveRows, refsByIssue, reopenByIssue);
  const alreadyMerged = flagged.filter((row) => row.state === "ALREADY-MERGED");
  const reopenedAfterMerge = flagged.filter((row) => row.state === "REOPENED-AFTER-MERGE");
  if (flagged.length === 0) {
    process.stdout.write(`OK  ${issues.length} of ${reportedCount} open issue(s) checked, no \`ready\` `
      + `or \`in-progress\` issue is already closed by a merged PR\n`);
    return 0;
  }
  for (const row of alreadyMerged) {
    process.stdout.write(`ALREADY-MERGED  #${row.number} "${row.title}" -- PR #${row.closedBy} merged and `
      + `declares \`Closes #${row.number}\`, but the row is still open and claims a live state\n`);
  }
  // #550: NOT counted toward the returned finding count -- this is not debris to close, it is a fix
  // someone deliberately put back after the merge that referenced it. "Nothing goes quiet" means it is
  // still printed on every run; it is just never the sentence that says a session should act on it.
  for (const row of reopenedAfterMerge) {
    process.stdout.write(`REOPENED-AFTER-MERGE  #${row.number} "${row.title}" -- PR #${row.closedBy} `
      + `merged ${row.mergedAt} and declared \`Closes #${row.number}\`, but the row was reopened `
      + `${row.reopenedAt}, AFTER that merge -- a refuted fix, not debris\n`);
  }
  if (alreadyMerged.length > 0) {
    process.stderr.write(`\n${alreadyMerged.length} open row(s) already shipped on main via a merged PR -- `
      + `picking one would mean discovering the fix already exists, and a claimed one is a session `
      + `credited with work that is done.\n`);
  }
  return alreadyMerged.length;
}

/**
 * Every check this audit performs, in the order it runs them. A LIST rather than six hand-written
 * `try` blocks, because those blocks each ended in `return` -- so ONE check that could not ask its
 * question silenced every check after it. Measured 2026-09-08: the board query needs a token that can
 * read Projects v2 and the workflow supplies `github.token`, which cannot, so three scheduled runs
 * reported nothing at all about closing PR references or dead claims -- questions that need no board
 * and would have answered fine.
 */

/**
 * Report #683's population: a CLOSED row whose claimant cannot be recovered.
 *
 * The label is gone by design -- `closedDebris` above fires on every closed row that still carries one --
 * but the EVENT that applied it is on the issue's own timeline forever, so a closed row still answers
 * "who worked this" and over what window. Measured 2026-09-09: 185 of 291 closed rows, and 77 of the 83
 * sitting behind a branch with no open PR.
 *
 * WHAT IS REPORTED IS THE GAP, NOT THE RECOVERY. Printing 185 provenance lines every run would bury the
 * six that need something done; the count of what WAS recovered is stated so a reader can tell an empty
 * finding list from an empty population, which is the same distinction `runCheck` draws one level up.
 *
 * A row here is UNATTRIBUTABLE, and that is a different sentence from "nobody claimed it" only because
 * the timeline was actually asked. Every one of the six is a hand claim (#673's shape) -- a row taken
 * with `gh issue edit` and no `session:` label, so there is no event to find and never was.
 */
function reportUnattributableClosedRows() {
  // THE FLOOR TRAVELS WITH THE QUESTION: the open rows' live `session:` labels are a population this
  // audit already reads, and every one of them must have the event that applied it. A short event log
  // would otherwise make this check's cleanest possible output -- "nothing unattributable" -- the thing
  // it prints when it read nothing at all.
  const rows = fetchClosedRowEvents({ openIssues: fetchOpenIssues() });
  const historical = unattributableClosedRows(rows);
  const gated = reportableUnattributable(rows, { since: PROVENANCE_REQUIRED_FROM });
  const notPlanned = unattributableClosedRows(rows, { since: PROVENANCE_REQUIRED_FROM }).length
    - gated.length;
  const recovered = rows.length - historical.length;
  process.stdout.write(`${rows.length} closed row(s) read; ${recovered} name their claimant and the `
    + `window from the timeline, label or no label. ${historical.length} carry no claim event at all -- `
    + `rows claimed by hand before #673 closed that route, where no record was ever written and none can `
    + `be recovered. ${notPlanned} row(s) closed NOT_PLANNED are not counted: they were never worked, so `
    + `"who worked this" has no answer and its absence is not a defect.\n`);
  return reportProvenanceOf(gated);
}

/** What each verdict prints as. Only `undeclared` is counted: see `attributionFor`. */
const PROVENANCE_MARK = { worker: "ATTRIBUTED", work: "WORK, NOT WORKER", undeclared: "NEEDS A PERSON" };

/**
 * Every reportable row with its verdict. PURE given `closingPrFor`, and exported so the finding count is
 * tested without the network -- the first version counted by `!attributed`, which put the middle verdict
 * in the finding, and nothing that ran it could see that.
 *
 * @param {ReturnType<typeof reportableUnattributable>} gated
 * @param {(number: number) => ReturnType<typeof fetchClosingPullRequest>} closingPrFor
 */
export function provenanceVerdicts(gated, closingPrFor) {
  return gated.map(({ number, title, closedAt }) => ({ number, title, closedAt, ...attributionFor(closingPrFor(number)) }));
}

/**
 * The rows the provenance check returns as its FINDING: `undeclared` only. Its own function so the count the
 * audit exits with is the one the test reads -- a test that recomputed it would pass whatever the audit did.
 *
 * @param {ReturnType<typeof provenanceVerdicts>} verdicts @returns {number[]}
 */
export function provenanceFindings(verdicts) {
  return verdicts.filter((v) => v.verdict === "undeclared").map((v) => v.number);
}

/**
 * The three verdicts, printed apart, because collapsing them is what made ten rows read as one
 * population on 2026-09-09: five had been closed by a merged pull request that declared them, and
 * calling those UNATTRIBUTABLE put work that shipped correctly beside a row whose history cannot be
 * reconstructed at all. Only `undeclared` is returned as a finding.
 *
 * @param {ReturnType<typeof reportableUnattributable>} gated
 * @returns {number}
 */
function reportProvenanceOf(gated) {
  const verdicts = provenanceVerdicts(gated, fetchClosingPullRequest);
  for (const { number, title, closedAt, verdict, line } of verdicts) {
    process.stdout.write(`${PROVENANCE_MARK[verdict]}  #${number} "${title}" -- closed ${closedAt}, ${line}\n`);
  }
  const undeclared = provenanceFindings(verdicts);
  if (undeclared.length === 0) {
    process.stdout.write(`OK  every row closed since ${PROVENANCE_REQUIRED_FROM} that was actually `
      + `worked names its claimant or the pull request that declared it\n`);
    return 0;
  }
  process.stderr.write(`\n${undeclared.length} row(s) closed since ${PROVENANCE_REQUIRED_FROM} cannot `
    + `name their worker: ${undeclared.map((n) => `#${n}`).join(", ")}. A branch name identifies the `
    + `WORK, never the worker -- have whoever pushed it re-run \`row-claim.mjs claim\`, so the next `
    + `audit reads what this one could not.\n`);
  return undeclared.length;
}

// #870: A ROW CAN READ `COMPLETED` WITH NOTHING BEHIND IT. #79 was closed 40 seconds after PR #89 --
// which declared `Closes #79` and never merged -- closed unmerged. `closedByPullRequestsReferences`
// (the ISSUE's own side, `fetchClosingPrRefs` above) CANNOT see this: measured directly, #79's own
// `closedByPullRequestsReferences` comes back EMPTY once #89 closed unmerged, and #159/#132 (legitimately
// closed by a DIFFERENT, later, merged PR) come back showing exactly that later PR -- GitHub's issue-side
// field silently drops a stale, never-merged closing reference and shows only a currently-valid one. So
// this reads the OTHER side -- `closingIssuesReferences`, queried FROM the closed-unmerged PR -- which
// still names #79 (confirmed directly: `pullRequest(number:89){closingIssuesReferences}` returns `[79]`,
// `merged: false`). Two GraphQL fields answering what sounds like the same question, disagreeing on
// exactly the case this row exists to catch, is the reason both are read here rather than one assumed to
// stand in for the other.
//
// THE FIELD NOT USED, deliberately: `merge_commit_sha`. It is populated on a closed, UNMERGED PR --
// GitHub computes a test-merge object -- and reads like proof of a merge in exactly the state where there
// is none. `merged`/`mergedAt` are the fields read here and by `fetchClosingPrRefs` above; neither call
// site in this file has ever reached for `merge_commit_sha`.

/**
 * @typedef {{ number: number, mergedAt: string | null }} ClosedPr
 * @typedef {{ number: number, title: string, closedAt: string, stateReason: string | null }} ClosedIssue
 */

/**
 * Every CLOSED PR that never merged -- `mergedAt`, never `merge_commit_sha`, which is populated on both
 * states and would make this list indistinguishable from "every closed PR".
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {ClosedPr[]}
 */
export function fetchClosedUnmergedPrs({ run = defaultRun } = {}) {
  const parsed = listUntilShort({ run, what: "closed PRs",
    argv: (ask) => ["pr", "list", "--repo", REPO, "--state", "closed", "--limit", String(ask),
      "--json", "number,mergedAt"] });
  return parsed
    .map((/** @type {any} */ p) => ({ number: p.number, mergedAt: p.mergedAt ?? null }))
    .filter((p) => p.mergedAt === null);
}

/**
 * The issues a closed, UNMERGED PR declares it would close, queried from the PR's OWN side --
 * `closingIssuesReferences`, never the issue-side `closedByPullRequestsReferences` this file's own
 * `fetchClosingPrRefs` reads for a DIFFERENT question (`readyRowsAlreadyMerged`'s "is a merge already
 * done"), which cannot see a reference from a PR that closed without merging.
 * @param {number[]} prNumbers
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {Map<number, number[]>} PR number -> the issue numbers it would have closed
 */
export function fetchClosingIssueRefs(prNumbers, { run = defaultRun } = {}) {
  /** @type {Map<number, number[]>} */
  const map = new Map();
  if (prNumbers.length === 0) return map;
  const [owner, name] = REPO.split("/");
  const fields = prNumbers.map((n, i) => `p${i}: pullRequest(number: ${n}) { number `
    + `closingIssuesReferences(first: 20) { nodes { number } } }`).join(" ");
  const query = `{ repository(owner: "${owner}", name: "${name}") { ${fields} } }`;
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`ready-label-audit: could not resolve closing issue references -- refusing to guess. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`ready-label-audit: gh's closing-issue-references response was not JSON -- refusing `
      + `to guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const repo = /** @type {any} */ (parsed)?.data?.repository;
  if (!repo || typeof repo !== "object") {
    throw new Error(`ready-label-audit: gh's closing-issue-references response had no repository -- `
      + `refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return closingIssueRefsFromRepoNode(repo, prNumbers);
}

/**
 * Reads each aliased `p<N>: pullRequest(...)` node's closing-issue list back out, keyed by the real PR
 * number rather than by alias -- split out of `fetchClosingIssueRefs` purely to keep that function's
 * complexity under gate, the same split `closingPrRefsFromRepoNode` already makes for `fetchClosingPrRefs`.
 * @param {Record<string, any>} repo
 * @param {number[]} prNumbers
 * @returns {Map<number, number[]>}
 */
function closingIssueRefsFromRepoNode(repo, prNumbers) {
  /** @type {Map<number, number[]>} */
  const map = new Map();
  for (let i = 0; i < prNumbers.length; i++) {
    const node = repo[`p${i}`];
    if (!node || typeof node.number !== "number") {
      throw new Error(`ready-label-audit: PR #${prNumbers[i]} is missing from the closing-issue-references `
        + `response -- refusing to guess. Got: ${JSON.stringify(node ?? null).slice(0, 300)}`);
    }
    const nodes = node.closingIssuesReferences?.nodes;
    const issues = Array.isArray(nodes)
      ? nodes.map((/** @type {any} */ r) => r.number).filter((n) => typeof n === "number")
      : [];
    map.set(node.number, issues);
  }
  return map;
}

/**
 * @typedef {{ number: number, title: string, closedAt: string, closedBy: number }} SoleUnmergedCloserRow
 */

/**
 * Pure: which CLOSED issues were declared closed by a PR that never merged, with no OTHER PR currently
 * recognised as closing them?
 *
 * `mergedRefsByIssue` (from `fetchClosingPrRefs`, the issue's own `closedByPullRequestsReferences`) is
 * the "no LATER MERGED PR references the row" half -- if GitHub still shows a merged closer for this
 * issue, the row is NOT a candidate, whether or not an earlier, abandoned PR also once claimed it (#159
 * and #132's real shape: their own field shows the PR that actually shipped the work, not the one this
 * audit's naive population would have quoted). An issue absent from `unmergedClosingRefsByPr`'s reversed
 * index -- no closed-unmerged PR ever named it at all -- is out of this check's population entirely; it
 * closed some other way and this check has nothing to say about it.
 *
 * `unmergedClosingRefsByPr` may name more than one PR per issue; "sole closing reference" means exactly
 * one closed-unmerged PR names it AND no merged PR does.
 *
 * @param {ClosedIssue[]} closedIssues
 * @param {Map<number, number[]>} unmergedClosingRefsByPr PR number -> issue numbers it would close
 * @param {Map<number, ClosingPrRef[]>} mergedRefsByIssue issue number -> PRs GitHub currently recognises
 *   as closing it (from `fetchClosingPrRefs`)
 * @returns {SoleUnmergedCloserRow[]}
 */
export function soleUnmergedCloserRows(closedIssues, unmergedClosingRefsByPr, mergedRefsByIssue) {
  /** @type {Map<number, number[]>} */
  const closersByIssue = new Map();
  for (const [pr, issues] of unmergedClosingRefsByPr) {
    for (const issue of issues) {
      const list = closersByIssue.get(issue) ?? [];
      list.push(pr);
      closersByIssue.set(issue, list);
    }
  }
  /** @type {SoleUnmergedCloserRow[]} */
  const flagged = [];
  for (const issue of closedIssues) {
    const closers = closersByIssue.get(issue.number);
    if (!closers || closers.length !== 1) continue; // not this population, or more than one claimant
    const hasMergedCloser = (mergedRefsByIssue.get(issue.number) ?? [])
      .some((ref) => ref.state === "MERGED" && ref.mergedAt);
    if (hasMergedCloser) continue; // GitHub still recognises a real closer; not a candidate
    flagged.push({ number: issue.number, title: issue.title, closedAt: issue.closedAt, closedBy: closers[0] });
  }
  return flagged;
}

function reportSoleUnmergedCloser() {
  const unmergedPrs = fetchClosedUnmergedPrs();
  const prNumbers = unmergedPrs.map((p) => p.number);
  const closingRefsByPr = fetchClosingIssueRefs(prNumbers);
  const referencedIssues = [...new Set([...closingRefsByPr.values()].flat())];
  if (referencedIssues.length === 0) {
    process.stdout.write(`OK  ${prNumbers.length} closed, unmerged PR(s) checked, none declares a `
      + `closing issue\n`);
    return 0;
  }
  const closedIssues = fetchClosedCompletedIssues().filter((i) => referencedIssues.includes(i.number));
  const mergedRefsByIssue = fetchClosingPrRefs(referencedIssues);
  const flagged = soleUnmergedCloserRows(closedIssues, closingRefsByPr, mergedRefsByIssue);
  if (flagged.length === 0) {
    process.stdout.write(`OK  ${referencedIssues.length} row(s) named by a closed-unmerged PR checked, `
      + `every one is also recognised as closed by a merged PR\n`);
    return 0;
  }
  for (const row of flagged) {
    // The report states the FACT ("closed by a PR that never merged"), never the conclusion ("not
    // done") -- the work may have shipped elsewhere, and twice in #870's own measured population it did.
    // REOPEN is the ruling this row asks for; the mutation itself is left to whoever runs `gh issue
    // reopen`, matching this whole file's own standing rule that it reports debris and does not act on
    // the tracker.
    process.stdout.write(`REOPEN  #${row.number} "${row.title}" was closed by PR #${row.closedBy}, which `
      + `never merged, and no other PR is currently recognised as closing it -- closed ${row.closedAt}. `
      + `The work may have shipped elsewhere; this check cannot see that, only that this closing reference `
      + `did not.\n`);
  }
  process.stderr.write(`\n${flagged.length} closed row(s) rest on a PR that never merged, with nothing `
    + `else currently closing them -- \`gh issue reopen\` is the ruling, run by a person: this audit `
    + `reports the debris, it does not act on the tracker.\n`);
  return flagged.length;
}

// #870's SECOND CHECK, `ceo`'s ruling: `criterion-coverage.ts` and a closed row can disagree about
// whether a criterion's rule exists, and unlike the check above, this one is unambiguous -- two files,
// no run history, no judgement about whether work shipped elsewhere under a different PR.
//
// `criterion-coverage.ts` is READ, never imported: it is TypeScript, this file runs under plain `node`,
// and the package publishes no subpath for it. The four status values are DEFINED on `CriterionCoverage`
// itself: `assessed` -- the shipped judge can return a finding; `partial` -- assessed, but a named
// failure mode is not covered (a claim that CODE EXISTS, same as `assessed`); `reachable` -- NOT assessed,
// and could be; `out-of-scope` -- never will be. Only `reachable` says no code exists at all, so only
// `reachable` disagrees with a row that closed COMPLETED -- `partial` is already the file's OWN answer to
// "how much was done", and collapsing it into `reachable` would be inventing a fifth state nobody declared.
const CRITERION_COVERAGE_PATH =
  fileURLToPath(new URL("../../judge/src/criterion-coverage.ts", import.meta.url));

/**
 * Pure: every `"N.N.N": { ... status: "word"` pair this file's own source declares, in source order.
 * Comments before `status:` are skipped (several entries carry a paragraph explaining the status before
 * the field itself), so this reads what a `tsc`-checked object literal actually assigns rather than the
 * first quoted word after the key.
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function criterionStatusesFromSource(source) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const pattern = /"(\d+\.\d+\.\d+)":\s*\{\s*(?:\/\/[^\n]*\n\s*)*status:\s*"(\w[\w-]*)"/g;
  for (const match of source.matchAll(pattern)) {
    map.set(match[1], match[2]);
  }
  return map;
}

/**
 * Which CLOSED issue, if any, this criterion's own tracker row is -- by the convention #79 itself
 * establishes: a row's TITLE begins with the criterion number it is about. Not a field GitHub has, so
 * this names it as a convention rather than a fact and returns `undefined` when no title matches --
 * "no row found" and "found and it agrees" must never read the same, which is why the caller reports the
 * first explicitly rather than treating it as silence.
 * @param {string} criterion
 * @param {ClosedIssue[]} closedIssues
 * @returns {ClosedIssue | undefined}
 */
export function criterionOwningRow(criterion, closedIssues) {
  const prefix = new RegExp(`^${criterion.replace(/\./g, "\\.")}(?:\\s|$)`);
  return closedIssues.find((i) => prefix.test(i.title));
}

/**
 * @typedef {{ criterion: string, status: string, row: ClosedIssue }} CoverageDisagreement
 */

/**
 * Pure: every `reachable` criterion whose owning row is closed `COMPLETED`.
 *
 * A FLOOR IS THE CALLER'S JOB, NOT THIS FUNCTION'S -- `reportCoverageTrackerDisagreement` asserts the
 * examined count itself, because a floor belongs beside the population it counts, not inside a function
 * that also has to stay pure and testable against a handful of synthetic statuses.
 * @param {Map<string, string>} statuses
 * @param {ClosedIssue[]} closedIssues
 * @returns {CoverageDisagreement[]}
 */
export function coverageTrackerDisagreements(statuses, closedIssues) {
  /** @type {CoverageDisagreement[]} */
  const disagreements = [];
  for (const [criterion, status] of statuses) {
    if (status !== "reachable") continue;
    const row = criterionOwningRow(criterion, closedIssues);
    if (!row || row.stateReason !== "COMPLETED") continue;
    disagreements.push({ criterion, status, row });
  }
  return disagreements;
}

/**
 * Pure: every `reachable` criterion for which NO closed row matches the title convention at all -- a
 * THIRD state, distinct from both "agrees" and "disagrees". `coverageTrackerDisagreements` above folds
 * "no row found" into "no disagreement" by construction (`if (!row ...) continue`), which is correct for
 * COUNTING findings but would silently hide the case from a reader if nothing else ever named it -- the
 * title convention is not a GitHub field, and a criterion nobody filed a row for at all is not evidence
 * of anything, but a reader should be told the check could not look rather than assume it looked and
 * found nothing.
 * @param {Map<string, string>} statuses
 * @param {ClosedIssue[]} closedIssues
 * @returns {string[]}
 */
export function reachableCriteriaWithoutRow(statuses, closedIssues) {
  const without = [];
  for (const [criterion, status] of statuses) {
    if (status !== "reachable") continue;
    if (!criterionOwningRow(criterion, closedIssues)) without.push(criterion);
  }
  return without;
}

/**
 * Every issue closed `COMPLETED` -- `stateReason`, never bare `state`, because a row closed
 * `NOT_PLANNED` is a decision this check has nothing to say about.
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {ClosedIssue[]}
 */
export function fetchClosedCompletedIssues({ run = defaultRun } = {}) {
  const parsed = listUntilShort({ run, what: "closed issues",
    argv: (ask) => ["issue", "list", "--repo", REPO, "--state", "closed", "--limit", String(ask),
      "--json", "number,title,closedAt,stateReason"] });
  return parsed.map((/** @type {any} */ i) =>
    ({ number: i.number, title: i.title, closedAt: i.closedAt, stateReason: i.stateReason ?? null }));
}

// A floor sized below today's count, so a new "reachable" criterion joining does not fail this check --
// the failure that matters is `criterionStatusesFromSource` matching NOTHING, which is how a scan that
// stopped recognising the file's own shape would still report a clean, empty disagreement list.
const MIN_CRITERIA_EXAMINED = 50;

function reportCoverageTrackerDisagreement() {
  const source = readFileSync(CRITERION_COVERAGE_PATH, "utf8");
  const statuses = criterionStatusesFromSource(source);
  if (statuses.size < MIN_CRITERIA_EXAMINED) {
    throw new Error(`ready-label-audit: only ${statuses.size} criteria found in ${CRITERION_COVERAGE_PATH} `
      + `-- refusing to report a clean disagreement list having barely read the file. Expected at least `
      + `${MIN_CRITERIA_EXAMINED}.`);
  }
  const closedIssues = fetchClosedCompletedIssues();
  const disagreements = coverageTrackerDisagreements(statuses, closedIssues);
  // A THIRD STATE, named rather than folded into "no disagreement" -- the title convention is not a
  // GitHub field, and a `reachable` criterion with no row matching it is a criterion this check could not
  // look up, never one it looked up and cleared.
  const noRow = reachableCriteriaWithoutRow(statuses, closedIssues);
  if (noRow.length > 0) {
    process.stdout.write(`NO ROW FOUND  ${noRow.join(", ")} read \`reachable\` and no closed-COMPLETED `
      + `row's title starts with the criterion number -- not evidence either way, just unexamined.\n`);
  }
  if (disagreements.length === 0) {
    process.stdout.write(`OK  ${statuses.size} criteria in criterion-coverage.ts examined, none reads `
      + `\`reachable\` while its own tracker row is closed COMPLETED\n`);
    return 0;
  }
  for (const { criterion, status, row } of disagreements) {
    process.stdout.write(`DISAGREEMENT  ${criterion} reads \`${status}\` in criterion-coverage.ts and `
      + `#${row.number} "${row.title}" is closed COMPLETED -- the two artefacts cannot both be right.\n`);
  }
  process.stderr.write(`\n${disagreements.length} criterion/row pair(s) disagree about whether the rule `
    + `exists -- criterion-coverage.ts is the artefact the rule's own code has to agree with, so it is `
    + `the one to trust; the row's closure is the one to fix.\n`);
  return disagreements.length;
}

/** @type {[string, () => number][]} */
/**
 * #1130: THE LABEL AND THE MILESTONE SAY THE SAME THING, AND NOTHING COMPARED THEM.
 *
 * `out-of-release` the LABEL and `Out of release` the MILESTONE (created 2026-09-12 on `ceo`'s ruling)
 * both mean "outside every release". `row-file` now gives the label path the milestone too, so FILING
 * can no longer produce a disagreement -- but **filing-time agreement does not survive a hand-edit**, and
 * a hand-edit is exactly how `ready` and Ready-Status drifted across 16 rows unseen.
 *
 * WHY HERE AND NOT IN `row-file.test.ts`, which is where #1130's acceptance put it. Two reasons, both
 * measured rather than argued:
 *
 *   - that file derives `[]` in #827's closure walk, and a live `gh issue list` would move it to
 *     `["token"]` -- disqualifying it from the job that runs acceptance commands, the exact trap #1116
 *     was filed about;
 *   - and a PR-path test asserting a TRACKER state fails the author of an unrelated PR the moment
 *     somebody hand-edits a row. That is a monitor wearing a test's name.
 *
 * This audit already runs nightly, already holds the token, and already reports rather than refuses --
 * which is what a drift between two hand-editable fields needs.
 *
 * PURE, with the two sets passed in, so the test drives it without reaching GitHub.
 *
 * @param {{number: number}[]} labelled  open rows carrying the label
 * @param {{number: number}[]} milestoned  open rows in the milestone
 * @returns {{ labelOnly: number[], milestoneOnly: number[] }}
 */
export function releaseDeclarationDrift(labelled, milestoned) {
  const inMilestone = new Set(milestoned.map((row) => row.number));
  const hasLabel = new Set(labelled.map((row) => row.number));
  return {
    labelOnly: labelled.map((r) => r.number).filter((n) => !inMilestone.has(n)).sort((a, b) => a - b),
    milestoneOnly: milestoned.map((r) => r.number).filter((n) => !hasLabel.has(n)).sort((a, b) => a - b),
  };
}

function reportReleaseDrift() {
  const run = defaultRun;
  // THROUGH THE WALK, never a hand-set --limit. #1090's own guard caught the first version of this line
  // carrying `--limit 500`, an hour after I removed the last four such caps from this file: a cap goes
  // stale silently the day the population passes it, and this population only grows.
  const list = (/** @type {string[]} */ args) => listUntilShort({ run, what: `out-of-release rows`,
    argv: (ask) => ["issue", "list", "--repo", REPO, "--state", "open", "--limit", String(ask),
      "--json", "number", ...args] });
  const rows = (/** @type {string[]} */ args) =>
    /** @type {{number: number}[]} */ (/** @type {unknown} */ (list(args)));
  const labelled = rows(["--label", OUT_OF_RELEASE_LABEL]);
  const milestoned = rows(["--milestone", OUT_OF_RELEASE_MILESTONE_NAME]);
  const { labelOnly, milestoneOnly } = releaseDeclarationDrift(labelled, milestoned);

  if (labelOnly.length === 0 && milestoneOnly.length === 0) {
    process.stdout.write(`OK  ${labelled.length} row(s) carry \`${OUT_OF_RELEASE_LABEL}\` and `
      + `${milestoned.length} are in "${OUT_OF_RELEASE_MILESTONE_NAME}" -- the same set\n`);
    return 0;
  }
  for (const n of labelOnly) {
    process.stdout.write(`RELEASE DRIFT  #${n} carries \`${OUT_OF_RELEASE_LABEL}\` and is NOT in the `
      + `"${OUT_OF_RELEASE_MILESTONE_NAME}" milestone -- invisible to every milestone view, which is the `
      + `state that milestone was created to end\n`);
  }
  for (const n of milestoneOnly) {
    process.stdout.write(`RELEASE DRIFT  #${n} is in "${OUT_OF_RELEASE_MILESTONE_NAME}" and does NOT `
      + `carry \`${OUT_OF_RELEASE_LABEL}\` -- invisible to \`board-data.mjs\`'s \`outOfRelease()\`, which `
      + `reads the label, so the board's out-of-release figure undercounts it\n`);
  }
  process.stderr.write(`\n${labelOnly.length + milestoneOnly.length} row(s) declare themselves out of `
    + `release by one of two fields and not the other. Two expressions of one state with nothing `
    + `comparing them is what let \`ready\` and Ready-Status drift across 16 rows unseen.\n`);
  return 1;
}

/** The milestone that says what the label says -- one name, read by the check above. */
const OUT_OF_RELEASE_MILESTONE_NAME = "Out of release";

/**
 * #1163: THE CLAIMS SENTENCE 2 IS MADE OF, MATCHED AGAINST BOTH COPIES rather than either spelled twice.
 *
 * `docs/row-filing.md` and the `Out of release` milestone's description both carry the rule that the label
 * answers one question and says nothing about importance. **Two copies of one rule with nothing comparing
 * them is the defect that produced five incidents in one day**, and a page stating that rule while being a
 * second unpinned copy of it would be refuting itself.
 *
 * MATCHED BY LOAD-BEARING PART, NEVER AS A FROZEN SENTENCE. The two texts already differ in ways that mean
 * nothing -- `ANSWERS ONE QUESTION ONLY` against `answers ONE question`, `'out of release, ready'` against
 * `"out of release, ready"` -- so a whole-sentence comparison would fail on a comma and teach the next
 * person to edit the check rather than the copy that drifted.
 */
/** @type {[string, RegExp][]} annotated for the reason the `CHECKS` annotation below states, one row down. */
const GUIDANCE_CLAIMS = [
  ["one question", /answers one question/i],
  ["the question itself", /does this block the 20 september publish/i],
  ["not unimportant", /does not mean unimportant/i],
  ["the spelling", /out of release, ready/i],
  ["where importance is said", /importance is said by the ready order/i],
];

/**
 * WHICH CLAIMS EACH COPY IS MISSING -- pure, so the live fetch is the caller's problem and this is testable
 * with the description injected.
 *
 * **THIS IS A DELETION DETECTOR, NOT A DRIFT DETECTOR, and the difference is not pedantic.** worker-capture
 * measured both columns on review, by this repo's own way of testing a text guard -- keep the text, change
 * the meaning -- and its mirror:
 *
 *   a rule DELETED from one copy      caught          <- the risk this exists for
 *   a rule REWORDED in one copy       false RED       <- reported as deleted
 *   a rule INVERTED in one copy       NOT caught      <- "it is false that ... does not mean unimportant"
 *                                                       keeps every phrase and passes clean
 *
 * A substring test can only behave this way; tightening the patterns worsens the reworded column and
 * loosening worsens the inverted one, and the only thing that fixes both is comparing meaning, which is not
 * available. **So the fix is the name rather than the regexes.** Called a drift detector, a reader trusts it
 * for the inversion case, which it cannot do at all.
 *
 * THE FALSE RED IS A REAL COST AND IT IS STATED RATHER THAN DISCOVERED: `findings > 0` sets
 * `process.exitCode = 1`, so an editorial pass on either copy reddens the nightly audit until someone
 * re-syncs the phrase. **A check that goes red for reasons nobody caused is how a check stops being read.**
 * The remedy when that happens is to re-sync the two copies, never to loosen a pattern -- the two saying it
 * the same way IS the property, since the row this came from is about two copies of one rule.
 *
 * `["the spelling", /out of release, ready/i]` IS THE LEAST FRAGILE OF THE FIVE AND ITS RED IS THE MOST
 * ACTIONABLE -- the opposite of what this comment said until worker-capture corrected their own objection
 * to it, and the reason is visible in the two copies:
 *
 *   docs/row-filing.md      ...is spelled "out of release, ready" -- importance is said by...
 *   milestone description   ...is spelled 'out of release, ready' -- importance is said by...
 *
 * **Both copies QUOTE it, and this pattern matches inside the quotes.** The two already disagree about the
 * quote character and the pattern is immune to that by construction. The other four match RUNNING PROSE,
 * which is exactly what an editorial pass rewrites; **a quoted string is the one thing a copy-editor leaves
 * alone, because the quotation marks say it is being exhibited rather than written.**
 *
 * So a red on this one is not expected wear: it means somebody edited the literal a filer is meant to type.
 * Act on it before any of the other four.
 *
 * `description` is `null` when the milestone could not be read. That is UNKNOWN and it is reported as
 * unreadable rather than as drift: a token without the scope, or a renamed milestone, must not read as "the
 * description dropped the rule", which is a different fault with a different fix.
 *
 * @param {string} doc `docs/row-filing.md`'s text
 * @param {string | null} description the `Out of release` milestone's description
 * @returns {{ readable: boolean, missingFromDoc: string[], missingFromMilestone: string[] }}
 */
export function guidanceDrift(doc, description) {
  // WHITESPACE COLLAPSED BEFORE MATCHING, and this check found that out by failing on its own doc. Markdown
  // wraps at 110 characters, so `does not mean\nunimportant` is one claim split across two lines and every
  // pattern spanning a wrap silently misses. The milestone description is a single unwrapped line, so the
  // two copies disagree about line breaks by construction and about nothing else.
  const flat = (/** @type {string} */ text) => text.replace(/\s+/g, " ");
  const missing = (/** @type {string} */ text) =>
    GUIDANCE_CLAIMS.filter(([, pattern]) => !pattern.test(flat(text))).map(([name]) => String(name));
  // ONE TEST FOR PRESENT, USED TWICE. The first version asked `trim() !== ""` for `readable` and only
  // `typeof === "string"` for the claims, so a description of `""` reported unreadable AND missing all five
  // -- "the milestone dropped every part of the rule" for a milestone nobody managed to read. `gh` spells
  // absent three ways and the empty string is the one `??` walks straight past.
  const present = typeof description === "string" && description.trim() !== "";
  return {
    readable: present,
    missingFromDoc: missing(doc),
    missingFromMilestone: present ? missing(String(description)) : [],
  };
}

const ROW_FILING_DOC = "docs/row-filing.md";

/** The live half: read both copies, compare them through `guidanceDrift`, print what drifted. */
function reportGuidanceDrift() {
  const doc = readFileSync(new URL(`../${ROW_FILING_DOC}`, import.meta.url), "utf8");
  let description = null;
  try {
    const milestones = JSON.parse(defaultRun("gh",
      ["api", `repos/${REPO}/milestones?state=all`, "--jq", "[.[]|{title,description}]"]));
    description = milestones.find((/** @type {{title: string}} */ m) => m.title === "Out of release")
      ?.description ?? null;
  } catch (cause) {
    void cause;
  }
  const drift = guidanceDrift(doc, description);
  if (!drift.readable) {
    process.stdout.write(`  the \`Out of release\` milestone description could not be read, so whether it `
      + `still carries ${ROW_FILING_DOC}'s rule is UNKNOWN -- not the same as agreeing with it\n`);
    return 1;
  }
  for (const [where, gone] of [[ROW_FILING_DOC, drift.missingFromDoc],
    ["the `Out of release` milestone description", drift.missingFromMilestone]]) {
    for (const claim of gone) {
      process.stdout.write(`  ${where} no longer states "${claim}" -- the other copy still does, so one of `
        + `them has drifted and ${ROW_FILING_DOC} is the one a filer reads\n`);
    }
  }
  return drift.missingFromDoc.length + drift.missingFromMilestone.length;
}

/**
 * @type {[string, () => number][]}  annotated rather than inferred: adding the twelfth entry
 * changed the inferred element type and the destructure at the call site stopped narrowing.
 */
export const CHECKS = [
  ["open issues", reportMutexViolations],
  ["hand claims", reportHandClaims],
  ["labelless rows", reportLabelless],
  ["declined rows", reportStrandedByIncompleteDecline],
  ["closed issues", reportClosedDebris],
  ["board membership", reportAbsentFromBoard],
  ["closing PR references", reportAlreadyMerged],
  ["claim activity", reportDeadClaims],
  ["closed-row provenance", reportUnattributableClosedRows],
  ["closing PR never merged", reportSoleUnmergedCloser],
  ["coverage vs tracker", reportCoverageTrackerDisagreement],
  ["release declaration", reportReleaseDrift],
  ["filing guidance", reportGuidanceDrift],
];

/**
 * #546: GitHub returns the IDENTICAL "could not resolve" wording for "this ProjectV2 does not exist" and
 * "this token has no permission to see it" -- Project 2 demonstrably exists (the same query succeeds
 * from a token that carries the scope), so a `runCheck` failure naming `ProjectV2` is, today, always the
 * one credential gap #546 records: `A11IGN_BOT_TOKEN` exists but was not granted `Projects: Read-only`.
 * Widening that scope is an account-owner action in GitHub's own UI -- no agent holds it and none can
 * take it, which is #546's own stated reason this sits with the chairman.
 *
 * A substring match, not a structured error code, because that is genuinely all GitHub gives back; if a
 * future failure mode ever reuses this exact wording for something ELSE, it will be misclassified as
 * this gap too -- an accepted cost, since the alternative (treating every board failure as equally
 * unexplained) is the state ceo's ruling exists to end.
 *
 * CASE-INSENSITIVE, AND THAT IS THE FIX -- #849 merged matching only `ProjectV2` (GraphQL's own TYPE
 * name) and missed the live failure the very next audit run hit: `FORBIDDEN (user.projectV2): Resource
 * not accessible by personal access token`, GitHub's FIELD PATH, lowercase `p`. Both spellings are real
 * -- measured live, `gh` returns the type name for a `Could not resolve to a ProjectV2` failure and the
 * field path for a `FORBIDDEN` one -- and #849's own test proved the predicate true on a message it
 * typed by hand rather than one GitHub actually sent, which is exactly how a case mismatch survives
 * review. NOT WIDENED FURTHER, e.g. to `FORBIDDEN` alone or paired with "personal access token": either
 * would also match a genuinely different permission failure this token could hit, and a predicate that
 * matches too much turns a real, unexplained refusal into a silent skip -- the failure in the other
 * direction, and the one this row must not trade for.
 *
 * A PREDICATE OVER A MESSAGE IS VERIFIED AGAINST A CAPTURED REAL MESSAGE, NEVER A WRITTEN ONE -- ceo's
 * own rule, stated here because this file is where the next version of this predicate will be edited.
 * `ready-label-audit.test.ts` fixtures the exact text from run 34386872582 (2026-09-09T18:05:19Z), not a
 * paraphrase, and asserts `runCheck`'s OUTCOME against it (`NOT RUN`, never `refused`), not merely that
 * this function returns `true`.
 * @param {string} message
 * @returns {boolean}
 */
export function isProjectsCredentialGap(message) {
  return /projectv2/i.test(message);
}

/**
 * Runs one check. A check that THREW could not ask its question, which is a different answer from
 * "asked and found nothing" -- so it is recorded as a refusal and never counted as a clean zero.
 *
 * ceo's ruling, 2026-09-09: a throw that is #546's one NAMED, ungrantable-by-any-agent credential gap is
 * recorded in `notRun`, never `refused` -- a job red on every commit for a capability the org cannot
 * grant trains everyone to ignore the job (#706's own lesson). Every OTHER throw is still a `refused`
 * refusal, unchanged: an unnamed, unexplained failure stays exactly as alarming as it always was. The
 * moment the credential exists, this same code path throws nothing and the check's real findings fail
 * the job again, unchanged.
 * @param {string} what @param {() => number} check @param {string[]} refused @param {string[]} [notRun]
 */
export function runCheck(what, check, refused, notRun = []) {
  try {
    return check();
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    if (isProjectsCredentialGap(message)) {
      process.stderr.write(`NOT RUN ${what}: ${message} -- a named credential is absent (#546); only a `
        + "human can widen it, so this is counted apart from a genuine refusal.\n");
      notRun.push(what);
      return 0;
    }
    process.stderr.write(`COULD NOT AUDIT ${what}: ${message}\n`);
    refused.push(what);
    return 0;
  }
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "ready-label-audit" });
  /** @type {string[]} */
  const refused = [];
  /** @type {string[]} */
  const notRun = [];
  let findings = 0;
  for (const [index, [what, check]] of CHECKS.entries()) {
    if (index > 0) process.stdout.write("\n");
    findings += runCheck(what, check, refused, notRun);
  }
  const partial = refused.length + notRun.length;
  if (partial > 0) {
    /** @type {string[]} */
    const clauses = [];
    if (notRun.length > 0) {
      clauses.push(`${notRun.length} could not run for #546's one named, ungrantable credential gap: `
        + `${notRun.join(", ")}`);
    }
    if (refused.length > 0) {
      clauses.push(`${refused.length} refused for an unexplained reason: ${refused.join(", ")}`);
    }
    process.stderr.write(`\n${partial} of ${CHECKS.length} check(s) did not answer -- ${clauses.join("; ")}. `
      + `The count above is a PARTIAL audit and must not be read as a clean one -- an unasked question `
      + "and a question answered `none` are different states.\n");
  }
  // ONLY an unexplained refusal fails the job (unchanged from before this ruling). #546's named gap is
  // still stated as partial above, but the other checks' own findings are what decide exit 0 vs 1 --
  // never a capability nobody here can grant.
  if (refused.length > 0) {
    process.exitCode = 2;
    return;
  }
  if (findings > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
