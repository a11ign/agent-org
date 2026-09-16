// @ts-check
// THE DATA LAYER BOTH BOARD OUTPUTS READ, and the only place that talks to GitHub or git.
//
// Extracted from `board-report.mjs` when the weekly board document was added, rather than letting the
// document grow its own copy of `mergeState`, `issues` and `reported`. A fact stated twice is this repo's
// most-repeated defect and the two copies would have drifted the first time a field moved -- the daily
// edition and the weekly PDF disagreeing about a merge count is exactly the failure the reports exist to
// prevent, arriving in the reports themselves.
//
// The rules below travel with the data and are not the caller's to relax.
//
// The rule this file exists to enforce, and the reason it is a script rather than a habit: a report
// assembled by hand from peer messages is a report of CLAIMS. This project's own record is a catalogue of
// correct values read from the wrong place — a journal window spanning two runs, a progress file
// describing a FINISHED run while a new one was a minute old, a commit message quoted while the artefact
// was on disk. Every one of those was true of something; none was true of the thing being reported.
//
// So: issues, the milestone and merges are READ, from GitHub and from git. A gate result and the
// fleet-hours total cannot be read from either, so they come from `docs/board/reported/`, where the
// agent that RAN the command records its verbatim output, who ran it and when. An entry that is absent or
// older than `staleAfterHours` is printed as "not reported since <date>" — never omitted, and never
// estimated. Where the report cannot verify something it says so; that is the whole design.
//
// It writes to stdout by default. `--post` publishes it as a comment on the board-report issue, so the
// generating and the publishing are separate acts and a bad report can be seen before it is posted.
import { execFileSync } from "node:child_process";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { changedFiles } from "../../guards/src/changed-files.mjs";
import { readFileSync, existsSync, readdirSync} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REPO } from "../../../scripts/repo-identity.mjs";
// A LEAF module with no imports of its own (#804), so this cannot form a cycle -- the same property that
// let `close-rows-for-merged-pr.mjs` import it under the no-`npm ci` constraint.
import { READY_LABEL } from "./claim-labels.mjs";
// The gate predicates live in `board-gates.mjs` (#429), a module with no process in it, so a test of the
// selection runs where a test of this file cannot. Re-exported: no importer of this file changes.
import { latestVerdictGate } from "./board-gates.mjs";
import { assertNoLeakInArgv } from "../../lab/src/packaging/leak-patterns.mjs";
export { gateVerdicts, isConformanceGate, latestVerdictGate, worstVerdict } from "./board-gates.mjs";

// RE-EXPORTED, not restated -- issue #92. Five other modules import `REPO` from here, so it stays exported
// at this path; `repo-identity.mjs` is the single declared value now, and this is one of its callers.
export { REPO };
export const MILESTONE = "v0.1.0 — first publish";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const HOURS_MS = 3600_000;
export const MINUTE_MS = 60_000;
export const MEDIAN = 0.5;
export const P90 = 0.9;

/** THE FILES THE REPORT READS OUT OF THE WORKING TREE, and the only dirt that can change an edition.
 *
 * Deliberately NOT "refuse if `git status` is non-empty". This is a shared checkout with several agents
 * working in it at once, so a guard that fires on somebody else's unrelated edit is one people disable
 * within a day — the same reason `promote:model` checks its TARGET paths rather than the whole tree.
 * Everything else the report reads is a ref (`git log main`, `origin/main..main`) or the GitHub API, and
 * neither is affected by an uncommitted file.
 *
 * The check is against `main`, not merely against HEAD, because the scheduled job runs from whatever
 * branch this checkout happens to be sitting on. A peer's branch is not dirty and would still supply a
 * `reported.json` nobody reviewed. "Uncommitted" and "committed on another branch" are different states
 * and both change what gets published, so both refuse.
 */
export const READ_SET = ["docs/board/reported", "packages/agent-org/src/board-report.mjs"];

