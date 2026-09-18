#!/usr/bin/env node
// @ts-check
// command: org-watch -- the org's clock. Hourly by default; `--weekly` renders the cost table.
//
// #912, step 4 of The CI Reset. COST WAS NEVER A METRIC ANYONE READ: the pipeline reached 3,317 runs a day
// for 193 merges without any figure crossing a desk, because nothing produced one. This is the row that
// says whether the other ten worked.
//
// ONE SCRIPT, TWO CADENCES. The weekly table and the hourly watch ask the same four questions of the same
// API; a second script would be a second copy of those queries, which is the shape this repository keeps
// paying for. `--weekly` selects the table.
//
// THE NAME IS THE TITLE'S, NOT THE OLD REGION'S. #912's Region declared a metrics script until
// 2026-09-11, when `ceo` widened the row to the org's clock and the Region was the half that did not get
// updated. I built against the stale Region first, reasoning that creating the other name would touch an
// undeclared path -- right about the rule, wrong about the premise: NEITHER file existed, so nothing was
// being duplicated and the choice was free. `product-manager` moved the Region to the title instead, which
// is the right direction: this is the org's clock that also renders the weekly table, not a metrics script
// that also watches. A stale Region is amended, never built to.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

/** Exit codes are the contract: 0 nothing needs attention, 1 something does, 2 could not ask. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

/** @param {string[]} args */
const defaultRun = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

// #1154: how far main's tip may lead the newest run before the run list is treated as STOPPED rather than
// quiet.
//
// **THE NUMBER IS BOUNDED BY THE FIELD, NOT TUNED AGAINST A QUEUE.** My first reason here was a
// cost-asymmetry argument, which is true and leaves the two looking arbitrary. worker-capture's reading is
// better and it is about `created_at`: GitHub stamps it when the run is REGISTERED, not when it finishes or
// starts, so a backed-up runner pool cannot inflate this lag. Measured over the five most recent `trunk`
// runs on main, `created_at` minus the commit's own committer date:
//
//   9941bef4  3s     464c22e1  3s     88920fe8  3s     51c125b7  3s     2f6b21cf  3s
//
// So a lag above two hours does not mean a slow queue -- it means **no run was CREATED while main moved**,
// which is the defect itself. Two hours is three orders of magnitude of headroom over the observed 3s and
// could come down a long way; there is no reason to, because nothing legitimate accumulates in the window.
//
// (Stated exactly: all five runs show `created_at === run_started_at`, so no queueing OCCURRED in the
// sample. What rules queueing out is that they are separate fields with separate meanings, not that these
// five agree. A queued run would move `run_started_at` and leave `created_at` where it is.)
//
// **THE ONE LEGITIMATE FOREVER-LAG, and it is not this workflow.** A workflow with a `paths:` or branch
// filter can sit un-run across many pushes by design, and this metric would call it stopped. `trunk` runs
// on every push to main, unfiltered, which is what makes the comparison sound here. A filtered workflow
// needs a different question, not a bigger number.
const STOPPED_AFTER_LAG_HOURS = 2;

/**
 * THE TABLE'S ROWS, DECLARED ONCE -- the baseline, the target, and which direction is better.
 *
 * Two of these baselines are not the CI Reset plan's, and the row states why rather than inheriting them:
 * **207, not 206** (one guard landed after the plan was written) and **10 workflows, not 8** (`ceo` ruled on
 * #901 that `board-report.yml` and `board-summary-check.yml` stay, gated on London's clock). A target
 * inherited from a table rather than from the decisions that followed it is unreachable by construction.
 *
 * `better: "down"` means a smaller number is the improvement. It is declared rather than inferred from
 * whether baseline exceeds target, because the two coincide today and would stop coinciding the moment a
 * metric passed its target -- at which point an inferred direction silently inverts.
 * @type {{ key: string, label: string, baseline: string, target: string, better: "up" | "down" }[]}
 */
export const METRICS = [
  { key: "runsPerMerge", label: "workflow runs per merge", baseline: "17.2", target: "<= 3", better: "down" },
  { key: "passRate", label: "`ci` pass rate on pull requests, cancelled excluded", baseline: "72%", target: ">= 80%", better: "up" },
  { key: "nonProductRed", label: "red PRs whose failing job is NOT a product test", baseline: "2 in 3", target: "0", better: "down" },
  { key: "wallTime", label: "`ci` wall time on a pull request", baseline: "~2 min", target: "<= 5 min", better: "down" },
  { key: "repoReadingTests", label: "test files that read the repo rather than the product", baseline: "207", target: "<= 20", better: "down" },
  // #909 (2026-09-12): the end state is 13, not the plan's 10 -- ceo ruled the two board workflows stay (#901) and
  // auto-arm.yml stays (drafts cannot be armed; it hosts the update-branch train), measured on the tree.
  { key: "workflows", label: "workflows", baseline: "19", target: "13", better: "down" },
  // #912: THE WORD `unattended` IS GONE FROM THE LABEL, and the baseline is not. worker-capture's finding:
  // the value is raw red-hours from `mainColour`, which reads `trunk` (trunk.yml) conclusions and knows nothing
  // about who was looking -- and the separating case is 2026-09-12's own incident, where 03:52Z-04:15Z had
  // nobody knowing and the minutes after had two sessions on it. **`redHours` scores those identically.**
  // A metric that cannot tell them apart must not carry the word in its name; the note beneath it was
  // honest and the note is not the label, and the label is the half that travels. 27.8 stays as the
  // baseline because it is the same measurement. Measuring attendance for real is a row, not a line.
  { key: "redHours", label: "`main` red for N hours", baseline: "27.8", target: "0", better: "down" },
];

