#!/usr/bin/env node
// @ts-check
// command: check on the morning of an edition whether that day's hand-written board summary exists
// THE MORNING CHECK: is TODAY's executive summary written, 45 and 15 minutes before the edition?
//
// The 08:00 job refuses an edition with no hand-written summary for that day, which is correct and was
// approved -- a summary a machine wrote is the thing the board explicitly forbade. But a refusal at 08:00
// is a missing edition discovered at 08:00, by nobody, in a log. This puts the same gap in front of a
// person ELEVEN HOURS EARLIER, on the tracker the board already reads.
//
// IT GENERATES NO SUMMARY TEXT, and that is the whole point. It reports an absence; it does not fill one.
// The moment this script writes a sentence of summary, it has become the machine-written summary that the
// gate exists to prevent, arriving through the warning instead of through the document.
//
// IT ALSO ASKS THE SAME QUESTION OF `reported.json`, WHICH CARRIES MORE (#131). The summary is one
// hand-written paragraph; `docs/board/reported.json` holds every number the document quotes that no gate
// can recompute -- the gate outputs, the fleet-hours figure, the capacity note, every achievement. Both
// are read by the 08:00 job from `origin/main`, so both have the identical failure: a correct, complete
// record on the wrong side of a merge, which reads locally as done. That happened three times on
// 2026-09-06 -- a corrected achievement replacing one that had become FALSE, #22's pre-registered median,
// and the refreshed real-page gate output -- and each was found by a person typing `git show
// origin/main:...` by hand. None was found by a tool.
//
//   npm run board:summary-check            say whether TODAY's summary exists
//
// IT USED TO ASK ABOUT TOMORROW, AND THAT WAS RIGHT WHEN IT RAN AT 21:00. The board moved it on
// 2026-09-08 (`2a1bdd92`), in its own words: "it should be 30 mins before as it should be as fresh
// as possible as a lot happens over night." A summary written the evening before is a forecast
// about a night that has not happened -- measured on 8 September, the queue went from twelve open
// pull requests to zero between the summary being written and the edition rendering, and the
// forecast's own hedge was an instruction addressed to a person who would not be there at 03:00.
// So the evening run is RETIRED ON PURPOSE, not lost: do not restore it without taking that back
// to the board. `board-summary-check-schedule.test.ts` pins the morning hours for this reason.
//   npm run board:summary-check -- --post  and comment on the report issue if it does not
import { existsSync, readFileSync, readdirSync} from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { execFileSync } from "node:child_process";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { REPO, ROOT, gh, git, REPORTED_KINDS } from "./board-data.mjs";
import { editionDay } from "./board-discussion.mjs";

const ISSUE = "20";
const SUMMARY_WORDS = 120;
const REPORTED = "docs/board/reported";

/** Reassemble the directory into the ONE OBJECT the differ already understands (#159).
 *
 * `reportedDifferences` takes two JSON texts and names the entries that differ, keyed on `command` and
 * `issue`. That contract is right and its tests are the ones worth keeping green, so the directory is
 * assembled back into that shape rather than the differ being rewritten around a new one. The migration
 * changes where entries are STORED; it must not change what a reader is told.
 *
 * @param {(rel: string) => string | null} read
 * @param {string[]} paths
 */
export function assembleReported(read, paths) {
  /** @param {string} kind */
  const pick = (kind) => paths.filter((rel) => rel.includes(`/${kind}/`) && rel.endsWith(".json"))
    .map((rel) => { const text = read(rel); return text === null ? null : JSON.parse(text); })
    .filter((entry) => entry !== null)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  const metaPath = paths.find((rel) => rel.endsWith("/meta.json"));
  const metaText = metaPath ? read(metaPath) : null;
  return { ...(metaText ? JSON.parse(metaText) : {}), gates: pick("gates"),
    achievements: pick("achievements") };
}

/** Refused, but for a cause a person can act on tonight. */
const EXIT = { WILL_RENDER: 0, ACT_TONIGHT: 1, CANNOT_ASK: 2 };