// EVERY SPAWN SCRUBS `GIT_*`, and this file is the one where getting it wrong is worst.
//
// git exports `GIT_DIR`/`GIT_WORK_TREE` into any hook environment, and a spawned git with an inherited
// env obeys `GIT_DIR` over `cwd` -- that is not a hypothetical, it redirected fifteen real commits in this
// repo on 2026-09-06. The board report READS LOCAL BRANCHES AND THE PUSH STATE; those are the two lines it
// exists to produce, and the two nothing else can check. Under a leaked `GIT_DIR` it would report a merge
// count and a push state from a different repository entirely, confidently and with a source line
// attached. A report that is wrong about which repository it read is worse than no report.
//
// `gh` is scrubbed too. Every call here passes `--repo` explicitly so it does not resolve from git
// remotes, but `gh` shells git internally and the scrub costs nothing -- the defence should not depend on
// knowing which subprocess reads which variable.
/** @param {string[]} args */
export function gh(args) {
  // #1053: the leak check lives in the SPAWN HELPER, so every consumer of this `gh` is covered and so is
  // every call somebody adds to one tomorrow. Four of the eight writers #1053 names reach GitHub through
  // this one function.
  assertNoLeakInArgv("gh", args);
  return execFileSync("gh", args,
    { encoding: "utf8", cwd: ROOT, env: sandboxGitEnv(), maxBuffer: 32 * 1024 * 1024 });
}
/** @param {string[]} args */
export function git(args) {
  return execFileSync("git", args,
    { encoding: "utf8", cwd: ROOT, env: sandboxGitEnv(), maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** Merges are read from git, and the PUSH STATE is read with them.
 *
 * Reporting merges from GitHub alone would have been wrong on the first day this ran: pushes were held
 * while a git-identity defect was fixed, so `origin/main` sat still while real work merged locally. A
 * report saying "0 merges" would have been a correct reading of the wrong ref. So the count comes from
 * local `main` and the divergence is stated rather than hidden — a flat origin/main is a hold, not a stall,
 * and the two look identical from GitHub.
 * @param {string} since
 */
export function mergeState(since) {
  const log = git(["log", "main", "--merges", `--since=${since}`, "--format=%h\t%aI\t%s"]);
  const merges = log ? log.split("\n").map((/** @type {string} */ l) => {
    const [sha, at, ...rest] = l.split("\t");
    return { sha, at, subject: rest.join("\t") };
  }) : [];
  let unpushed;
  try {
    unpushed = Number(git(["rev-list", "--count", "origin/main..main"]));
  } catch {
    // No origin/main to compare against (a fresh clone, a detached mirror). Reported as unknown rather
    // than as zero: "nothing is waiting to push" and "we could not ask" must never be the same line.
    unpushed = null;
  }
  return { merges, unpushed };
}

/** Commits whose author is not the repository owner — a KNOWN DEFECT, printed so the board reads it as
 * one rather than discovering it. Issue #7 carries the cause and the decision (history stays).
 * @param {string} since */
export function misAuthored(since) {
  const log = git(["log", "main", `--since=${since}`, "--format=%h\t%ae"]);
  if (!log) return [];
  return log.split("\n").map((l) => l.split("\t"))
    .filter(([, email]) => !email.endsWith("@users.noreply.github.com") && email !== "")
    .map(([sha, email]) => ({ sha, email }));
}

export function issues() {
  const fields = "number,title,state,labels,closedAt,milestone,url";
  // AND IT REFUSES A LISTING THAT MAY BE TRUNCATED, rather than reporting on part of the tracker.
  //
  // This read `--limit 200`. On 2026-09-08 the repository passed 200 issues, and #31 -- open, fine, and
  // cited by a section-three achievement -- fell outside the window. The freshness guard did exactly the
  // right thing with that ("whether it is still open COULD NOT BE ASKED; do not assume") and REFUSED the
  // edition. So a bound nobody had revisited became, silently and on a Tuesday, the thing that stopped
  // the board getting a document.
  //
  // A HIGHER NUMBER ALONE JUST MOVES THE CLIFF. `gh issue list --limit N` returns AT MOST N and says
  // nothing about what it dropped, so `length === limit` is indistinguishable from "there were exactly
  // N" -- the bounded-listing defect this repository has now met in `branches:stranded` (#321), in
  // `ready-label-audit` (#378) and here. The limit is raised AND the ambiguous case is refused, because
  // the refusal is the part that cannot rot.
  const LIMIT = 1000;
  const all = JSON.parse(gh(["issue", "list", "--repo", REPO, "--state", "all",
    "--limit", String(LIMIT), "--json", fields]));
  if (all.length >= LIMIT) {
    throw new Error(`board-data: the issue listing returned ${all.length} rows against a limit of `
      + `${LIMIT}, so it MAY BE TRUNCATED and this document would report on part of the tracker. `
      + "Raise the limit or page the query -- do not read a partial listing as the whole.");
  }
  return all.map((/** @type {any} */ i) => ({ ...i, labelNames: i.labels.map((/** @type {any} */ l) => l.name) }));
}

/** A row that is not work: a container, or a process row. NOT counted, and the document says so.
 *
 * `#20` is the whole reason this exists. It is the daily board report itself -- its comments ARE the
 * editions -- so it is an open issue that will never close and can never be worked. Counted, it inflates
 * "road to version one" by one for ever and the number quietly stops meaning what a reader thinks.
 *
 * EXCLUDED BY RULE AND THE RULE IS PRINTED, which is the whole point: a count that silently drops rows is
 * worse than one that counts the wrong thing, because nobody can tell. Section 6 states the exclusion
 * beside the figure.
 */
export const META_LABEL = "meta";

/** Real work, deliberately not in this release. Carried INSTEAD of a milestone, never alongside one.
 *
 * THE RULE IS: every open row carries a milestone or this label, and there is no third state. A row with
 * neither is a tracker defect rather than a judgement call, and `unclassified()` below is what makes that
 * checkable instead of a thing somebody notices.
 *
 * It exists because two counts on one page disagreed about one row. #290 -- `git stash` is repo-global
 * across worktrees -- is real work that is not in the release, so the open-items total counted it and the
 * blocker count could not. Neither number was wrong; the page had no way to say why they differed. The
 * footnote beside the total now names how many rows are in this state, so the two reconcile BY
 * CONSTRUCTION rather than by a reader working it out. Ruled by `ceo` 2026-09-07; see issue #290.
 */
export const OUT_OF_RELEASE_LABEL = "out-of-release";

/** @param {any[]} list */
export function outOfRelease(list) {
  return list.filter((/** @type {any} */ i) => labelsOf(i).includes(OUT_OF_RELEASE_LABEL));
}

/** Open rows carrying NEITHER a milestone nor `out-of-release` -- the state the rule forbids.
 *
 * Reported rather than absorbed. A row here is counted in the total and invisible to every milestone
 * figure, which is exactly the disagreement this pair of functions exists to end -- so silently tolerating
 * it would rebuild the fault inside the fix.
 * @param {any[]} list
 */
export function unclassified(list) {
  return list.filter((/** @type {any} */ i) => !i.milestone && !labelsOf(i).includes(OUT_OF_RELEASE_LABEL));
}

/** @param {any} i */
function labelsOf(i) {
  return i.labelNames ?? i.labels?.map((/** @type {any} */ l) => l.name) ?? [];
}

/**
 * The rows that are PICKABLE -- `ready` and nothing has claimed them yet.
 *
 * ONE DERIVATION, because there were about to be two. `board-report.mjs` carried
 * `open.filter(i => i.labelNames.includes("ready"))` inline, and #912's work-gate needs the identical
 * question to decide whether an idle engineer has anything to be woken FOR. A second copy would be the
 * fact-stated-twice shape this file's own header names as the repo's most-repeated defect -- and worse
 * than usual here, because the two readers would disagree about whether the org has work while each
 * reported confidently.
 *
 * THE LITERAL COMES FROM `claim-labels.mjs`, never from here. That leaf module exists (#804) precisely
 * because `"ready"` had been spelled in three files; the inline copy in `board-report.mjs` was a fourth
 * that predated it. Importing the constant means this follows a rename by construction.
 *
 * `labelsOf` rather than `i.labelNames` directly: the inline version threw on any payload carrying
 * `labels[].name` instead, which is the shape `issues()` returns from a different query.
 * @param {any[]} list
 */
export function readyRows(list) {
  return list.filter((i) => labelsOf(i).includes(READY_LABEL));
}

/** The rows the document COUNTS. `issues()` stays complete -- a meta row still needs its state resolved.
 * @param {any[]} list */
export function countable(list) {
  return list.filter((i) => !(i.labelNames ?? i.labels?.map((/** @type {any} */ l) => l.name) ?? []).includes(META_LABEL));
}

export function milestone() {
  const all = JSON.parse(gh(["api", `repos/${REPO}/milestones?state=all`]));
  return all.find((/** @type {any} */ m) => m.title === MILESTONE) ?? null;
}

/** The two numbers this report cannot compute, and how it refuses to invent them. */
/** The recorded numbers, ONE FILE PER ENTRY (#159).
 *
 * It was a single JSON file that several agents record into, so two recorders appending two entries that
 * do not disagree about anything still produced a textual conflict -- JSON is line-oriented to git and
 * semantic to a reader. `git log` on it showed six different subjects moving the same 14,924 bytes, and
 * hand-resolving a conflict there risks precisely what the file exists to prevent: a number surviving
 * into the board document from a run nobody can name.
 *
 * NAMED BY THE ENTRY'S OWN IDENTITY, NEVER BY POSITION -- `ARRAY_IDENTITY` in board-summary-check.mjs
 * already keys gates on `command` and achievements on `issue`, and this follows it rather than inventing
 * a second scheme. Position-keyed names are the defect `withRealisticScale` paid for: inserting one entry
 * re-labels every entry after it.
 */
const REPORTED_DIR = "docs/board/reported";

/** WHICH SUBDIRECTORIES HOLD ENTRIES — declared ONCE and exported.
 *
 * `board-summary-check` built the same list inline, so adding a third kind meant remembering two places
 * and the second would be forgotten silently. Found in review of #159; it is the fact-stated-twice shape
 * that this very migration's commit message cites, reintroduced by the migration itself.
 */
export const REPORTED_KINDS = ["gates", "achievements"];

/** @param {string} kind */
function readEntries(kind) {
  const dir = path.join(ROOT, REPORTED_DIR, kind);
  if (!existsSync(dir)) return [];
  // ORDERED BY AN EXPLICIT SPARSE KEY, never by filename and never by date. The authored order is not
  // chronological -- checked, not assumed -- and the document renders in it, so filename order silently
  // reordered what the board reads. `order` is spaced by tens: inserting between two entries picks a
  // value between them and re-labels nothing, which is the property this whole change is for.
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, body: JSON.parse(readFileSync(path.join(dir, f), "utf8")) }));
  return entries
    .sort((a, b) => (a.body.order ?? Infinity) - (b.body.order ?? Infinity)
      || a.file.localeCompare(b.file))
    .map((e) => e.body);
}