/**
 * A FIGURE IS NEVER A BARE NUMBER. `examined` is how many things the measurement actually looked at, and
 * `window` is the period it covers -- both rendered on the same line as the value, every week.
 *
 * The row names the two incidents this shape exists for. **A run count with no window is not a rate:** a
 * peer's 17 and this script's 42 were both right on the board's first edition, over different windows.
 * **The examined count is part of every figure:** a guard census that reports 0 having globbed nothing is
 * the cleanest possible output, and indistinguishable from a real zero without it.
 *
 * `value === null` means the measurement could not be made -- an empty population, a failed read -- and it
 * is NOT rendered as 0, 100% or a dash. See `renderFigure`.
 * @param {{ value: string | null, examined: number, window: string, denominator?: string, note?: string }} f
 * @returns {{ value: string | null, examined: number, window: string, denominator: string, note: string }}
 */
export function figure({ value, examined, window, denominator = "", note = "" }) {
  return { value, examined, window, denominator, note };
}

/**
 * `ci`'s pass rate on pull requests, CANCELLED EXCLUDED -- and the rendered line says so.
 *
 * 107 of 9 September's 602 `ci` runs cancelled themselves. A pass rate computed over
 * `conclusion !== "success"` reads **59%**; over failures only, **72%**. Both are arithmetic on the same
 * data and only one answers "does `ci` pass", so the exclusion is in the function AND in the line it
 * renders -- a reader who does not know which convention was used cannot use the number.
 *
 * AN ALL-CANCELLED POPULATION RETURNS `null`, NOT 100% OR 0%. Every run cancelled means `ci` was never
 * asked, and both of those numbers are confident answers to a question nobody put.
 * @param {{ conclusion: string | null }[]} runs
 * @returns {{ value: string | null, examined: number, denominator: string, note: string }}
 */
export function passRate(runs) {
  const cancelled = runs.filter((r) => r.conclusion === "cancelled").length;
  const counted = runs.filter((r) => r.conclusion === "success" || r.conclusion === "failure");
  const successes = counted.filter((r) => r.conclusion === "success").length;
  const note = `cancelled excluded (${cancelled} of ${runs.length})`;
  if (counted.length === 0) {
    return { value: null, examined: runs.length, denominator: "0 runs that either passed or failed", note };
  }
  return {
    value: `${Math.round((successes / counted.length) * 100)}%`,
    examined: runs.length,
    denominator: `${successes}/${counted.length} runs`,
    note,
  };
}

/**
 * One table row: the value beside its baseline and target, so a number that moved the wrong way is visible
 * without arithmetic. **A figure with no value says what was examined instead**, never a blank or a zero.
 * @param {{ metric: typeof METRICS[number], figure: ReturnType<typeof figure> }} row
 * @returns {string}
 */
export function renderFigure({ metric, figure: f }) {
  const parts = [f.window, f.denominator, f.note].filter(Boolean).join("; ");
  const value = f.value === null
    ? `NOT MEASURED -- examined ${f.examined}`
    : `${f.value} (examined ${f.examined})`;
  return `| ${metric.label} | ${metric.baseline} | ${metric.target} | ${value} | ${parts} |`;
}

/**
 * The whole table. A metric with no figure renders as NOT MEASURED rather than being omitted -- a row that
 * disappears from a table reads as a metric nobody needed, which is how the seventh number came to be
 * missing for the 27.8 hours it exists to measure.
 * @param {Record<string, ReturnType<typeof figure>>} figures
 * @returns {string}
 */
export function renderTable(figures) {
  const header = "| metric | baseline, 9 Sept | target | this week | window and denominator |\n|---|---|---|---|---|";
  const rows = METRICS.map((metric) => renderFigure({
    metric,
    figure: figures[metric.key] ?? figure({ value: null, examined: 0, window: "not read" }),
  }));
  return [header, ...rows].join("\n");
}

/**
 * THE COUNT IS `total_count`, NOT THE PAGE. `actions/runs?per_page=1` returns `total_count` for the whole
 * query; counting the returned items counts the page size, which is 1. Named because this project has
 * already reported a page size as a population.
 * @param {string} path an `actions/runs` query, without the leading `repos/<repo>/`
 * @param {{ repo: string, run?: typeof defaultRun }} deps
 * @returns {number | null} `null` when the read failed -- never 0, which is a real answer
 */
export function totalCount(path, { repo, run = defaultRun }) {
  try {
    const total = JSON.parse(run(["api", `repos/${repo}/${path}`])).total_count;
    return typeof total === "number" ? total : null;
  } catch (cause) {
    void cause;
    return null;
  }
}