/**
 * ONE FETCH PER RUN, AND THE REASON IS NOT ECONOMY.
 *
 * Two `git fetch`es can straddle a push, so two reads of "origin/main" become two reads of two different
 * commits -- and this file would then compare a summary from one and a record from another while calling
 * both `origin/main`. That is the "two correct counts over different windows" defect that `board-data`'s
 * own header records, arriving inside the check written to catch its sibling. The document is built once
 * for the same reason; so is the ref this one reads.
 *
 * A FAILED FETCH IS REMEMBERED AS A FAILURE, not retried per caller: a second attempt that happened to
 * succeed would leave one answer inconclusive and the other confident about the same instant.
 *
 * @type {{ ok: true } | { ok: false, why: string } | undefined}
 */
let fetchedOriginMain;

function fetchOriginMain() {
  if (fetchedOriginMain === undefined) {
    try {
      git(["fetch", "origin", "main", "--quiet"]);
      fetchedOriginMain = { ok: true };
    } catch (error) {
      fetchedOriginMain = { ok: false, why: `could not fetch origin/main: ${String(error).slice(0, 120)}` };
    }
  }
  return fetchedOriginMain;
}

/**
 * ONE TRACKED FILE, AS `origin/main` HAS IT — the only copy the 08:00 edition will ever see.
 *
 * `board-report.yml` checks out `ref: main` on a GitHub runner, so anything in a working tree or on an
 * unmerged branch does not exist as far as the edition is concerned.
 *
 * FETCHES FIRST, and that is not belt-and-braces. A remote-tracking ref is only as fresh as the last
 * fetch, so reading `origin/main` without one reproduces the identical defect one layer along: a
 * confident answer about a copy that has moved. Failing to fetch is INCONCLUSIVE rather than absent —
 * "I could not ask" and "it is not there" demand opposite responses, and only one of them is somebody's
 * fault.
 *
 * ONE READER, TWO CALLERS, deliberately. The summary and the record ask the identical question of the
 * identical remote, and two hand-written copies of that question are this repository's most-recorded
 * shape -- the second copy is the one that forgets to fetch.
 *
 * @param {string} relPath
 * @returns {{ text: string | null, asked: boolean, why: string }}
 */
/** The SAME question of a DIRECTORY, which `git show` cannot answer (#159).
 *
 * `reported.json` became `reported/`, one file per entry, because several agents record into it and
 * JSON is line-oriented to git -- two entries that disagree about nothing still conflicted. The
 * comparison this file exists for must survive that change, and it must survive it in the form that
 * makes it useful: naming WHICH ENTRIES differ, not that "the directory differs".
 *
 * `git show origin/main:<dir>` prints a tree listing, not content, so it would have compared two
 * listings and reported nothing when an entry's CONTENT moved. `ls-tree -r` then one `show` per blob is
 * the only shape that answers the real question.
 *
 * A FILE PRESENT ON ONE SIDE ONLY IS THE POINT, not an edge case: an entry recorded locally and never
 * pushed is exactly the state that reached the board three times on 2026-09-06.
 *
 * @param {string} relDir
 * @returns {{ files: Map<string, string> | null, asked: boolean, why: string }}
 */
function dirOnOriginMain(relDir) {
  const fetch = fetchOriginMain();
  if (!fetch.ok) return { files: null, asked: false, why: fetch.why };
  try {
    const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "origin/main", "--", relDir],
      { encoding: "utf8", cwd: ROOT, env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const paths = listing.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".json"));
    // AN EMPTY LISTING IS ABSENCE, and `ls-tree` reports it with exit 0 and no output rather than by
    // failing -- so the catch below never sees the commonest case: the directory is not on origin/main
    // at all. Found in review by running it against the real remote during this migration's own
    // aftermath, where it produced a fourteen-line wall of "X — in your tree, NOT on origin/main"
    // instead of the one line worth acting on. Git cannot track an empty directory, so "no entries" and
    // "no such path" are the same fact, and the honest answer is the shorter one.
    if (paths.length === 0) {
      return { files: null, asked: true, why: `no such directory on origin/main (origin/main:${relDir})` };
    }
    const files = new Map(paths.map((rel) => [rel,
      execFileSync("git", ["show", `origin/main:${rel}`],
        { encoding: "utf8", cwd: ROOT, env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] })]));
    return { files, asked: true, why: "read from origin/main" };
  } catch (error) {
    void error;
    return { files: null, asked: true, why: `no such directory on origin/main (origin/main:${relDir})` };
  }
}