export function reported() {
  const metaPath = path.join(ROOT, REPORTED_DIR, "meta.json");
  // DERIVED FROM `REPORTED_KINDS`, not repeated. This line read `gates: readEntries("gates"),
  // achievements: readEntries("achievements")` until 2026-09-07 -- so the constant governed one call site
  // and this one restated it, which is the fact-stated-twice shape the constant was introduced to remove.
  // Caught by mutation: shrinking `REPORTED_KINDS` changed nothing here, because nothing here read it.
  const raw = { ...(existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {}),
    ...Object.fromEntries(REPORTED_KINDS.map((kind) => [kind, readEntries(kind)])) };
  const staleMs = (raw.staleAfterHours ?? 24) * HOURS_MS;
  /** @param {any} entry */
  const fresh = (entry) => Date.now() - Date.parse(entry.at) < staleMs;
  const gates = (raw.gates ?? []).filter((/** @type {any} */ g) => g.at && Number.isFinite(Date.parse(g.at)));
  // #429: THE VERDICT SLOT, not the newest of any kind -- see `latestVerdictGate`'s own header.
  const latest = latestVerdictGate(gates);
  // EVERY GATE, not just the newest. Section five recommended "buying nothing yet" while the record held
  // the measurement that answered it, because the document could not SEE any gate but the latest -- so
  // the prose was hand-written and went stale the moment the re-run landed. A section that states a
  // figure is absent while `reported.json` carries it is the failure this file exists to prevent.
  return { latestGate: latest, gateIsFresh: latest ? fresh(latest) : false, fleetHours: raw.fleetHours,
    gates, achievements: raw.achievements ?? [] };
}