/**
 * HOW STALE IS THIS RUN LIST, measured against a source the workflow cannot freeze -- `null` when unknown.
 *
 * #1154. The comparison is main's own TIP COMMIT, not a clock. A threshold on age alone cries wolf on a
 * genuinely quiet weekend, because `trunk` runs on merges and a repo with no merges truthfully has no new
 * runs. Main's tip moving without the workflow running is a different statement and it is the true one:
 * **this workflow is not seeing main any more.** It is silent in a quiet period by construction, and it
 * does not need to know that a rename ever happened -- which is the property both fixes before it lacked.
 *
 * The two facts come from different GitHub subsystems (git data and Actions), so the frozen-entity failure
 * cannot produce both halves. A shared source would only prove the source agrees with itself.
 *
 * @param {{ newestRunAt: string, mainTipAt: string | null, lagHours?: number }} args
 * @returns {boolean | null} `null` when main's tip could not be read -- unknown is not "fine"
 */
export function runsHaveStopped({ newestRunAt, mainTipAt, lagHours = STOPPED_AFTER_LAG_HOURS }) {
  if (!mainTipAt) return null;
  const lag = (Date.parse(mainTipAt) - Date.parse(newestRunAt)) / 3_600_000;
  return Number.isFinite(lag) ? lag > lagHours : null;
}

/**
 * WHEN MAIN'S TIP COMMIT LANDED, or `null` when it could not be read.
 *
 * A failed read must not be reported as "not stale": the caller treats `null` as unknown rather than as
 * a pass, because #912's finding on this very file is that an unreadable main and a green main must never
 * return the same thing.
 *
 * @param {string} repo
 * @param {typeof defaultRun} run
 * @returns {string | null}
 */
function mainTipCommittedAt(repo, run) {
  try {
    const at = run(["api", `repos/${repo}/commits/main`, "--jq", ".commit.committer.date"]);
    return typeof at === "string" && at.trim() !== "" ? at.trim() : null;
  } catch {
    return null;
  }
}

/**
 * THE RUNS THAT HAVE FINISHED, AND A COUNT OF THOSE THAT HAVE NOT.
 *
 * #1263. `mainColour` used to read `newestFirst[0].conclusion !== "failure"` over the unfiltered list.
 * An in-flight run's conclusion is `null`, which is not `"failure"` -- so ANY run newer than the last
 * completed one masked a red main. Driven on that function, same red trunk, one ghost run (#1253) added:
 *
 *   red trunk, no ghost                readable=true  red=true
 *   SAME red trunk + one GHOST newer   readable=true  red=false
 *
 * An ordinary in-flight run masks it too and self-corrects within minutes. A GHOST never completes
 * (`queued` AND zero jobs AND `updated_at == created_at`; the two on #1253 were still stuck 90
 * minutes after creation, read at 10:49:54Z against a 09:19:57Z creation), so the masking never lifts.
 * AND A GHOST OUTLIVES ITS BRANCH: `agent/verdict-parser-1245` merged and was deleted at 10:26Z, and
 * both were still `queued` against a ref that no longer exists -- so "the branch is gone, its runs
 * are settled" is wrong about them, and no cleanup anyone performs will clear one. This is the fourth member of the family this file already
 * guards -- a 502, an empty list, a stopped list -- each of which must never return what green returns.
 *
 * `inFlight` is reported ALONGSIDE the colour rather than replacing it. Deciding "cannot say" whenever
 * anything is running would silence the clock most of the day, since CI runs constantly: the newest
 * COMPLETED run is a real answer about main, and the in-flight one is a real fact about what is not in
 * it yet. Only when NOTHING has completed is there no answer to give.
 *
 * COMPLETION IS `conclusion != null`, NOT `status === "completed"`. GitHub gives a finished run a
 * conclusion (`cancelled` and `skipped` included) and an unfinished one `null`, so the conclusion alone
 * answers it; requiring `status` as well adds no discrimination and rejects a caller passing only the
 * field this function reads.
 *
 * @param {{ conclusion: string | null, created_at: string, databaseId?: number, id?: number }[]} runs
 */
function splitByCompletion(runs) {
  const completed = runs.filter((r) => r.conclusion != null);
  return { completed, inFlight: runs.length - completed.length };
}

/**
 * THE RED STREAK: the FIRST failure after the last success, and how long ago it began.
 *
 * Not the newest failure, which understates every streak longer than one run -- #928 was 8 runs over
 * 27.8 hours and the newest-failure reading would have said 0. `atLeast` is true when NO success appears
 * in the page at all, so the oldest run here is a PAGE BOUNDARY rather than the start of the streak and
 * the figure is a LOWER BOUND; carrying that to the caller is what stops a bound being printed as an
 * exact number. worker-capture's finding; the fixture reached everything except that branch.
 *
 * #1263: THE CALLER PASSES **COMPLETED** RUNS ONLY, and that is load-bearing rather than tidy. An
 * in-flight run has no conclusion, so `findIndex(conclusion === "success")` steps straight past it and
 * `slice(0, lastSuccess)` puts it INSIDE the streak -- with an unfinished run between the last success
 * and the newest failure, `oldest` IS that run, so the streak is reported as starting early and
 * `firstFailing` goes looking for the failing assertion of a run that never ran.
 *
 * @param {{ conclusion: string | null, created_at: string, databaseId?: number, id?: number }[]} completed
 * @param {Date} now
 */