/** @param {string} relPath */
function fileOnOriginMain(relPath) {
  const ref = `origin/main:${relPath}`;
  const fetch = fetchOriginMain();
  if (!fetch.ok) return { text: null, asked: false, why: fetch.why };
  try {
    // STDERR CAPTURED, not forwarded. `git show` on a path the ref does not carry writes
    // `fatal: path ... does not exist in 'origin/main'`, and `execFileSync` passes a child's stderr
    // through by default -- so the ORDINARY "not written yet" run printed a `fatal:` above its own
    // sentence. An expected state that prints a fatal error reads as a broken tool, and a tool that looks
    // broken on its normal path is one people stop believing. `sandboxGitEnv` is kept: an inherited
    // GIT_DIR would point this at another repository, which is the 2026-09-06 incident.
    const text = execFileSync("git", ["show", ref],
      { encoding: "utf8", cwd: ROOT, env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    return { text, asked: true, why: "read from origin/main" };
  } catch (error) {
    // `git show` fails the same way for "the ref has no such path" and for a broken repository. The first
    // is the finding; treating the second as the finding would report an unwritten file on a machine
    // that simply could not look, so the message carries what git said rather than swallowing it.
    void error;
    return { text: null, asked: true, why: `no such path on origin/main (${ref})` };
  }
}

/**
 * THE SUMMARY AS `origin/main` HAS IT.
 *
 * This check said *"the 08:00 edition will render"* on the strength of the local file. **Correct about
 * what it examined, and examining the wrong copy**: a gate that does not exercise what ships, where the
 * thing that ships is the version on `origin/main`.
 *
 * It cost twice in one evening (#91). A rewritten summary was committed locally and the push was refused
 * three times — a non-fast-forward, a worktree with no toolchain, and a real test failure — and each time
 * this check went on saying the edition would render. Separately a correction to a false achievement was
 * pushed to a branch while `origin/main` kept the false sentence, caught only because somebody ran
 * `git show origin/main:...` by hand.
 *
 * @param {string} day
 * @returns {{ text: string | null, asked: boolean, why: string }}
 */
const summaryOnOriginMain = (day) => fileOnOriginMain(`docs/board/summaries/${day}.md`);

/** @param {string} text */
const wordsIn = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * THE VERDICT, PURE — so the four states can be exercised without a network, a clock or a checkout.
 *
 * The IO is `summaryOnOriginMain` and `main`; everything decided here is a function of what those found.
 * That separation is what lets `board-summary-check.test.ts` drive the state this check exists for — a
 * summary present locally and absent from `origin/main` — which is otherwise reachable only by arranging
 * an unpushed commit at the moment the test runs.
 *
 * @param {{day: string, present: boolean, localText: string,
 *          remote: {text: string | null, asked: boolean, why: string}}} state
 * @returns {{code: number, message: string}}
 */
export function summaryVerdict({ day, present, localText, remote }) {
  if (!remote.asked) {
    return { code: EXIT.CANNOT_ASK,
      message: `CANNOT SAY whether the ${day} edition will render: ${remote.why}.\n`
        + "This is INCONCLUSIVE, not clear. The 08:00 job renders from `origin/main`, so a check that "
        + "could not read origin/main has not checked anything -- and reporting that as fine is how "
        + "'verified' comes to mean 'unexamined'. Re-run with a network, or read it by hand:\n"
        + `  git fetch origin main && git show origin/main:docs/board/summaries/${day}.md` };
  }

  const onMain = remote.text !== null && remote.text.trim().length > 0;
  if (onMain) {
    // THE LENGTH IS CHECKED HERE, NOT ONLY AT RENDER TIME, and the reason is a real trap. The render-time
    // gate reads TODAY's summary, so one written the evening before is the one nobody checks until the
    // morning it is due -- an over-length summary sits looking fine all night and refuses the edition at
    // 08:00, when nobody is awake to cut two words. Found by writing a 122-word summary and watching every
    // check pass. COUNTED ON THE REMOTE TEXT, because a local trim that was never pushed changes nothing.
    const words = wordsIn(/** @type {string} */ (remote.text));
    if (words > SUMMARY_WORDS) {
      return { code: EXIT.ACT_TONIGHT,
        message: `The summary for ${day} is ${words} words on origin/main, over the ${SUMMARY_WORDS}-word `
          + "cap.\nThe 08:00 edition will REFUSE it. Cut it now, while there is somebody awake to." };
    }
    // "IT IS ON MAIN" DOES NOT MEAN "WHAT YOU WROTE IS ON MAIN". The second 2026-09-06 incident was
    // exactly this: a correction pushed to a branch while origin/main kept the previous version. Both
    // files exist and both are non-empty, so only a comparison tells them apart.
    if (present && localText.trim() !== (remote.text ?? "").trim()) {
      return { code: EXIT.ACT_TONIGHT,
        message: `The ${day} summary on origin/main is NOT the one in your working tree `
          + `(${wordsIn(localText)} words local, ${words} on origin/main).\n`
          + "The 08:00 edition renders from origin/main, so it will publish the version you can see with:\n"
          + `  git show origin/main:docs/board/summaries/${day}.md\n`
          + "If your edit is the one that should ship, push it. If it is not, this is only a note." };
    }
    return { code: EXIT.WILL_RENDER,
      message: `summary for ${day} is on origin/main, ${words} words. The 08:00 edition will render.` };
  }

  // WRITTEN, AND NOT WHERE THE EDITION LOOKS. Its own refusal, because the remedy differs: the summary
  // exists and somebody has to PUSH it, which is not the same job as writing one.
  //
  // NO `--post` BRANCH FOR THIS STATE, deliberately, and it is not an omission. The scheduled workflow checks
  // out `main` on a runner, so there the working tree IS origin/main and this state cannot arise --
  // handling it there would be code that can never run. It is a LOCAL finding for the person who wrote
  // the summary, which is exactly who needs it.
  if (present) {
    return { code: EXIT.ACT_TONIGHT,
      message: `The ${day} summary exists in your working tree and NOT on origin/main `
        + `(${wordsIn(localText)} words, unpushed).\n`
        + "The 08:00 edition renders from origin/main, so as things stand it will REFUSE and there will "
        + "be no edition. This is the state where somebody must act tonight: push it.\n"
        + "Measured 2026-09-06: a push was refused three times for three unrelated reasons and this check "
        + "went on reporting that the edition would render, because it was reading the local file." };
  }
  return { code: EXIT.ACT_TONIGHT, message: "" };
}

/**
 * WHICH ENTRIES DIFFER, never a bare "the file differs".
 *
 * *"reported.json has changed"* sends a reader to diff it themselves; *"gates[npm run
 * rules:real-pages] differs"* tells them whether it matters in one line. This repo's own rule -- a count
 * is where an investigation stops -- applied to a comparison.
 *
 * KEYED ON EACH SECTION'S OWN IDENTITY FIELD, NOT ON ARRAY POSITION. Position-keyed identity is the
 * defect `withRealisticScale` already paid for: inserting one entry re-labels every entry after it, so a
 * single added gate would report the whole list as changed and the real difference would be one line in
 * a wall of noise. An item with no identity field falls back to its own content, which makes it
 * added/removed rather than changed -- honest, since there is nothing stable to call it by.
 *
 * COMPARED CANONICALLY, so a reformat is not a finding. The edition reads values; key order and
 * indentation are not values, and reporting them would train people to ignore the line.
 *
 * @param {string} localText
 * @param {string} remoteText
 * @returns {string[]}
 */
export function reportedDifferences(localText, remoteText) {
  const parsed = [["your tree", localText], ["origin/main", remoteText]].map(([where, text]) => {
    try {
      return { where, value: JSON.parse(text) };
    } catch (error) {
      return { where, value: null, broken: `${where}: ${REPORTED} is not valid JSON (${String(error).slice(0, 80)})` };
    }
  });
  const broken = parsed.filter((p) => p.broken).map((p) => /** @type {string} */ (p.broken));
  // UNREADABLE IS ITS OWN ANSWER. Diffing against a parse failure would report every entry as differing,
  // which is a true statement that hides the one fact worth acting on.
  if (broken.length > 0) return broken;
  return sectionDifferences(parsed[0].value, parsed[1].value);
}

/** Identity field per array section, so a difference names an ENTRY a reader recognises. */
const ARRAY_IDENTITY = /** @type {Record<string, string>} */ ({ gates: "command", achievements: "issue" });

/** Key order is not a value; this makes two spellings of one record compare equal.
 * @param {unknown} value */
const canonical = (value) => JSON.stringify(value, (_key, val) =>
  val && typeof val === "object" && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
    : val);

/**
 * @param {string} section
 * @param {unknown[]} items
 * @returns {Map<string, unknown>}
 */
function indexEntries(section, items) {
  const key = ARRAY_IDENTITY[section];
  /** @param {unknown} item */
  const named = (item) => (key && item && typeof item === "object" && /** @type {any} */ (item)[key] !== undefined
    ? String(/** @type {any} */ (item)[key]) : canonical(item));
  return new Map(items.map((item) => [named(item), item]));
}

/**
 * @param {string} section
 * @param {unknown[]} localItems
 * @param {unknown[]} remoteItems
 */
function arrayDifferences(section, localItems, remoteItems) {
  const mine = indexEntries(section, localItems);
  const theirs = indexEntries(section, remoteItems);
  /** @type {string[]} */
  const out = [];
  for (const [id, item] of mine) {
    if (!theirs.has(id)) out.push(`${section}[${id}] — in your tree, NOT on origin/main`);
    else if (canonical(theirs.get(id)) !== canonical(item)) out.push(`${section}[${id}] — differs`);
  }
  for (const id of theirs.keys()) {
    if (!mine.has(id)) out.push(`${section}[${id}] — on origin/main, NOT in your tree`);
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null} local
 * @param {Record<string, unknown> | null} remote
 */
function sectionDifferences(local, remote) {
  /** @type {string[]} */
  const out = [];
  for (const key of [...new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])]) {
    const mine = local?.[key];
    const theirs = remote?.[key];
    if (Array.isArray(mine) && Array.isArray(theirs)) out.push(...arrayDifferences(key, mine, theirs));
    else if (mine === undefined) out.push(`${key} — on origin/main, NOT in your tree`);
    else if (theirs === undefined) out.push(`${key} — in your tree, NOT on origin/main`);
    else if (canonical(mine) !== canonical(theirs)) out.push(`${key} — differs`);
  }
  return out;
}

/**
 * THE RECORD'S VERDICT, PURE — the same separation `summaryVerdict` uses, for the same reason: the state
 * this exists for (edited locally, unpushed) is otherwise reachable only by arranging an unpushed commit
 * at the moment the test runs.
 *
 * IT REPORTS; IT DOES NOT BLOCK A RENDER. Editing `reported.json` and not pushing yet is a normal working
 * state, sometimes for hours -- what must never happen is BELIEVING it is published. So this lands on
 * `ACT_TONIGHT`, which this file already defines as *"refused, but for a cause a person can act on
 * tonight"*: nothing is prevented, and the run does not read as clean while a number the board will see
 * sits unpushed. A refusal that stops a render belongs in `board:document`, which is the thing that
 * renders.
 *
 * @param {{localText: string | null, remote: {text: string | null, asked: boolean, why: string}}} state
 * @returns {{code: number, message: string}}
 */
export function reportedVerdict({ localText, remote }) {
  if (!remote.asked) {
    return { code: EXIT.CANNOT_ASK,
      message: `CANNOT SAY whether the recorded figures are published: ${remote.why}.\n`
        + `This is INCONCLUSIVE, not clear -- ${REPORTED} carries every number the document quotes that `
        + "no gate can recompute, and a check that could not read origin/main has not checked any of "
        + "them." };
  }
  if (remote.text === null) {
    return { code: EXIT.ACT_TONIGHT,
      message: `${REPORTED} is NOT on origin/main at all, so every figure it carries is unpublished and `
        + "the edition will print `not reported` for each. Push it." };
  }
  if (localText === null) {
    return { code: EXIT.ACT_TONIGHT,
      message: `${REPORTED} is on origin/main and absent from your working tree. The edition will render `
        + `from origin/main regardless; if you meant to delete it, that deletion is not pushed.` };
  }
  const differences = reportedDifferences(localText, remote.text);
  if (differences.length === 0) {
    return { code: EXIT.WILL_RENDER, message: `recorded figures: ${REPORTED} matches origin/main.` };
  }
  return { code: EXIT.ACT_TONIGHT,
    message: `${REPORTED} in your working tree is NOT what the 08:00 edition will read:\n`
      + differences.map((d) => `  ${d}`).join("\n")
      + "\nThe edition renders from origin/main. See what will actually publish with:\n"
      + `  git show origin/main:${REPORTED}\n`
      + "If your edit is the one that should ship, push it. If it is not, this is only a note." };
}

/** The date the NEXT 08:00 edition will render for. */
/**
 * THE EDITION BEING CHECKED IS TODAY'S, because this now runs on the MORNING of the edition rather than
 * the evening before. It used to return tomorrow, and that was correct for a 21:00 check: at 21:00 the
 * next edition is tomorrow's. At 07:15 the next edition is in forty-five minutes, and it is today's.
 *
 * The board asked for this: "it should be 30 mins before as it should be as fresh as possible as a lot
 * happens over night." A summary written the evening before is a forecast about a night that has not
 * happened, and every overnight merge makes it staler. Written at 07:30 it describes the state the
 * document will actually render from.
 */
function nextEditionDay(now = new Date()) {
  // LONDON's date, from the one definition every edition script shares (#1302). This file had its own copy,
  // `londonDay`, which was right while the render and the Discussion used UTC: two copies of "today".
  return editionDay(now);
}


/**
 * #1345: the month names a summary writes ("on 13 September"), derived from the platform rather than retyped.
 * `board-document.mjs` has its own `MONTHS`, and importing it would put that file's `gh` spawns in this file's
 * closure -- and it already imports this one.
 */
const MONTHS_IN_YEAR = 12;
const ANY_YEAR = 2000;
const MONTH_NAMES = Array.from({ length: MONTHS_IN_YEAR }, (_, month) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(Date.UTC(ANY_YEAR, month, 1)).toLowerCase());
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const MS_PER_MINUTE = 60_000;

/**
 * An instant as LONDON wall-clock minutes since 1970-01-01 00:00 on that wall clock, with its London year. The
 * date is `editionDay`'s, the one definition (#1302); only the hour and minute are read here, from the same
 * instant, so there is one clock read however many fields come from it.
 * @param {Date} now @returns {{ year: number, minutes: number }}
 */
function londonWallMinutes(now) {
  const day = editionDay(now);
  const [hour, minute] = new Intl.DateTimeFormat("en-GB",
    { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now).split(":").map(Number);
  const [year] = day.split("-").map(Number);
  return { year, minutes: Date.parse(`${day}T00:00:00Z`) / MS_PER_MINUTE + hour * MINUTES_PER_HOUR + minute };
}

/**
 * Pure: the writing time the summary CLAIMS, and how far it is from the moment given.
 *
 * EXPORTED SO IT CAN BE SHOWN TO FAIL. The style test reads TODAY's summary, so on any day before the
 * rule takes effect it returns early and the assertion inside it is never exercised -- a guard that
 * cannot be demonstrated on the day you write it is the shape this repository has shipped green four
 * times. Driving this function directly with fixtures is what makes the freshness check verified rather
 * than merely present.
 *
 * #1345: THE AGE IS THE MINUTES THAT PASSED. Compared "HH:MM" with "HH:MM", a summary written at 23:50 and read at
 * 00:30 was 1,400 minutes old. Given an instant, the stated "on D Month" places the time on its day and the age
 * crosses midnight; a day named more than a day AHEAD of now is last year's (31 December read on 1 January). A time
 * stated later than now stays its distance ahead, never wrapped into yesterday.
 *
 * STATED LIMIT: the difference is in London WALL-CLOCK minutes, so across the two nights the clocks change a
 * summary is aged one hour wrong in either direction. A text with no day, or an "HH:MM" `now` (which carries no
 * day), keeps the within-one-day age it always had.
 *
 * @param {string} text the summary's own text
 * @param {Date | string} now the render instant, or "HH:MM" in Europe/London
 * @returns {{ stated: string, driftMinutes: number } | null} null when no time is stated at all
 */
export function statedWritingTime(text, now) {
  const m = /written at (\d{2}):(\d{2})(?: on (\d{1,2}) ([a-z]+))?/i.exec(text);
  if (!m) return null;
  const [, hh, mm, day, monthName] = m;
  const stated = `${hh}:${mm}`;
  const statedOfDay = Number(hh) * MINUTES_PER_HOUR + Number(mm);
  if (typeof now === "string") {
    const [nowH, nowM] = now.split(":").map(Number);
    return { stated, driftMinutes: Math.abs((nowH * MINUTES_PER_HOUR + nowM) - statedOfDay) };
  }
  const wall = londonWallMinutes(now);
  const month = monthName ? MONTH_NAMES.indexOf(monthName.toLowerCase()) : -1;
  if (month < 0) return { stated, driftMinutes: Math.abs((wall.minutes % MINUTES_PER_DAY) - statedOfDay) };
  const statedIn = (/** @type {number} */ year) => Date.UTC(year, month, Number(day)) / MS_PER_MINUTE + statedOfDay;
  const statedAt = statedIn(wall.year) - wall.minutes > MINUTES_PER_DAY ? statedIn(wall.year - 1) : statedIn(wall.year);
  return { stated, driftMinutes: Math.abs(wall.minutes - statedAt) };
}

/**
 * Post the "no summary" comment, once per DAY rather than once per run -- a warning that repeats is a
 * warning people filter.
 *
 * EXTRACTED because `main` reached a complexity of 18 once the 07:15/07:45 modes were added on top of the
 * directory restructure: two changes each reasonable alone, and the limit is what noticed they had landed
 * in the same function. It does one thing at one level of abstraction, which is the rule the limit exists
 * to enforce rather than the number itself.
 *
 * @param {{ day: string, issue: string, reminder: boolean }} arg
 * @returns {boolean} whether a comment was written (false = already reported for this date)
 */
function postAbsence({ day, issue, reminder }) {
  const marker = `no summary for ${day}`;
  const existing = gh(["issue", "view", issue, "--repo", REPO, "--json", "comments",
    "--jq", ".comments[].body"]);
  if (existing.includes(marker)) {
    console.error("(already reported for this date; not commenting again)");
    return false;
  }
  gh(["issue", "comment", issue, "--repo", REPO, "--body",
    `**There is ${marker} (${day}), so today's 08:00 edition will refuse and no document will be `
    + "published.**\n\nThe summary is written by hand, by design: a summary a machine assembled from the "
    + "sections below it is what the board explicitly forbade, so there is no fallback and this warning "
    + `does not write one. It reports the absence ${reminder ? "forty-five minutes" : "fifteen minutes"} `
    + "before the edition renders, so a person can close it.\n\n"
    + `Write at most 120 words in \`docs/board/summaries/${day}.md\`, answering: are we on the date, what `
    + "changed since yesterday, what must the board decide today. **Do not restate a count the document "
    + "computes** — it goes stale between writing the summary and rendering the edition, which happened "
    + `on the first day.\n\n*Posted automatically at ${reminder ? "07:15" : "07:45"} London by the summary `
    + "check. It generates no summary text.*"]);
  console.error(`reported on https://github.com/${REPO}/issues/${issue}`);
  return true;
}

function main() {
  refuseUnknownFlags(["--post", "--issue", "--day", "--reminder"],
    { entry: import.meta.url, command: "npm run board:summary-check" });
  const argv = process.argv.slice(2);
  /** @type {(n: string) => string | undefined} */
  const flag = (n) => argv.find((a) => a.startsWith(`${n}=`))?.split("=").slice(1).join("=");

  const day = flag("--day") ?? nextEditionDay();
  const file = path.join(ROOT, "docs/board/summaries", `${day}.md`);
  const present = existsSync(file) && readFileSync(file, "utf8").trim().length > 0;

  const remote = summaryOnOriginMain(day);
  const verdict = summaryVerdict({
    day, present, localText: present ? readFileSync(file, "utf8") : "", remote,
  });

  // THE RECORD IS ASKED WHATEVER THE SUMMARY SAYS. They are independent facts about the same edition: a
  // summary that will render says nothing about whether the figures beside it are published, and a
  // missing summary does not make an unpushed gate result any less unpushed. Reporting only one of them
  // is how the other stays invisible, which is the whole of #131.
  const localDir = path.join(ROOT, REPORTED);
  const localPaths = existsSync(localDir)
    ? REPORTED_KINDS.flatMap((kind) => (existsSync(path.join(localDir, kind))
      ? readdirSync(path.join(localDir, kind)).map((f) => `${REPORTED}/${kind}/${f}`) : []))
      .concat(existsSync(path.join(localDir, "meta.json")) ? [`${REPORTED}/meta.json`] : [])
    : [];
  const remoteDir = dirOnOriginMain(REPORTED);
  const files = remoteDir.files;
  const reported = reportedVerdict({
    localText: existsSync(localDir)
      ? JSON.stringify(assembleReported((rel) => readFileSync(path.join(ROOT, rel), "utf8"), localPaths))
      : null,
    remote: {
      asked: remoteDir.asked, why: remoteDir.why,
      // BOUND ONCE. `remoteDir.files` was read three times inside one ternary, so `tsc` could not narrow
      // it past the null check -- and a reader cannot see that the three reads are the same object.
      text: files === null ? null
        : JSON.stringify(assembleReported((rel) => files.get(rel) ?? null, [...files.keys()])),
    },
  });

  if (verdict.message) {
    (verdict.code === EXIT.WILL_RENDER ? console.log : console.error)(verdict.message);
    (reported.code === EXIT.WILL_RENDER ? console.log : console.error)(reported.message);
    // SEVERITY WINS, and INCONCLUSIVE outranks a finding: "I could not check everything" must never leave
    // the run reading as clean. Both messages are printed either way, so nothing is lost to the code.
    process.exit(Math.max(verdict.code, reported.code));
  }

  (reported.code === EXIT.WILL_RENDER ? console.log : console.error)(reported.message);
  console.error(`NO SUMMARY FOR ${day}. The 08:00 edition will REFUSE and there will be no edition.\n`
    + `Write at most 120 words in docs/board/summaries/${day}.md, answering three things: are we on the `
    + "date, what changed since yesterday, what must the board decide today.\n"
    + "Do not restate a count the document computes -- it goes stale between writing this and rendering.");

  // TWO MODES, AND THEY MUST EXIT DIFFERENTLY. `--reminder` (07:15) reports the absence and exits 0: at
  // 07:15 the summary is not late, it is simply not written yet, and a red mark every morning for a
  // normal working state is how a signal gets ignored -- this file's own reasoning about the wrong-half
  // run, applied to the right-half one. Without `--reminder` (07:45) the absence is a REFUSAL, because
  // the 08:00 edition is fifteen minutes away and will refuse anyway; failing here says so while there
  // is still time to act.
  const reminder = argv.includes("--reminder");
  const exitCode = reminder ? 0 : 1;

  if (!argv.includes("--post")) process.exit(exitCode);

  const issue = flag("--issue") ?? ISSUE;
  postAbsence({ day, issue, reminder });
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