/**
 * The capture age a real-page gate printed, pulled from its own verbatim output rather than retyped by a
 * human -- issue #128. `rules:real-pages` computes and prints this line itself
 * (`*** 298 hour(s) between the oldest and newest, so this compares a MIXED population against one
 * baseline`); the defect was that everything downstream of the recorded entry re-typed a bare figure and
 * dropped it. The board document quotes a gate's output verbatim already, so once the recording keeps the
 * line this needs only to find it, never to compute it -- a second computation of the same spread is
 * exactly the fact-stated-twice shape this file's own header warns about.
 *
 * @param {string | undefined} gateOutput
 * @returns {string | null} the gate's own spread sentence, or null when it printed none (not a real-page
 *   result, or an older recording taken before the gate stated its spread)
 */
export function realPageCaptureAge(gateOutput) {
  if (!gateOutput) return null;
  const spread = gateOutput.match(/\*{0,3}\s*\d+\s*hour\(s\)\s*between the oldest and newest[^\n]*/i);
  if (spread) return spread[0].replace(/^\*+\s*/, "").trim();
  // A PARSER THAT ONLY READS THE WARNING GOES SILENT ON THE GOOD NEWS.
  //
  // The gate prints `*** N hour(s) between the oldest and newest` only when the spread is WIDE enough to
  // warn about. So on 2026-09-07, when #82's refresh took it from 304 hours to about one, this returned
  // null and the row simply stopped mentioning the spread -- which a reader compares against yesterday's
  // "304 hours, a MIXED population" and reads as the figure being WITHDRAWN rather than the problem being
  // fixed. The single most important improvement in the run would have been invisible for being good.
  //
  // So fall back to the timestamps the gate prints EVERY time, and say which of the two it is. This is
  // derived from the gate's own output rather than retyped from a message, and the distinction is stated
  // on the page rather than left for a reader to assume.
  return computedCaptureSpread(gateOutput);
}

