#!/usr/bin/env node
// @ts-check
// command: say whether the board report's cron is still arriving, and comment once if not
// HAS THE BOARD EDITION STOPPED ARRIVING? — the check that does not live inside the job being checked.
//
//   npm run board:liveness            say whether editions are still arriving
//   npm run board:liveness -- --post  and comment ONCE on the report issue if they are not
//
// ## The gap this closes, and why the previous shape could not
//
// Every refusal in this pipeline is reported BY THE JOB ITSELF. `board-report.mjs` refuses without a
// summary and says so; `board-summary-check.mjs` warns on the morning of the edition; both comment on the report
// issue. All of that is correct and none of it can fire when the job does not run at all — a job that does
// not exist reports nothing, which is this repository's oldest defect (*"a check that reports success
// having examined nothing"*) with the check removed rather than weakened.
//
// The schedule moved from a launchd agent on one Mac to two GitHub Actions workflows on 2026-09-06, which
// fixed the part everybody could see (nobody else could restart or inherit that Mac) and left this part
// exactly where it was. **GitHub DISABLES a scheduled workflow after 60 days without repository activity**,
// silently, and a disabled workflow produces no run, no log and no red mark — the same silence as an
// uninstalled launchd job, reached by a different door.
//
// ## Why this runs on PUSH, and why that is not merely convenient
//
// A watchdog that is itself scheduled has the disease it is watching for: GitHub disables scheduled
// workflows repository-wide, so a third cron dies in the same breath as the two it guards.
//
// A PUSH trigger cannot be disabled by inactivity, **because a push IS the activity**. That is not a
// workaround, it is the exact complement of the failure mode: the one condition that silences the schedule
// is the one condition that silences this check too, and when it does, a repository nobody has pushed to
// for sixty days having no board edition is not a defect to report. So the check is loud in every state
// where its silence would be wrong, and silent only in the state where silence is the truth.
//
// ## It asks about the EDITION, never about the run
//
// `gh run list` would answer "did the workflow execute", and that is the wrong question by design. Both
// workflows schedule TWO crons and gate on London's actual hour, so the wrong half of the pair exits
// SUCCESSFULLY every single day — deliberately, so a correct no-op does not put a daily red mark on the
// repository. A run-based check therefore reads green while the gate hour matches neither cron and no
// edition has been published for a month. The edition is the outcome the board reads, so the edition is
// what this measures.
//
// ## Two causes, two sentences — they must never print the same word
//
// No edition has two very different explanations and they need opposite responses: the SCHEDULE has
// stopped (nobody is publishing), or the SUMMARY was never written (the gate refused correctly, and the
// pipeline is working exactly as specified). This reports which, by reading `docs/board/summaries/` for
// the days in question, and says so when it cannot tell.
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { REPO, ROOT, gh } from "./board-data.mjs";
import { editionDay } from "./board-discussion.mjs";

const ISSUE = "20";
const REPORT_WORKFLOW = "board-report.yml";

/**
 * THE WORKFLOWS THIS WATCHDOG GUARDS -- both of them, and this list exists because there was one.
 *
 * #590: `board-liveness.yml`'s own header has always said it watches BOTH -- *"`board-report.yml` and
 * `board-summary-check.yml` report their own refusals... Neither can report not running"* -- and this
 * file guarded only the first, through a single constant. **The header claimed two and the code guarded
 * one, in the one place whose entire job is noticing silence.** So on 2026-09-08 `board-summary-check.yml`
 * stopped running for nineteen hours, nothing said so, and the first anyone knew was the following
 * morning when a missing summary turned main's own tip red and blocked every PR in the repository.
 *
 * A LIST rather than a second constant, because a second constant is what the first one became.
 * `board-liveness.test.ts` derives the expected set from the workflow's own header prose and fails if the
 * two diverge again -- the fact-stated-twice remedy this repository prefers over remembering.
 */
export const GUARDED_WORKFLOWS = ["board-report.yml", "board-summary-check.yml"];