function redStreak(completed, now) {
  const lastSuccess = completed.findIndex((r) => r.conclusion === "success");
  const atLeast = lastSuccess === -1;
  const streak = atLeast ? completed : completed.slice(0, lastSuccess);
  const oldest = streak[streak.length - 1];
  return { oldest, atLeast, hours: (now.getTime() - Date.parse(oldest.created_at)) / 3_600_000 };
}

/**
 * MAIN'S COLOUR, and how long since the last success -- the read #928 existed for.
 *
 * RED OVER AN HOUR REPORTS WITH THE FIRST FAILING TEST NAMED, never the job name: in #928 both `docs` and
 * `ts` reported "fail" and the answer was two assertions from #903, which no job name could have told
 * anyone. The assertion comes from the run's own failing log.
 * @param {{ repo: string, workflow?: string, now?: Date, run?: typeof defaultRun }} deps
 * @returns {{ readable: boolean, red: boolean, since: string | null, hours: number | null,
 *             atLeast: boolean, firstFailing: string | null, why: string | null,
 *             windows: { since: string, until: string | null, hours: number, open: boolean }[],
 *             examined: number, pageBeginsMidRed: boolean, inFlight?: number }}
 */

// #909/#1154 (2026-09-12): the trunk workflow file is `trunk.yml` (it was `trunk-guard.yml`), and the
// failure a stale default produces is NOT the one #1150 was filed with. Measured live that afternoon:
//
//   actions/workflows/trunk-guard.yml/runs   200   total_count=409   newest 15:07:32Z  (frozen)
//   mainColour({ workflow: "trunk-guard" })  ->  { red: false, examined: 20, why: null }
//   mainColour({ workflow: "trunk"       })  ->  { red: false, examined: 4,  why: null }
//
// It does not 404 and it is not a CANNOT_ASK. GitHub keeps a deleted or renamed workflow's entity
// addressable by its old path for ever, so the old name returns a CONFIDENT GREEN off a run history that
// stopped when the rename landed -- and `examined: 20` against the true read's `examined: 4` means **the
// wrong answer carries the larger sample**. The `catch` above would have caught a 404; the empty-list
// guard below would have caught an empty page. The case GitHub actually produces is the one neither
// covers, which is why the staleness check exists rather than a better default alone.
export function mainColour({ repo, workflow = "trunk", now = new Date(), run = defaultRun }) {
  /** @type {{ conclusion: string | null, created_at: string, databaseId?: number, id?: number }[]} */
  let runs;
  try {
    runs = JSON.parse(run(["api",
      `repos/${repo}/actions/workflows/${workflow}.yml/runs?branch=main&per_page=${RUNS_PAGE_SIZE}`])).workflow_runs ?? [];
  } catch (cause) {
    // #912: AN UNREADABLE MAIN IS NOT A GREEN ONE, AND MUST NOT RETURN THE SAME OBJECT.
    //
    // worker-capture's finding, and it was the worst thing in this file. This used to return the green
    // shape field for field, so `gh: HTTP 502` and a healthy main were INDISTINGUISHABLE -- and composed
    // with `watchReport`'s silence-when-clean, six hours of `gh` failing were six quiet hours at exit 0,
    // with `redHours` reporting 0 for the window. **The clock's only failure mode looked exactly like its
    // success.** A pinning test asserted the shape and could not separate them, because there was nothing
    // to separate: `assert.notDeepEqual(unreadable, green)` is the one line that would have caught it.
    return { readable: false, red: false, since: null, hours: null, atLeast: false, firstFailing: null,
      windows: [], examined: 0, pageBeginsMidRed: false,
      why: `could not read ${workflow}'s runs: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  // #1047: THE SEQUENCE, from the list already fetched -- no extra call. `mainColour` answers "is main red
  // now"; `windows` answers "what has main done since the last read", which is the question a watch at any
  // interval can actually answer.
  const sequence = redWindows(runs, now);
  const newestFirst = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  // AN EMPTY LIST IS ALSO NOT A GREEN MAIN. A workflow with no runs at all -- renamed, never triggered,
  // or a `branch=main` filter that matches nothing -- answers the question no more than a 502 does.
  if (newestFirst.length === 0) {
    return { readable: false, red: false, since: null, hours: null, atLeast: false, firstFailing: null,
      windows: [], examined: 0, pageBeginsMidRed: false,
      why: `${workflow} reports no runs on main at all` };
  }
  // #1154: A LIST THAT STOPPED IS NOT A GREEN MAIN EITHER -- the third member of the family above, and
  // the only one GitHub actually produced. Unknown (`null`) is NOT treated as fine here, but it is not
  // treated as stale either: it means main's tip could not be read, so this guard declines to speak and
  // the run list is used as it stands. Saying more than that would be inventing the thing this row is about.
  const stopped = runsHaveStopped({ newestRunAt: newestFirst[0].created_at,
    mainTipAt: mainTipCommittedAt(repo, run) });
  if (stopped === true) {
    return { readable: false, red: false, since: null, hours: null, atLeast: false, firstFailing: null,
      windows: [], examined: 0, pageBeginsMidRed: false,
      why: `${workflow}'s newest run on main is older than main's own tip commit, so it has stopped `
        + `seeing main -- a renamed or deleted workflow still answers with its frozen history (#1154)` };
  }
  const { completed, inFlight } = splitByCompletion(newestFirst);
  if (completed.length === 0) {
    return { readable: false, red: false, since: null, hours: null, atLeast: false, firstFailing: null,
      windows: [], examined: 0, pageBeginsMidRed: false, inFlight,
      why: `${workflow} has ${inFlight} run(s) on main and NONE of them has completed, so nothing here `
        + `says what main's colour is -- a run that has not finished is not a green one (#1263)` };
  }
  if (completed[0].conclusion !== "failure") {
    return { readable: true, red: false, since: null, hours: null, atLeast: false, firstFailing: null,
      why: null, inFlight, ...sequence };
  }
  // THE FIRST failure AFTER THE LAST success -- not the newest failure, which understates every streak
  // longer than one run. #928 was 8 runs over 27.8 hours and the newest-failure reading would have said 0.
  //
  // `lastSuccess === -1` means NO success appears in the page at all, so the oldest run here is a PAGE
  // BOUNDARY rather than the start of the streak, and the figure is a LOWER BOUND. `atLeast` carries that
  // to the caller rather than letting a bound be printed as an exact number -- the shape #928's own table
  // is about. worker-capture's finding; the fixture reached everything except this branch.
  const { oldest, hours, atLeast } = redStreak(completed, now);
  const id = oldest.databaseId ?? oldest.id;
  return {
    ...sequence,
    readable: true,
    red: true,
    inFlight,
    since: oldest.created_at,
    hours: Math.round(hours * 10) / 10,
    atLeast,
    firstFailing: id === undefined ? null : firstFailingAssertion(id, { repo, run }),
    why: null,
  };
}

/**
 * The first `not ok <n> - <name>` line in a run's failing log, or `null`.
 *
 * `null` reads as "the log did not name one", which is a different report from "the job failed" -- and the
 * caller prints it as such rather than falling back to the job name, which is the fallback #928 proved
 * useless.
 * @param {number} runId
 * @param {{ repo: string, run?: typeof defaultRun }} deps
 * @returns {string | null}
 */
export function firstFailingAssertion(runId, { repo, run = defaultRun }) {
  try {
    const log = run(["run", "view", String(runId), "--repo", repo, "--log-failed"]);
    const line = log.split("\n").find((l) => /\bnot ok [0-9]+ - /.test(l));
    return line ? line.slice(line.indexOf("not ok")).trim() : null;
  } catch (cause) {
    void cause;
    return null;
  }
}

/**
 * THE QUEUE, AGGREGATED BY CONCLUSION -- never `head`, `tail` or `grep -v` and then a conclusion over the
 * remainder. That hid two failing rows on #900 and turned a partial read into an apparently exhaustive one.
 * @param {{ name?: string, conclusion?: string | null, status?: string | null }[]} checks
 * @returns {Record<string, number>}
 */
export function byConclusion(checks) {
  // NEWEST PER NAME FIRST is deliberately NOT done here: this takes the checks it is given, and the caller
  // that reads them from the API owns that narrowing. Two narrowings in one function is how a superseded
  // run came to be counted twice.
  /** @type {Record<string, number>} */
  const counts = {};
  for (const check of checks) {
    counts[outcomeOf(check)] = (counts[outcomeOf(check)] ?? 0) + 1;
  }
  return counts;
}

/**
 * One check's outcome, normalised -- because THE SAME QUESTION HAS THREE SPELLINGS ACROSS `gh`'s OWN
 * SOURCES, measured 2026-09-12 against this repository:
 *
 * ```
 * gh api .../check-runs        conclusion: null        status: "in_progress"   lower case
 * gh run list --json           conclusion: ""          status: "in_progress"   lower case
 * gh pr list statusCheckRollup conclusion: "SKIPPED"   status: "COMPLETED"     UPPER CASE
 * ```
 *
 * Two traps, and this function exists for both. `??` falls back on `null` and **not** on `""`, so the
 * middle row buckets under the empty string -- a count labelled with nothing, which reads as a category
 * nobody recognises rather than as the pending run it is. And the third row makes `SUCCESS` and `success`
 * two buckets of the same outcome, so a population split across sources sums correctly and reports wrongly.
 *
 * A counter whose whole job is "count the population by outcome" must not invent an outcome, and the
 * empty-string bucket is exactly that. Lower-cased and emptiness-tolerant here, once, rather than at each
 * of the three call sites this will grow.
 * @param {{ conclusion?: string | null, status?: string | null }} check
 * @returns {string}
 */
function outcomeOf({ conclusion, status }) {
  const present = (/** @type {string | null | undefined} */ value) =>
    (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null);
  return present(conclusion) ?? present(status) ?? "unknown";
}

/**
 * EVERY RED WINDOW IN THE RUN LIST, oldest first -- #1047. **Main's colour is not a sample, it is a
 * sequence.**
 *
 * `mainColour` answers *is main red now*, and a watch that only asks that cannot see a break shorter than
 * its own interval. Measured 2026-09-12: the night's red lasted **19.9 minutes** against a first read
 * specified as hourly -- roughly a 1-in-3 chance of overlapping any given sample. `product-manager`'s own
 * 30-minute clock read green at 03:43Z, the red became knowable at 03:59:19Z, and their 04:13Z reading
 * reported it three minutes after a person had already found it by hand.
 *
 * **A sampling watch that misses produces a GREEN RECORD across a window in which main was broken**, and
 * *"silent when clean"* and *"silent because it did not look"* render identically in a log -- which is
 * #912's own founding sentence arriving inside the clock built to answer it.
 *
 * The run list holds every conclusion whether or not anyone was looking, so a read at ANY interval can
 * report every window since the last one. Sampling harder is not the lever: a red shorter than the
 * interval is invisible at every interval.
 *
 * THREE THINGS THAT ARE NOT WINDOWS, each of which would otherwise be counted as zero red:
 *
 * - **A window still OPEN at the read** is counted to `now` and carries `open: true`. Summed naively it
 *   contributes nothing or is dropped for having no close, so **the worst state reports as the best**.
 * - **A run still IN FLIGHT neither opens nor closes a window.** It is not a failure and it is not a
 *   success, and treating it as either invents an edge.
 * - **A GAP IN THE RUNS IS NOT GREEN.** `trunk` runs on merges, so six hours with no merge is six
 *   hours of UNKNOWN -- no evidence either way. `examined` is returned so a caller can say "N windows
 *   across M runs examined" rather than reporting a clean sheet it did not earn. A field empty by
 *   construction is not evidence of absence.
 *
 * @param {{ conclusion?: string | null, created_at: string }[]} runs
 * @param {Date} now
 * @returns {{ windows: { since: string, until: string | null, hours: number, open: boolean }[],
 *             examined: number, pageBeginsMidRed: boolean }}
 */
export function redWindows(runs, now) {
  const settled = [...runs]
    .filter((r) => r.conclusion === "failure" || r.conclusion === "success")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const windows = [];
  /** @type {string | null} */
  let openedAt = null;
  for (const run of settled) {
    if (run.conclusion === "failure" && openedAt === null) openedAt = run.created_at;
    if (run.conclusion === "success" && openedAt !== null) {
      windows.push({ since: openedAt, until: run.created_at, open: false,
        hours: hoursBetween(openedAt, run.created_at) });
      openedAt = null;
    }
  }
  if (openedAt !== null) {
    windows.push({ since: openedAt, until: null, open: true,
      hours: hoursBetween(openedAt, now.toISOString()) });
  }
  // #1049: A PAGE THAT BEGINS MID-RED CLIPS ITS FIRST WINDOW, and the clip is INVISIBLE in the numbers.
  //
  // `redWindows` opens at the first `failure` it can see. If the run that actually opened the window is off
  // the end of `per_page=20`, the window starts at the page edge instead and its hours are understated.
  // worker-capture drove one real history both ways through this function:
  //
  //     whole history    "15" hours, since 2026-09-11T14:00Z, 1 window across 4 settled runs
  //     page-truncated    "5" hours, since 2026-09-12T00:00Z, 1 window across 2 settled runs
  //
  // **Three times understated, on a metric whose target is 0, in the direction that looks better** -- and
  // the two notes differ only by a denominator no reader would read as a truncation warning, because
  // "1 window across 2 settled runs" is exactly what a quiet week looks like.
  //
  // The bound is readable WITHOUT paginating: if the OLDEST settled run in the page is a `failure`, the
  // page starts mid-red and that window's start is unknown. One bit, from the list already fetched, and
  // the identical signal `mainColour` already carries for the streak.
  // NAMED `pageBeginsMidRed`, not `atLeast`: `mainColour` already carries an `atLeast` meaning "no success
  // appears in the page, so the STREAK may be older than it looks". Same cause, different claim, and one
  // object cannot carry both under one name -- which typescript caught the moment they met.
  const pageBeginsMidRed = settled.length > 0 && settled[0].conclusion === "failure";
  return { windows, examined: settled.length, pageBeginsMidRed };
}

/** @param {string} from @param {string} to @returns {number} hours to one decimal */
function hoursBetween(from, to) {
  return Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10;
}

/**
 * The sum of every red window, and how it was arrived at -- #1047. A SINGLE CURRENT WINDOW IS THE SAMPLING
 * ASSUMPTION ONE LAYER UP: it reports 0 for a night with three breaks all fixed before the weekly read.
 *
 * The rendered text names the window count AND the runs examined, because a week with few merges has few
 * conclusions to read and must say so rather than presenting a quiet sheet as a clean one.
 * @param {ReturnType<typeof redWindows>} read
 * @returns {{ value: string, note: string }}
 */
export function redHoursFigure({ windows, examined, pageBeginsMidRed = false }) {
  const total = Math.round(windows.reduce((sum, w) => sum + w.hours, 0) * 10) / 10;
  const stillOpen = windows.some((w) => w.open);
  return {
    // #1049: `at least` ON THE VALUE, not only in the note. A clipped window understates the figure
    // threefold and a denominator is not a truncation warning -- the number itself has to say it is a
    // bound, because the number is what gets quoted.
    value: pageBeginsMidRed ? `at least ${total}` : String(total),
    note: `${windows.length} window(s) across ${examined} settled run(s) examined`
      + (pageBeginsMidRed ? "; the page BEGINS MID-RED, so the first window's start is unknown and this is a "
        + "lower bound" : "")
      + (stillOpen ? "; THE LAST IS STILL OPEN at the read" : ""),
  };
}

/**
 * How many of a workflow's runs on main `mainColour` reads: one page. Named because the weekly figure's window
 * states it, and a window naming a different count from the query would be a second copy of one fact.
 */
export const RUNS_PAGE_SIZE = 20;

/**
 * #1267: THE WEEKLY RED-HOURS FIGURE, the one `main()` prints -- and the only place it is built.
 *
 * The inline expression it replaces had two defects. It never read `colour.readable`, so a main that could not be
 * read printed `0` against a target of `0`, on the one row of the table where every other unmeasured figure says
 * NOT MEASURED: #912's "an unreadable main is NOT a green one", arriving through the weekly path. And it printed
 * `colour.hours`, the CURRENT streak, which #1047 had already ruled out for this figure. `redHoursFigure` sums
 * every red window in the page because a single current window "reports 0 for a night with three breaks all fixed
 * before the weekly read"; #1047 built and tested that sum and never wired it into `main()`.
 *
 * `examined` is the settled runs the windows were read from, and the window names the page, because a sum over
 * the newest RUNS_PAGE_SIZE runs is not "since the last trunk success".
 * @param {ReturnType<typeof mainColour>} colour
 * @returns {ReturnType<typeof figure>}
 */
export function weeklyRedHoursFigure(colour) {
  if (!colour.readable) {
    return figure({ value: null, examined: 0, window: `the newest ${RUNS_PAGE_SIZE} trunk runs on main`,
      note: `NOT READ: ${colour.why ?? "main's colour could not be read"}` });
  }
  const summed = redHoursFigure(colour);
  return figure({ value: summed.value, examined: colour.examined,
    window: `red windows in the newest ${RUNS_PAGE_SIZE} trunk runs on main`,
    note: `${summed.note}; raw red-hours; attendance is not measured and is no longer implied by the label (#912)` });
}

/**
 * READ 2 -- THE QUEUE. Every open PR's checks, counted by conclusion, and the ones that need a person.
 *
 * A PR is NAMED when it carries a failing check; the count alone is the summary and the names are the
 * action. `redFor` is how many merge cycles it has been red, which the caller supplies because this
 * function does not know what a cycle is -- a threshold computed inside a reporter is a threshold nobody
 * can change without reading it.
 * @param {{ number: number, checks: { name: string, conclusion: string | null, status: string }[] }[]
 *          | null} prs `null` means the read was REFUSED -- see the note in the body.
 * @returns {{ refused: boolean, counts: Record<string, number>,
 *             failing: { number: number, jobs: string[] }[], examined: number | null, why?: string }}
 */
export function queueReport(prs) {
  // #1286: `null` MEANS THE READ WAS REFUSED, and it is the CALLER's job to pass it.
  //
  // A refused `gh pr list` exits 1 with EMPTY stdout (#1279, measured), so a caller that keeps the exit
  // status can always tell a refusal from an empty queue and one that pipes it away never can. Passing
  // `[]` for a refusal made this function answer `examined: 0` -- which the org reads as "nothing is
  // queued" and acts on. Fourth member of the family this file already guards for `mainColour`: a 502,
  // an empty list and a stopped list must none of them return what the healthy answer returns.
  //
  // AN EMPTY QUEUE IS STILL `examined: 0` AND STILL FINE. A reader that answers `refused` whenever it is
  // unsure blocks every quiet morning, which is worse than the state this replaces.
  if (prs === null) {
    return { refused: true, counts: {}, failing: [], examined: null,
      why: "the queue could not be read -- a refused `gh` call exits non-zero with empty output, so this "
        + "is NOT an empty queue and must not be reported as one (#1286)" };
  }
  /** @type {Record<string, number>} */
  const counts = {};
  const failing = [];
  for (const pr of prs) {
    for (const [key, n] of Object.entries(byConclusion(pr.checks))) counts[key] = (counts[key] ?? 0) + n;
    const jobs = pr.checks.filter((c) => c.conclusion === "failure").map((c) => c.name);
    if (jobs.length > 0) failing.push({ number: pr.number, jobs });
  }
  return { refused: false, counts, failing, examined: prs.length };
}

/**
 * READ 3 -- UTILISATION. **An engineer with no open PR and no ready row in their lane is a finding**, and
 * the row it produces is a re-ordering rather than a message: telling somebody they are idle when their
 * lane is empty is a report about the board, not about them.
 *
 * The two states are deliberately distinguished. `idle` means there IS work and they are not on it;
 * `starved` means there is not, which is the board's problem.
 * @param {{ session: string, openPrs: number, readyRows: number }[]} engineers
 * @returns {{ idle: string[], starved: string[], examined: number }}
 */
export function utilisation(engineers) {
  return {
    idle: engineers.filter((e) => e.openPrs === 0 && e.readyRows > 0).map((e) => e.session),
    starved: engineers.filter((e) => e.openPrs === 0 && e.readyRows === 0).map((e) => e.session),
    examined: engineers.length,
  };
}

/**
 * READ 4 -- THE BOARD DEADLINE. The hand-written summary must exist by **07:15 London**; unwritten after
 * **06:15** is the most urgent item this script can report.
 *
 * Pure over a London wall-clock time and whether the summary exists, so the hour arithmetic is tested
 * rather than the clock. The caller converts; this decides. A timezone conversion inside a decision is how
 * a deadline comes to be measured in the wrong hour twice a year.
 * @param {{ londonHour: number, londonMinute: number, written: boolean }} now
 * @returns {string | null} the report, or `null` when nothing needs saying
 */
export function boardDeadline({ londonHour, londonMinute, written }) {
  if (written) return null;
  const minutes = londonHour * 60 + londonMinute;
  if (minutes < 6 * 60 + 15) return null;
  const deadline = 7 * 60 + 15;
  return minutes >= deadline
    ? `THE BOARD SUMMARY IS LATE -- unwritten at ${pad(londonHour)}:${pad(londonMinute)} London, past 07:15.`
    : `THE BOARD SUMMARY IS UNWRITTEN at ${pad(londonHour)}:${pad(londonMinute)} London -- due 07:15. `
      + "This is the most urgent item on this watch.";
}

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");

/** @returns {{ weekly: boolean }} */
function parseArgs() {
  refuseUnknownFlags(["--weekly"], { entry: import.meta.url, command: "node packages/agent-org/src/org-watch.mjs" });
  return { weekly: process.argv.includes("--weekly") };
}

/**
 * SILENT WHEN CLEAN. The hourly watch prints only what needs attention, so a quiet hour costs a reader
 * nothing and a noisy one is worth opening -- the property that makes 24 runs a day affordable. Exit 1
 * when there is something, 0 when there is not.
 * @param {{ colour: ReturnType<typeof mainColour> }} reads
 * @returns {string[]}
 */
export function watchReport({ colour }) {
  const lines = [];
  // #912: A CLOCK THAT CANNOT READ ITS SOURCE SAYS SO. Silence is reserved for a main that is genuinely
  // green; an unreadable one is the loudest thing this script can be wrong about, because nothing else in
  // the org is looking.
  if (!colour.readable) {
    lines.push(`CANNOT ASK: main's colour is unknown -- ${colour.why}. `
      + "This watch has not reported on main; treat its silence elsewhere as unverified too.");
    return lines;
  }
  if (colour.red) {
    const bound = colour.atLeast ? "at least " : "";
    lines.push(`MAIN IS RED for ${bound}${colour.hours}h since ${bound === "" ? "" : "at least "}`
      + `${colour.since} -- ${colour.firstFailing ?? "the failing log named no assertion"}`);
  }
  return lines;
}

function main() {
  const { weekly } = parseArgs();
  const repo = process.env.GITHUB_REPOSITORY ?? "a11ign/a11ign";
  const colour = mainColour({ repo });
  if (weekly) {
    process.stdout.write(`${renderTable({
      redHours: weeklyRedHoursFigure(colour),
    })}\n`);
    process.exitCode = EXIT.QUIET;
    return;
  }
  // READS 2-4 ARE NOT WIRED INTO THIS PATH YET, and that is stated rather than left to be discovered:
  // `queueReport`, `utilisation` and `boardDeadline` are built and tested as pure decisions, and the
  // `gh` readers that feed them are the remaining half of #912. A watch that silently reported on one of
  // its four questions would be the shape this row exists to end.
  const lines = watchReport({ colour });
  if (lines.length === 0) {
    process.exitCode = EXIT.QUIET;
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  // #1072: CANNOT_ASK WAS DECLARED AND NO PATH PRODUCED IT, so this contract promised three states and
  // delivered two. `watchReport` has always distinguished them -- it opens with "CANNOT ASK: main's colour
  // is unknown" when the read failed -- and the exit code collapsed that back into ATTENTION.
  //
  // **An unreachable exit code is a promise to the caller, not a dead branch.** A caller reading the status
  // could never separate `could not ask` from `main is red`, and of the two, one is a fact about main and
  // the other is a fact about this watch. #912's own rule is that a clock which cannot read its source says
  // so; saying it in the report and not in the status says it only to whoever reads the prose.
  process.exitCode = colour.readable ? EXIT.ATTENTION : EXIT.CANNOT_ASK;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