/** The spread computed from the per-role capture ranges the gate always prints, or null if it printed none.
 * @param {string | undefined} gateOutput */
function computedCaptureSpread(gateOutput) {
  const stamps = [...String(gateOutput).matchAll(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g)].map((m) => Date.parse(m[1]));
  const usable = stamps.filter((t) => Number.isFinite(t));
  if (usable.length < 2) return null;
  const ms = Math.max(...usable) - Math.min(...usable);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return `${hours} hour(s) ${minutes} minute(s) between the oldest and newest capture, computed from the `
    + "timestamps the gate printed — it states a spread itself only when wide enough to warn about";
}

/**
 * HAS THE WORLD MOVED UNDER AN AUTHORED ACHIEVEMENT? — the one section of the board document no gate
 * computes, and therefore the one nothing ever re-checks.
 *
 * Section 3 is authored on purpose: what the product can now DO is not derivable from an API. The cost is
 * that an entry is true when written and nothing asks again. Measured 2026-09-06 (#90), entry [2] read
 * *"a rule that had never been demonstrated on a real page now has a page to demonstrate it on — written,
 * not yet captured"*. Every clause was true when written; by the time it would have reached the board
 * three were false, including a citation of an issue that had been closed as superseded. **It was caught
 * by a person happening to re-read it. Nothing in the pipeline could have.**
 *
 * THIS DOES NOT JUDGE THE CLAIM, which is unanswerable. It asks the cheap question the data already
 * supports: the entry cites an issue and carries a timestamp, so *did the world move under this
 * sentence?* A machine can ask GitHub whether that issue is still open without understanding a word.
 *
 * A CLOSED ISSUE IS NOT THE FINDING, and the first version of this got that wrong. An achievement is by
 * definition something FINISHED, so the issue that tracked it closes — refusing every entry citing a
 * closed issue means the board can only ever be told about UNFINISHED work, and each entry decays into
 * unrenderable the moment its own row closes. `product-manager` caught it: the implementation took the
 * row's wording more literally than it meant.
 *
 * **What the row asks is weaker and sufficient: the world moved under this sentence, so somebody look.**
 * The satisfying act is RE-AFFIRMATION, not a live reference, and `at` is what records it. So:
 *
 *   closed reference + `at` LATER than the closure   -> a good entry: somebody looked after it moved
 *   closed reference + `at` OLDER than the closure   -> the one to refuse: nobody has looked since
 *
 * A strictly smaller population than "cites a closed issue", and the one the row was written about.
 *
 * `affirmed` remains the explicit escape, and it is a field rather than a flag: it carries WHY the claim
 * still stands. A bare boolean would let the guard be cleared by a keystroke with no thought, which is
 * how a refusal becomes a formality — the reason every EXEMPT table here demands a reason, not a name.
 *
 * @param {{achievements: any[], issueState: Record<string, {state: string, closedAt?: string|null}>,
 *          now?: number, staleAfterHours?: number}} input
 * @returns {{index: number, claim: string, why: string}[]}
 */