/**
 * Did this workflow's schedule run at all on a given London day, asked AFTER its last daily window?
 *
 * NOT A STALENESS THRESHOLD, and that distinction is the whole of #590. The obvious check -- "the newest
 * scheduled run is more than N hours old" -- would NOT have caught this: `board-summary-check.yml` fires
 * four daily crons whose largest legitimate gap is about 22 hours, so the nineteen-hour silence that cost
 * the repository a morning sits comfortably inside any honest threshold. A check calibrated to a cadence
 * cannot see a gap shorter than that cadence's own worst case.
 *
 * The answerable question is narrower and exact: the workflow is *supposed* to have run today, and it is
 * now past the hour by which it should have. `null` when the day is not yet over for that workflow, or
 * the lookup failed -- never `false`, because "not yet" and "did not" are the two answers this whole file
 * exists to keep apart.
 *
 * @param {{ runDays: string[] | null, today: string, londonHour: number, afterHour: number }} input
 *   `runDays`: the London dates of this workflow's scheduled runs. `afterHour`: the London hour by which
 *   a run must have happened.
 * @returns {boolean | null} true = it should have run today and did not
 */
export function missedTodaysWindow({ runDays, today, londonHour, afterHour }) {
  if (runDays === null) return null;
  if (londonHour < afterHour) return null;
  return !runDays.includes(today);
}

/**
 * The London dates of a workflow's SCHEDULED runs -- `null` if the lookup failed. Each is `editionDay`'s (#1355),
 * so a run and the edition it belongs to can never be filed under different days.
 * @param {string} workflowFile @returns {string[] | null}
 */
export function scheduledRunDays(workflowFile) {
  try {
    return JSON.parse(gh(["run", "list", "--repo", REPO, "--workflow", workflowFile,
      "--json", "event,createdAt", "--limit", "100"]))
      .filter((/** @type {{event: string}} */ r) => r.event === "schedule")
      .map((/** @type {{createdAt: string}} */ r) => editionDay(new Date(r.createdAt)));
  } catch {
    return null;
  }
}

/**
 * HAS THE SCHEDULE EVER FIRED, EVEN ONCE? — a SEPARATE, narrower question from everything above (#272).
 *
 * This file's own header argues against `gh run list` as the measure of a healthy edition, and that
 * argument stands: a run existing says nothing about whether it published, because the wrong half of
 * every day's cron pair exits successfully having done nothing. But #272 was not that -- `board-report.yml`
 * had ZERO runs of any kind beyond one hand dispatch, on EITHER of its two daily crons, the day after it
 * was added. The comment/summary inference above is blind to exactly this case: with no edition ever
 * published, `missedDays` only looks back `STALE_AFTER_DAYS`, and for a workflow under a day old that
 * window can span nothing but "too new to have a summary yet" -- which reads as ALIVE, not as evidence.
 *
 * So this asks GitHub directly whether the SCHEDULE TRIGGER has ever activated at all, independent of
 * what any run then did. `GRACE_HOURS` gives both daily windows (BST and GMT) a fair chance before
 * silence is read as death, rather than as the workflow simply not having reached its first window yet.
 */
const GRACE_HOURS = 36;

/**
 * When a workflow was first registered with GitHub, or `null` if the lookup failed.
 *
 * @param {string} workflowFile
 * @returns {string | null}
 */