export function achievementsWhoseWorldMoved({ achievements, issueState, now = Date.now(),
  staleAfterHours = 24 }) {
  /** @type {{index: number, claim: string, why: string}[]} */
  const findings = [];
  achievements.forEach((entry, index) => {
    const claim = String(entry.boardClaim ?? entry.claim ?? "(no claim text)").slice(0, 90);
    const affirmed = typeof entry.affirmed === "string" && entry.affirmed.trim().length > 20;
    const state = issueState[String(entry.issue)];
    // UNKNOWN IS NOT OPEN. An issue the listing did not carry is a question that could not be asked --
    // reporting it as fine is the "unchecked is not clean" defect, and reporting it as CLOSED would
    // refuse an edition over a paging limit. It gets its own sentence.
    if (entry.issue !== undefined && state === undefined) {
      findings.push({ index, claim,
        why: `cites issue #${entry.issue}, which the issue listing did not carry -- so whether it is `
          + "still open COULD NOT BE ASKED. Widen the listing or check by hand; do not assume." });
    } else if (state?.state === "CLOSED" && !affirmed
      && Date.parse(entry.at) < Date.parse(state.closedAt ?? "")) {
      findings.push({ index, claim,
        why: `cites issue #${entry.issue}, which closed at ${state.closedAt} -- AFTER this entry was last `
          + `affirmed (${entry.at}). The claim may still be true, and a closed issue is the normal end of `
          + "a finished achievement: this does not judge either. What it says is that the world moved "
          + "under the sentence and nobody has looked since. Re-affirm it by updating `at`, or add an "
          + "`affirmed` field saying why it still stands, or retire the entry." });
    }
    const ageHours = (now - Date.parse(entry.at)) / HOURS_MS;
    if (Number.isFinite(ageHours) && ageHours > staleAfterHours && !affirmed) {
      findings.push({ index, claim,
        why: `was reported ${ageHours.toFixed(0)}h ago, past the ${staleAfterHours}h freshness this file `
          + "already declares for a gate result. Same rule, same reason: a number nobody has re-read is "
          + "not a current one." });
    }
  });
  return findings;
}

/** @param {string} iso */
export function daysUntil(iso) {
  return Math.ceil((Date.parse(iso) - Date.now()) / (24 * HOURS_MS));
}

// #466 (C5): CONFLICT METRICS, READ FROM THE REPOSITORY -- PRs opened/merged/closed over a stated window,
// lifetime to merge, a conflict signal, and the five most-touched files. Filed after #468 proved the
// closing pipeline works and ceo's own done-when criteria (p90 under an hour, no PR over four hours, no
// file touched by more than five PRs, zero conflicts, trunk green on every merge) needed a number nobody
// asserts by hand -- "until C5 exists, nobody can say whether the conflict fix worked except by a session
// asserting it, which is the thing the whole plan is trying to stop."
//
// EVERY FIGURE STATES ITS WINDOW, because two correct counts over different windows already read as a
// disagreement once (`whatMerged`'s own 17-vs-42 lesson, above). `since` travels with every function's
// return value rather than living only in the caller's variable name.
//
// A COUNT NOBODY CAN RECOMPUTE IS AN OPINION -- `conflictMetrics`'s own `method` field states the search
// qualifiers and the git commands used, the same way `fleet-hours`'s own `method` field does, so a board
// record copies it rather than retyping it.

/** Bounded PR-listing refusal, on `issues()`'s own rule: a length at the limit MAY be truncated, and
 * reading a partial listing as the whole window is worse than refusing.
 */
export const PR_SEARCH_LIMIT = 500;

/**
 * @param {"created" | "merged" | "closed"} qualifier
 * @param {string} since ISO date/time, used verbatim as a GitHub search qualifier value
 * @param {((args: string[]) => string) | undefined} run the `gh` call, REQUIRED (#1407): `conflictMetrics` hands in
 *   the live one, a test hands in recorded listings. A defaulted one is a live `gh pr list` from a test suite.
 * @returns {any[]}
 */
function prsBy(qualifier, since, run) {
  if (typeof run !== "function") {
    throw new Error(`board-data: prsBy("${qualifier}") needs a run -- it is required, because a defaulted one is `
      + "a live `gh pr list` (#1407: conflict-metrics.test.ts reached it on every local run).");
  }
  const fields = "number,title,createdAt,mergedAt,closedAt,mergeCommit,files";
  const search = `${qualifier}:>=${since}`;
  const all = JSON.parse(run(["pr", "list", "--repo", REPO, "--state", "all", "--search", search,
    "--limit", String(PR_SEARCH_LIMIT), "--json", fields]));
  if (all.length >= PR_SEARCH_LIMIT) {
    throw new Error(`board-data: the PR search "${search}" returned ${all.length} rows against a limit of `
      + `${PR_SEARCH_LIMIT}, so it MAY BE TRUNCATED and this report would count part of the window as the `
      + "whole. Narrow the window or raise the limit -- do not read a partial listing as complete.");
  }
  return all;
}