export function workflowCreatedAt(workflowFile) {
  try {
    return JSON.parse(gh(["api", `repos/${REPO}/actions/workflows/${workflowFile}`])).created_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Every recorded run's `event` field for a workflow. `null` when the lookup itself failed -- never an
 * empty array standing in for it, which would read identically to "genuinely zero runs" and turn a
 * network blip into a false "the schedule has never fired".
 *
 * @param {string} workflowFile
 * @returns {string[] | null}
 */
export function workflowRunEvents(workflowFile) {
  try {
    // #1263: `status` COMES BACK TOO, because `gh run list` includes runs that have not finished --
    // a ghost run (#1253: `queued` forever, zero jobs) carries `event: "schedule"` and proves nothing
    // about whether the schedule ever RAN. The filtering is left to `scheduleNeverFired`, which is the
    // pure function a test can reach; doing it here would hide the decision in the fetcher.
    return JSON.parse(gh(["run", "list", "--repo", REPO, "--workflow", workflowFile,
      "--json", "event,status,conclusion", "--limit", "100"]));
  } catch {
    return null;
  }
}

/**
 * Pure: given a workflow's recorded run events and how long it has existed, has its SCHEDULE genuinely
 * never fired? `null` -- too new to judge, or a lookup failed -- is deliberately distinct from both other
 * answers: a workflow added an hour ago having no scheduled run yet is not evidence of anything, and a
 * failed lookup must never be read as either "fine" or "dead".
 *
 * @param {{ events: (string | { event: string, status?: string, conclusion?: string | null })[] | null,
 *          createdAt: string | null, now: Date, graceHours?: number }} args
 * @returns {boolean | null}
 */
export function scheduleNeverFired({ events, createdAt, now, graceHours = GRACE_HOURS }) {
  if (events === null || createdAt === null) return null;
  // #1263: ONLY A **COMPLETED** SCHEDULED RUN COUNTS AS "IT HAS FIRED".
  //
  // This read `events.includes("schedule")` over every run `gh run list` returns, finished or not. A
  // ghost run (#1253) is registered with its trigger's event and never runs, so one of them answered
  // `false` here -- "the schedule has fired" -- on the strength of a run that did nothing. Measured:
  //
  //   no scheduled run at all   -> true    ("never fired")
  //   one GHOST scheduled run   -> false   ("it has fired")     <- the defect
  //
  // A plain string is still accepted and read as completed, so the legacy shape does not silently
  // become "not fired" -- that would swap a false green for a false alarm, which is not an improvement.
  const fired = events.some((r) => (typeof r === "string" ? r : r.event) === "schedule"
    && (typeof r === "string" || r.conclusion != null));
  if (fired) return false;
  const hoursSinceCreated = (now.getTime() - Date.parse(createdAt)) / 3_600_000;
  if (hoursSinceCreated < graceHours) return null;
  return true;
}

/**
 * How many days without an edition before this is a finding rather than a gap.
 *
 * THREE, and the number is argued rather than picked. One is normal: the gate refuses an edition when no
 * summary was written, which is the pipeline working. Two spans a weekend. Three consecutive days with no
 * edition is longer than any refusal this pipeline is designed to produce, so it is the first count at
 * which "the schedule is dead" beats "a summary was skipped" as an explanation — and it still has to say
 * which, because the count alone cannot.
 */
const STALE_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;

/** Exit codes, and the third is the one that matters. */
/**
 * THE WORKFLOW FILE THIS PROCESS IS RUNNING INSIDE, or `null` when it is not running in Actions.
 *
 * #1154. `GITHUB_WORKFLOW_REF` is `owner/repo/.github/workflows/<file>@<ref>`; the basename is what
 * `gh run list --workflow` takes. Reading it is the whole point: a name read from the run cannot name a
 * workflow that no longer exists, which is the defect this row is about.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function hostWorkflowFile(env) {
  const ref = env?.GITHUB_WORKFLOW_REF;
  if (typeof ref !== "string" || ref.trim() === "") return null;
  // The ref is `<owner>/<repo>/.github/workflows/<file>@<ref>` and the ref half may itself contain `/`
  // (`refs/heads/main`), so the `@` is cut FIRST and the basename taken from what is left.
  //
  // FIRST `@`, not last -- a BRANCH NAME may contain one. worker-capture drove `.../ci.yml@refs/heads/
  // feature@2` through it: cutting at the last `@` takes `2` as the ref and leaves `ci.yml@refs/heads/
  // feature` as the path, which the pattern below then rejects, turning a valid run into UNKNOWN. The
  // three-red mutation on this line is that case.
  //
  // **A REUSABLE WORKFLOW RESOLVES TO THE CALLED FILE, NOT THE CALLER.** Inside `reusable-build-test.yml`
  // invoked by `ci.yml`, this returns `reusable-build-test.yml`. That is right for this guard -- the run
  // being reported on IS the reusable one -- and it is written down because a reader expecting the caller
  // would read the correct answer as a bug.
  const path = ref.split("@")[0];
  const file = path.slice(path.lastIndexOf("/") + 1);
  return /^[\w.-]+\.ya?ml$/.test(file) ? file : null;
}

/**
 * HOW LONG SINCE THIS WATCHDOG ITSELF LAST RAN, in hours -- `null` when the answer could not be had.
 *
 * #272. THIS CHECK RUNS ON `push` AND ONLY ON `push`, deliberately: a watchdog moved onto a cron is
 * disabled by the same repository inactivity it watches for, so `push` is the one trigger that cannot be
 * silenced by the condition it exists to detect. `board-liveness.test.ts` pins the absence of a
 * `schedule:` key for that reason.
 *
 * The cost of that choice is the gap this function closes: on a day nobody pushes to main, this check
 * does not run, and a missing edition goes unreported until the next push. Not noticed and nothing wrong
 * look identical from the outside -- which is the exact failure this whole file exists to end, turned on
 * the file itself.
 *
 * SO THE WATCHDOG REPORTS ITS OWN SILENCE rather than being given a second trigger. Two alternatives were
 * refused and the reasons are worth keeping: a `schedule:` contradicts the header and the pinned test,
 * and a second event trigger (`issues`, say) buys a workflow firing on every label change -- measured on
 * `ready-label-audit` the same day at 200 runs, 175 cancelled, 0 succeeded -- to cover a gap that has not
 * occurred once: `git log origin/main` shows a push on every one of the last 15 days.
 *
 * A number in the report costs one call and turns an unobservable absence into a printed line.
 *
 * @param {(args: string[]) => string} run
 * @param {Date} now
 * @returns {number | null}
 */
export function hoursSincePreviousRun(run, now, env = process.env) {
  // #1154: THE WORKFLOW IS READ FROM THE RUN, NEVER NAMED HERE.
  //
  // This asked for `board-liveness.yml` for eleven days after #901 deleted that workflow and folded its
  // steps into trunk-guard. **It did not fail.** GitHub keeps a deleted workflow's entity addressable by
  // path for ever, so the call returned 200 with the old run history, frozen at 2026-09-10T22:20:14Z --
  // and `watchdogSilenceLine` duly printed *"it last ran 42h ago ... so a quiet spell here means nobody
  // pushed"* while main took 538 pushes in that window. A real number, a rising trend, and a stated cause
  // that is flatly untrue and unfalsifiable from the report itself.
  //
  // The `catch` below would have caught a 404 and the `!previous` guard would have caught an empty list.
  // **The case GitHub actually produces is the one neither covers.**
  //
  // So the name is not written down. `GITHUB_WORKFLOW_REF` is what the run itself is executing, so it
  // cannot go stale under a rename, a move, or a fold into another workflow -- and when it is absent
  // (running outside Actions) the answer is UNKNOWN rather than a guess. A guessed name is what produced
  // the 42 hours: a wrong answer is worse here than no answer, because `watchdogSilenceLine` explains it.
  const workflow = hostWorkflowFile(env);
  if (!workflow) return null;
  /** @type {{ createdAt?: string }[]} */
  let runs;
  try {
    runs = JSON.parse(run(["run", "list", "--repo", REPO, "--workflow", workflow,
      "--json", "createdAt", "--limit", "2"]));
  } catch {
    return null;
  }
  // INDEX 1, NOT 0. The newest run is THIS one -- the check is reporting on itself while it runs -- so
  // index 0 would always answer "zero hours since the last run", a number that is true, useless, and
  // indistinguishable from a healthy answer. The one before it is the question.
  const previous = Array.isArray(runs) ? runs[1]?.createdAt : null;
  if (!previous) return null;
  const hours = (now.getTime() - new Date(previous).getTime()) / 3_600_000;
  return Number.isFinite(hours) ? hours : null;
}

/**
 * The line the report carries about the WATCHDOG rather than about the board -- `null` when there is
 * nothing worth saying.
 *
 * Past the threshold it reads as a warning about this check, because a reader who sees "editions are
 * arriving" has no way to know the sentence is a day old. Under it, the gap is stated plainly and without
 * alarm: a number a reader can weigh beats a reassurance they cannot.
 *
 * UNREADABLE SAYS SO. A failed lookup is not "it ran recently" -- the same rule this file applies to
 * every other absence.
 *
 * @param {number | null} hours @param {number} [thresholdHours]
 * @returns {string | null}
 */
export function watchdogSilenceLine(hours, thresholdHours = WATCHDOG_QUIET_HOURS) {
  if (hours === null) {
    return "This check could not read its own run history, so how long it has been silent is UNKNOWN. "
      + "Unknown is not recent.";
  }
  const rounded = Math.round(hours);
  if (hours >= thresholdHours) {
    return `WARNING ABOUT THIS CHECK, NOT ABOUT THE BOARD: it last ran ${rounded}h ago. It runs on push `
      + "to main and nothing else, so a quiet spell here means nobody pushed -- and a missing edition in "
      + "that window would have gone unreported until now.";
  }
  return `This check last ran ${rounded}h ago.`;
}

/**
 * How long this check may be silent before its own quiet is worth a warning. 26 hours rather than 24:
 * the board publishes daily, so a full day plus a margin is the first gap that cannot be explained by
 * ordinary timing drift between one push and the next.
 */
const WATCHDOG_QUIET_HOURS = 26;

export const EXIT = { ALIVE: 0, STOPPED: 1, CANNOT_TELL: 2 };

/** The first line every published edition carries: `# Board report — 2026-09-06`. */
const EDITION_HEADING = /^#\s*Board report\s*[—-]\s*(\d{4}-\d{2}-\d{2})/m;

/**
 * The date of the newest published edition, or null when no comment looks like one.
 *
 * PARSED FROM THE EDITION'S OWN HEADING, not from the comment's `createdAt`. A re-run, an edit, or a
 * backfill would give a comment a timestamp that does not describe the day it reports on — and the board
 * reads the heading, so the heading is what "the last edition" means.
 *
 * @param {string[]} bodies
 * @returns {string | null}
 */
export function newestEditionDay(bodies) {
  const days = bodies.map((body) => body.match(EDITION_HEADING)?.[1]).filter((d) => typeof d === "string");
  return days.length ? (days.sort().at(-1) ?? null) : null;
}

/** @param {string} day @param {Date} now @returns {number} */
export function daysSince(day, now) {
  return Math.floor((now.getTime() - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
}

/**
 * The days between the last edition and today, and whether each one had a summary written for it.
 *
 * This is what separates the two causes. A day with a summary and no edition accuses the SCHEDULE; a day
 * with neither accuses nobody — the gate refused exactly as designed.
 *
 * @param {{lastDay: string | null, now: Date, hasSummary: (day: string) => boolean}} options
 * @returns {{day: string, summary: boolean}[]}
 */
export function missedDays({ lastDay, now, hasSummary }) {
  const out = [];
  const start = lastDay ? Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS : now.getTime() - STALE_AFTER_DAYS * DAY_MS;
  for (let t = start; t < now.getTime(); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, summary: hasSummary(day) });
  }
  return out;
}

/**
 * The verdict, pure — so it is testable without a network, which is the only way a check about absence
 * can itself be shown to work. The IO around it is `main`.
 *
 * @param {{lastDay: string | null, now: Date, hasSummary: (day: string) => boolean}} options
 * @returns {{code: number, headline: string, detail: string}}
 */
export function livenessVerdict({ lastDay, now, hasSummary }) {
  const missed = missedDays({ lastDay, now, hasSummary });
  const withSummary = missed.filter((m) => m.summary);
  if (lastDay && daysSince(lastDay, now) < STALE_AFTER_DAYS) {
    return { code: EXIT.ALIVE, headline: `the last edition is ${lastDay}`, detail: "" };
  }
  // NO EDITION EVER is not the same as editions that stopped, and the remedies differ: the first is a
  // pipeline nobody has run, the second is one that has died. Named separately rather than collapsed.
  const since = lastDay
    ? `no board edition since ${lastDay} (${daysSince(lastDay, now)} days)`
    : "NO board edition has ever been published to this issue";
  if (!withSummary.length) {
    return { code: EXIT.ALIVE, headline: since,
      detail: "and no summary was written for any of those days, so the 08:00 gate refused exactly as it "
        + "is designed to. This is the pipeline working, not the schedule dying -- the missing thing is "
        + "the summary, which `board-summary-check.mjs` already warns about at 07:15 on the morning of the edition (the board moved it off 21:00 on 2026-09-08, `2a1bdd92`: a summary written the evening before is a forecast about a night that has not happened)." };
  }
  return { code: EXIT.STOPPED, headline: since,
    detail: `and a summary WAS written for ${withSummary.length} of those days `
      + `(${withSummary.map((m) => m.day).join(", ")}), so the gate had no reason to refuse. Something is `
      + "stopping the 08:00 job from publishing, and the first thing to check is whether GitHub has "
      + "disabled the schedule: a scheduled workflow is disabled after 60 days without repository "
      + "activity, silently, and produces no run and no red mark when it is.\n"
      + "  gh workflow list --repo " + REPO + "\n"
      + "  gh workflow enable board-report.yml --repo " + REPO };
}

/** @param {string} day */
const summaryExists = (day) => existsSync(path.join(ROOT, "docs/board/summaries", `${day}.md`));

/**
 * Every comment body on the report issue, or null when GitHub could not be asked.
 * @param {string} issue
 */
function commentBodies(issue) {
  try {
    return JSON.parse(gh(["issue", "view", issue, "--repo", REPO, "--json", "comments"]))
      .comments.map((/** @type {{body: string}} */ c) => c.body);
  } catch {
    // CANNOT ASK IS NOT ALIVE, and this is the whole reason the third exit code exists. A swallowed API
    // failure returning "no comments found" would report the editions as STOPPED on a network blip -- and
    // returning "alive" would report a dead schedule as healthy. Neither is honest, so it returns null and
    // the caller exits 2.
    return null;
  }
}

/**
 * One comment per stale spell, not one per push. A warning that repeats is a warning people filter.
 * @param {string} issue
 * @param {{code: number, headline: string, detail: string}} verdict
 */
function postOnce(issue, verdict) {
  const marker = `board editions: ${verdict.headline}`;
  const existing = gh(["issue", "view", issue, "--repo", REPO, "--json", "comments", "--jq",
    ".comments[].body"]);
  if (existing.includes(marker)) {
    console.error("(already reported for this spell; not commenting again)");
    return;
  }
  gh(["issue", "comment", issue, "--repo", REPO, "--body",
    `**${marker}**\n\n${verdict.detail}\n\n---\n\nReported by \`npm run board:liveness\`, which runs on `
    + "push rather than on a schedule: a watchdog that is itself scheduled is disabled by the same "
    + "inactivity it exists to detect."]);
}

function main() {
  refuseUnknownFlags(["--post", "--issue"],
    { entry: import.meta.url, command: "npm run board:liveness" });
  const argv = process.argv.slice(2);
  const issue = argv.find((a) => a.startsWith("--issue="))?.split("=")[1] ?? ISSUE;

  // GROUND TRUTH FIRST (#272): has the schedule ever fired at all? The comment/summary inference below is
  // blind to a workflow too young to have accumulated evidence in its own trailing window -- this asks
  // GitHub directly instead of inferring, and only when it has a DEFINITE answer does it short-circuit.
  const neverFired = scheduleNeverFired({
    events: workflowRunEvents(REPORT_WORKFLOW), createdAt: workflowCreatedAt(REPORT_WORKFLOW), now: new Date(),
  });
  if (neverFired === true) {
    const verdict = { code: EXIT.STOPPED,
      headline: `${REPORT_WORKFLOW}'s schedule has NEVER fired, on either daily cron`,
      detail: `Checked directly against GitHub's own run history (\`gh run list --workflow=${REPORT_WORKFLOW} `
        + `--json event\`), not inferred from editions -- a workflow this young has no comment/summary `
        + "trail to read yet, which is exactly the case the inference below cannot see. "
        + `https://github.com/${REPO}/issues/272 has the investigation.` };
    console.error(`${verdict.headline}\n  ${verdict.detail}`);
    if (argv.includes("--post")) postOnce(issue, verdict);
    process.exit(EXIT.STOPPED);
  }

  // #590: THE SECOND GUARDED WORKFLOW. `board-summary-check.yml` has no edition trail to infer from -- it
  // publishes nothing, it only warns -- so the comment/summary inference below cannot see it at all. It is
  // asked the one question that IS answerable about it: it should have run this morning, and it is now
  // past the hour by which it should have.
  const SUMMARY_WORKFLOW = "board-summary-check.yml";
  const SUMMARY_DEADLINE_HOUR = 8;   // 07:45 London is its last window; by 08:00 a run must exist
  const londonNow = new Date();
  const missed = missedTodaysWindow({
    runDays: scheduledRunDays(SUMMARY_WORKFLOW),
    today: editionDay(londonNow),
    londonHour: Number(new Intl.DateTimeFormat("en-GB",
      { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(londonNow)),
    afterHour: SUMMARY_DEADLINE_HOUR,
  });
  if (missed === true) {
    const verdict = { code: EXIT.STOPPED,
      headline: `${SUMMARY_WORKFLOW} did not run this morning`,
      detail: `Its four daily crons should have produced a scheduled run before ${SUMMARY_DEADLINE_HOUR}:00 `
        + "London and none exists for today. That check is the only thing that warns a summary is missing "
        + "BEFORE the edition refuses -- and on 2026-09-08 it went quiet for nineteen hours, which no "
        + "staleness threshold could have caught: its own largest legitimate gap is about 22 hours. The "
        + `missing summary then turned main's tip red and blocked every PR in the repository. `
        + `https://github.com/${REPO}/issues/590 has the measurement.` };
    console.error(`${verdict.headline}\n  ${verdict.detail}`);
    if (argv.includes("--post")) postOnce(issue, verdict);
    // NOT an early exit: `board-report.yml`'s own question is still unasked at this point, and one dead
    // workflow must not hide the other. Reported, then the file carries on.
  }

  const bodies = commentBodies(issue);
  if (bodies === null) {
    console.error(`could not read issue ${issue} on ${REPO}. This is INCONCLUSIVE, not healthy: whether `
      + "editions are still arriving is unknown, and reporting unknown as fine is how a check comes to "
      + "mean nothing. Check `gh auth status`.");
    process.exit(EXIT.CANNOT_TELL);
  }

  const verdict = livenessVerdict(
    { lastDay: newestEditionDay(bodies), now: new Date(), hasSummary: summaryExists });
  const say = verdict.code === EXIT.ALIVE ? console.log : console.error;
  say(`${verdict.headline}${verdict.detail ? `\n  ${verdict.detail}` : ""}`);
  // PRINTED IN EVERY STATE, including ALIVE. A reader who sees "editions are arriving" has no way to
  // know the sentence is a day old, and that is exactly the reader this line is for.
  const silence = watchdogSilenceLine(hoursSincePreviousRun(gh, new Date()));
  if (silence) say(`  ${silence}`);
  if (verdict.code === EXIT.STOPPED && argv.includes("--post")) postOnce(issue, verdict);
  process.exit(verdict.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