/** PRs OPENED in the window, by `createdAt`. @param {string} since @param {{run?: (args: string[]) => string}} [deps] */
export function prsOpened(since, { run } = {}) { return prsBy("created", since, run); }

/** PRs MERGED in the window, by `mergedAt`. @param {string} since @param {{run?: (args: string[]) => string}} [deps] */
export function prsMerged(since, { run } = {}) { return prsBy("merged", since, run); }

/** PRs CLOSED WITHOUT MERGING in the window -- `closed:>=` also returns merged PRs (GitHub sets
 * `closedAt` on a merge too), so this filters to the ones a merge date does not explain.
 * @param {string} since
 * @param {{run?: (args: string[]) => string}} [deps]
 */
export function prsClosedUnmerged(since, { run } = {}) {
  return prsBy("closed", since, run).filter((/** @type {any} */ pr) => !pr.mergedAt);
}

/**
 * @param {number[]} sortedAscending
 * @param {number} p 0..1
 * @returns {number | null}
 */
function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(p * sortedAscending.length) - 1));
  return sortedAscending[index];
}

/** Minutes from open to merge, one per PR that carries both timestamps, ascending.
 * @param {any[]} mergedPRs
 */
export function mergeLifetimeMinutes(mergedPRs) {
  return mergedPRs
    .filter((pr) => pr.createdAt && pr.mergedAt)
    .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / MINUTE_MS)
    .sort((a, b) => a - b);
}

/** The five (or `limit`) files touched by the most DISTINCT PRs -- a PR touching a file five times still
 * counts once, because the hazard this measures is "how many authors converged on this file", not how
 * much it changed.
 * @param {any[]} prs
 * @param {number} [limit]
 */
export function hotspotFiles(prs, limit = 5) {
  /** @type {Map<string, Set<number>>} */
  const touchedBy = new Map();
  for (const pr of prs) {
    for (const file of pr.files ?? []) {
      const set = touchedBy.get(file.path) ?? new Set();
      set.add(pr.number);
      touchedBy.set(file.path, set);
    }
  }
  return [...touchedBy.entries()]
    .map(([path, prNumbers]) => ({ path, prCount: prNumbers.size }))
    .sort((a, b) => b.prCount - a.prCount || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * Did a merged PR's OWN branch history contain a merge commit bringing `main` in before it finished --
 * the one signal git retains after the fact for "this branch needed to reconcile with a diverged main".
 *
 * A PROXY, NAMED AS ONE, NOT PROOF OF A TEXTUAL CONFLICT. Verified directly: a MERGED pull request's own
 * `mergeable` field reads `"UNKNOWN"` over the API (checked live, PR #503) -- GitHub does not retain
 * whether a closed or merged PR was ever `CONFLICTING`, only the live snapshot for an OPEN one. So the
 * only durable signal is structural: a merge commit inside the branch's own history (between its
 * merge-base with the previous `main` tip and its own head) means the author reconciled with `main` before
 * finishing. A routine, conflict-FREE sync (this repo's own B3/`update-branch` practice) produces the
 * identical shape to a real content conflict's resolution merge -- git does not distinguish them in a
 * commit's structure -- so this answers "needed to reconcile", never "had a textual conflict", and the
 * distinction is stated in `conflictMetrics`'s own `method` field rather than left for a reader to assume.
 *
 * `null`, never `false`, when the PR's own merge commit cannot be inspected -- a squash/rebase merge (one
 * parent, nothing to compare) or a lookup failure. Folding an uninspectable PR into "no conflict" would be
 * exactly the "refuse rather than print zero" defect this row was filed to end.
 *
 * @param {{ number: number, mergeCommit?: { oid?: string } }} pr
 * @returns {boolean | null}
 */
export function mergedPRNeededReconciliation(pr) {
  const sha = pr.mergeCommit?.oid;
  if (!sha) return null;
  /** @type {string[]} */
  let parents;
  try {
    parents = git(["show", "--no-patch", "--format=%P", sha]).split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
  if (parents.length !== 2) return false; // squash/rebase: one parent, nothing to reconcile
  const [previousMain, branchHead] = parents;
  try {
    const base = git(["merge-base", previousMain, branchHead]);
    const merges = git(["log", "--merges", "--format=%H", `${base}..${branchHead}`]);
    return merges.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * THE FOUR FIGURES #466 EXISTS FOR, in one call. Every count states the window it was read over; the
 * conflict count separates "did not need to reconcile" from "could not tell" rather than folding an
 * uninspectable PR into a clean zero.
 *
 * #1407: the `gh` listing is handed in as `run`, and it is REQUIRED. `conflictMetrics` below hands in the live one;
 * a test hands in recorded listings, so the whole composition runs without reaching GitHub.
 * @param {string} since
 * @param {{run?: (args: string[]) => string}} [deps]
 */
export function composeConflictMetrics(since, { run } = {}) {
  const opened = prsOpened(since, { run });
  const merged = prsMerged(since, { run });
  const closedUnmerged = prsClosedUnmerged(since, { run });
  const lifetimeMinutes = mergeLifetimeMinutes(merged);
  const reconciliation = merged.map((pr) => mergedPRNeededReconciliation(pr));
  const population = new Map([...opened, ...merged, ...closedUnmerged]
    .map((/** @type {any} */ pr) => [pr.number, pr]));
  return {
    since,
    method: "opened/merged/closed via `gh pr list --search <qualifier>:>=<since>` (created/merged/closed "
      + "respectively), deduped by PR number for the hotspot table; lifetime is mergedAt-createdAt in "
      + "minutes over PRs merged in the window; the conflict signal walks each merged PR's own merge "
      + "commit (`git show --format=%P`, `git merge-base`, `git log --merges base..branchTip`) for a merge "
      + "commit inside its own branch history -- a proxy for 'needed to reconcile with a diverged main', "
      + "never a textual-conflict proof, since GitHub's mergeable/mergeStateStatus is a live snapshot and "
      + "reports UNKNOWN for anything already merged or closed.",
    opened: opened.length,
    merged: merged.length,
    closedUnmerged: closedUnmerged.length,
    lifetimeMinutes: { count: lifetimeMinutes.length, medianMinutes: percentile(lifetimeMinutes, MEDIAN),
      p90Minutes: percentile(lifetimeMinutes, P90) },
    reconciliation: { neededReconciliation: reconciliation.filter((r) => r === true).length,
      of: merged.length, unresolvable: reconciliation.filter((r) => r === null).length },
    hotspotFiles: hotspotFiles([...population.values()]),
  };
}

/**
 * The LIVE entry, the one `board-report.mjs` calls for every edition: the composition above, reading GitHub
 * through `gh`. No test calls it (#1407).
 * @param {string} since
 */
export function conflictMetrics(since) {
  return composeConflictMetrics(since, { run: gh });
}

/** Refuse to publish anything assembled from a read set that is not `main`'s.
 *
 * Refusing rather than publishing a partial edition, and SAYING SO in the log: a board output that
 * silently quotes an unreviewed gate entry is worse than a missing one, because a missing edition is
 * visible and a wrong number is not. Returns the reason, or null when it is safe.
 */
export function readSetIsNotMain() {
  const uncommitted = git(["status", "--porcelain", "--", ...READ_SET]);
  // #939, two defects on one line. `--no-renames` (through `changedFiles`), so a read-set file MOVED is
  // seen; and `origin/main`, not local `main`, which in a shared checkout has been measured over a thousand
  // commits stale -- this refusal exists to say the read set is not main's, and it was asking the wrong main.
  const offMain = changedFiles(["origin/main"], { repoRoot: ROOT, pathspec: [...READ_SET] }).join("\n");
  if (!uncommitted && !offMain) return null;
  const lines = [];
  if (uncommitted) lines.push(`uncommitted changes:\n${uncommitted}`);
  if (offMain) lines.push(`differs from \`main\` (this checkout is on `
    + `\`${git(["rev-parse", "--abbrev-ref", "HEAD"])}\`):\n${offMain}`);
  return lines.join("\n");
}

/** Everything both outputs need, read once.
 * @param {string} since */
export function collect(since) {
  const all = issues();
  // Counted rows only. `all` stays complete for state lookups; `open` is what the document reports.
  const open = countable(all.filter((/** @type {any} */ i) => i.state === "OPEN"));
  return {
    since,
    all,
    open,
    closed: all.filter((/** @type {any} */ i) => i.state === "CLOSED" && i.closedAt
      && Date.parse(i.closedAt) >= Date.parse(since)),
    milestones: JSON.parse(gh(["api", `repos/${REPO}/milestones?state=all`])),
    release: milestone(),
    ...mergeState(since),
    strays: misAuthored(since),
    ...reported(),
  };
}
