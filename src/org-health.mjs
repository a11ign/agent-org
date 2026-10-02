// @ts-check
// THE ORG FIXES WHAT IT IS TOLD ABOUT AND DOES NOT LOOK (#2936, the chairman's "why isn't the agent org self healing ... surely
// the ceo should be optimising?", 2026-10-01). #2841, #2842, #2845, #2847, #2853 and #2882/#2912 each closed the exact instance
// the chairman's own session found; nothing asked "is anything landing".
//
// `org-stalled` fires only when NO other cause produced an order (`stalledOrder`: `if (orders.length > 0) return null`), so an org
// busy offering orders and landing nothing is invisible to it; `failingChecksOrder` wakes a PR's owner on the FIRST red and never
// asks whether that wake produced a fix. THIS IS THE QUESTION: four signals, read once per tick from state the gate already
// holds, each OFFERED to `ceo` as ONE judgment cause (`org-health`) with its numbers in the prompt, which is
// `org-routing-and-timers.md`'s rule for a health question: it goes in the gate, where it costs an API call and wakes the session
// WITH the answer, never a cron and never a standing model turn.
//
// THE FOUR SIGNALS AND THEIR THRESHOLDS, EACH FROM THE 14-DAY TABLE POSTED ON #2936 (2026-09-17..10-01), NOT GUESSED. A reading at
// a moment: re-derive before quoting.
//   no-merge-while-work-exists  N = 3 h     p97.7 of 647 merge gaps; 1.07 gaps/day over N, 0.57/day with a PR already open
//   red-pr-unattended           M = 120 min p95.7 of 462 red->next-run ages; at most 2.50 episodes/day (an upper bound)
//   ready-row-refused           75 ticks    NOT A PERCENTILE: the #2845 counter is 13 hours old, so it is structural -- 15 ticks for
//                                           `product-manager` plus one 2-hour judgment window; the row says to re-measure
//   primary-not-at-main         60 min      9 episodes in 14 days: seven of one tick and two of 20 h and 24 h (0.14/day)
//
// NO STATE OF ITS OWN. Every "first tripped" time is DERIVED from a fact the tick reads (the last merge plus N hours, the failing
// check's own time plus M minutes, the oldest commit the primary lacks plus 60 minutes), so the discriminator is stable across
// ticks without a file and a signal that clears simply stops being offered. The one exception is the refused-row signal, whose
// counter carries ticks and no time: it is keyed on the ROWS, for the reason given there.
//
// A READ THAT WAS REFUSED IS A STATED UNKNOWN, NEVER A CLEAR (#1286). Each reading is `tripped`, `clear` or `unknown`, and an
// unknown says why on stderr -- a line that repeats for a persistent refusal and is therefore offered by `repeating-lines.mjs`.
//
// A LEAF, RELATIVE IMPORTS ONLY, like `repeating-lines.mjs`: `work-gate.mjs` imports this, and it runs before any `npm ci`/build.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { sandboxGitEnv } from "./lib/git-env.mjs";
// A LEAF (`claim-labels.mjs` imports nothing), so the label is read from where it is declared, as `repeating-lines.mjs` does.
import { READY_LABEL } from "./claim-labels.mjs";

/** No PR merged for this long, with work that could merge, is the idle org the chairman found. See the table above. */
export const NO_MERGE_HOURS = 3;
/** A PR whose required check has been red this long with nobody on it. */
export const RED_PR_MINUTES = 120;
/** A Ready row the claim has refused this many consecutive ticks -- `UNCLAIMABLE_AFTER_TICKS` (15) plus one judgment window. */
export const REFUSED_TICKS = 75;
/** A primary checkout that has stood off `origin/main` this long. */
export const PRIMARY_STALE_MINUTES = 60;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
/** A span is quoted in minutes up to this many and in hours past it, `repeating-lines.mjs`'s `spanOf` rule. */
const HOURS_FROM_MINUTES = 120;
/** How much of a quoted refusal or a stderr reason a prompt keeps. */
const MAX_QUOTED_CHARS = 200;
const MAX_REASON_CHARS = 160;
/** The measured tick (`repeating-lines.mjs`'s `MINUTES_PER_TICK`): a streak of ticks is quoted in minutes only as "about". */
const MINUTES_PER_TICK = 2.1;
/** How many PRs or rows one prompt names before it says "and N more". */
const MAX_NAMED = 5;
/** The session every signal is offered to. */
const OFFERED_TO = "ceo";
/** How many merged PRs the last-merge read looks at: the newest-updated, which holds every merge of the last day or two. */
const MERGED_WINDOW = 20;

export const SIGNALS = Object.freeze({
  NO_MERGE: "no-merge-while-work-exists",
  RED_PR: "red-pr-unattended",
  REFUSED_ROW: "ready-row-refused",
  PRIMARY: "primary-not-at-main",
});

/**
 * @typedef {{ signal: string, status: "tripped" | "clear" | "unknown", detail: string, firstTrippedAt?: number | null,
 *             discriminator?: string, prompt?: string }} Reading
 * `detail` is one line: for `unknown` it is WHY, for `tripped` the numbers. `firstTrippedAt` is epoch ms, or `null` when the
 * signal's own source carries no time.
 */

/** @param {number} ms @returns {string} the UTC hour a time falls in, `2026-10-01T07`: the discriminator's resolution */
const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);
/** @param {number} ms */
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
/** @param {number} ms @param {number} now */
const ageText = (ms, now) => {
  const minutes = Math.max(0, Math.round((now - ms) / MS_PER_MINUTE));
  return minutes >= HOURS_FROM_MINUTES ? `${Math.round(minutes / MINUTES_PER_HOUR)} h` : `${minutes} min`;
};

/** @param {number} minutes @returns {number} hours to one decimal place */
const hoursOf = (minutes) => Math.round((minutes / MINUTES_PER_HOUR) * 10) / 10;

/** @param {string} signal @param {string} why @returns {Reading} */
const unknown = (signal, why) => ({ signal, status: "unknown", detail: why });
/** @param {string} signal @returns {Reading} */
const clear = (signal) => ({ signal, status: "clear", detail: "" });

/**
 * SIGNAL 1: NOTHING HAS LANDED FOR `NO_MERGE_HOURS` WHILE SOMETHING COULD.
 *
 * "Something could" is a green, unheld PR (the gate's own `shouldBeMerging`) or a Ready row an engineer is being offered. An idle
 * org with an empty queue is finished, not stalled, so the gap alone is never a trip. THE GAP IS TESTED FIRST: a merge inside N
 * hours is clear whatever the work reading says, so a refused work read cannot turn a healthy tick into an unknown.
 *
 * @param {{ now: number, lastMergedAt: number | null, work: { greenPrs: number, claimableRows: number } | null }} input
 * @returns {Reading}
 */
export function noMergeReading({ now, lastMergedAt, work }) {
  if (lastMergedAt === null) return unknown(SIGNALS.NO_MERGE, "the last merge could not be read, so the gap is not known");
  const tripAt = lastMergedAt + NO_MERGE_HOURS * MS_PER_HOUR;
  if (now < tripAt) return clear(SIGNALS.NO_MERGE);
  if (work === null) return unknown(SIGNALS.NO_MERGE, "no PR has merged for over the threshold, but what could merge was not read");
  if (work.greenPrs + work.claimableRows === 0) return clear(SIGNALS.NO_MERGE);
  return {
    signal: SIGNALS.NO_MERGE, status: "tripped", firstTrippedAt: tripAt, discriminator: `${SIGNALS.NO_MERGE}@${hourOf(tripAt)}`,
    detail: `${ageText(lastMergedAt, now)} since the last merge (${isoOf(lastMergedAt)}); ${work.greenPrs} green unheld PR(s) and `
      + `${work.claimableRows} claimable Ready row(s) exist`,
  };
}

/**
 * @typedef {{ number: number | string, owner: string | null, redSince: number | null, ownerCommentAts: number[] }} RedPr
 * One open PR whose required check has settled red. `owner` is `null` when NOBODY could be named (`ownerOfPr`'s last rung).
 * `redSince` is when the head's first failing check finished, `null` when no check carried a time. `ownerCommentAts` are the
 * times of comments from the account that opened the PR, all of them: the leaf asks which fall after the red began.
 */

/**
 * Is this red PR UNATTENDED once `RED_PR_MINUTES` have passed?
 *
 * NO PUSH IS ASSUMED BY CONSTRUCTION, and the reason is a fact about this repo: the head is the one that went red, and a push
 * makes a new head with a new run, so a PR still red on its head has had none (`update-branch-sweep.mjs` leaves a failing PR
 * alone, so a sweep cannot refresh it). THE OWNER'S COMMENT IS WHAT IS LEFT TO ASK. A PR WITH NO OWNER IS ALWAYS UNATTENDED: no
 * account is "its owner's", so a comment on it is not an owner's act and cannot excuse it (the 2026-10-01 case, #2941).
 * @param {RedPr} pr @param {number} now
 */
function isUnattended(pr, now) {
  if (pr.redSince === null || now - pr.redSince < RED_PR_MINUTES * MS_PER_MINUTE) return false;
  if (pr.owner === null) return true;
  const since = pr.redSince;
  return !pr.ownerCommentAts.some((at) => at >= since);
}

/**
 * SIGNAL 2: A RED PR NOBODY IS ON. `failingChecksOrder` woke the owner on the first red, and nothing asks whether that produced
 * a fix. `redPrs` is `null` for a refused PR read; one PR with no time makes the answer unknown unless another PR trips.
 * @param {{ now: number, redPrs: RedPr[] | null }} input
 * @returns {Reading}
 */
export function redPrReading({ now, redPrs }) {
  if (redPrs === null) return unknown(SIGNALS.RED_PR, "the open pull requests could not be read");
  const tripped = redPrs.filter((pr) => isUnattended(pr, now)).sort((a, b) => /** @type {number} */ (a.redSince) - /** @type {number} */ (b.redSince));
  if (tripped.length === 0) {
    const undated = redPrs.filter((pr) => pr.redSince === null);
    return undated.length === 0 ? clear(SIGNALS.RED_PR)
      : unknown(SIGNALS.RED_PR, `${undated.length} red PR(s) carried no check time, so how long they have been red is not known`);
  }
  const first = /** @type {number} */ (tripped[0].redSince) + RED_PR_MINUTES * MS_PER_MINUTE;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (red ${ageText(/** @type {number} */ (pr.redSince), now)}, `
    + `${pr.owner === null ? "NO OWNER" : `owner ${pr.owner}`})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.RED_PR, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.RED_PR}@${hourOf(first)}`,
    detail: `${tripped.length} PR(s) red over ${RED_PR_MINUTES} min with no comment from their owner since: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 3: A READY ROW THE CLAIM HAS REFUSED `REFUSED_TICKS` TICKS RUNNING. THE COUNTER IS #2845's, READ AND NOT RECOUNTED: it
 * is the streak `claimRefusalStreaksNow` already advanced this tick, and `product-manager` was told at 15 of them.
 *
 * KEYED ON THE ROW REFS, NOT AN HOUR, because the counter carries ticks and no time: an hour derived from `now` minus the ticks
 * drifts by a tick's jitter and would re-ask across an hour boundary. The set of refs changes only when a row enters or leaves.
 * @param {{ refusals: Record<string, { reason: string, ticks: number }> | null }} input
 * @returns {Reading}
 */
export function refusedRowReading({ refusals }) {
  if (refusals === null) return unknown(SIGNALS.REFUSED_ROW, "the claim-refusal counter was not read");
  const over = Object.entries(refusals).filter(([, seen]) => seen.ticks >= REFUSED_TICKS).sort(([a], [b]) => a.localeCompare(b));
  if (over.length === 0) return clear(SIGNALS.REFUSED_ROW);
  const named = over.slice(0, MAX_NAMED).map(([ref, seen]) => `${ref} (${seen.ticks} ticks, about ${hoursOf(seen.ticks * MINUTES_PER_TICK)} h): `
    + `${seen.reason.replace(/\s+/g, " ").slice(0, MAX_QUOTED_CHARS)}`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.REFUSED_ROW, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.REFUSED_ROW}@${over.map(([ref]) => ref).join(",")}`,
    detail: `${over.length} Ready row(s) refused over ${REFUSED_TICKS} ticks: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 4: THE PRIMARY CHECKOUT HAS STOOD OFF `origin/main` FOR `PRIMARY_STALE_MINUTES`. `primary-stale` already tells `ceo` on
 * the tick it appears (#2781) and is CONSUMED here, not rebuilt: this adds the AGE, which is what says that the first telling did
 * not produce a fix. `drift` is `null` when the primary could not be asked (a linked worktree, CI, a git refusal), and `since` is
 * `null` when the drift carried nothing to date it by.
 * @param {{ now: number, drift: { behind: number, ahead: number, dirty: string[] } | null, since: number | null }} input
 * @returns {Reading}
 */
export function primaryReading({ now, drift, since }) {
  if (drift === null) return unknown(SIGNALS.PRIMARY, "the primary checkout could not be asked (a linked worktree, CI, or git refused)");
  if (drift.behind === 0 && drift.ahead === 0 && drift.dirty.length === 0) return clear(SIGNALS.PRIMARY);
  if (since === null) return unknown(SIGNALS.PRIMARY, "the primary is off origin/main but nothing dated how long");
  const tripAt = since + PRIMARY_STALE_MINUTES * MS_PER_MINUTE;
  if (now < tripAt) return clear(SIGNALS.PRIMARY);
  return { signal: SIGNALS.PRIMARY, status: "tripped", firstTrippedAt: tripAt, discriminator: `${SIGNALS.PRIMARY}@${hourOf(tripAt)}`,
    detail: `the primary has been off origin/main for ${ageText(since, now)} (since ${isoOf(since)}): ${drift.behind} commit(s) behind, `
      + `${drift.ahead} ahead, ${drift.dirty.length} dirty tracked path(s)` };
}

/**
 * WHEN THE PRIMARY STOPPED BEING CURRENT: the committer date of the oldest commit `origin/main` has that HEAD lacks, else the
 * oldest modified time among its dirty tracked files. INFERRED from git and the filesystem, not logged: nothing records the moment
 * `primary:update` first failed. `null` when neither can be read.
 * @param {{ behind: number, dirty: string[] } | null} drift
 * @param {{ root: string, run?: (args: string[]) => string, mtimeOf?: (path: string) => number }} where
 * @returns {number | null}
 */
export function primaryStandingSince(drift, { root, run = (args) => execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  mtimeOf = (path) => statSync(`${root}/${path}`).mtimeMs }) {
  if (drift === null) return null;
  const times = [];
  try {
    if (drift.behind > 0) times.push(Date.parse(run(["log", "--reverse", "--max-count=1", "--format=%cI", "HEAD..refs/remotes/origin/main"]).trim()));
    for (const path of drift.dirty) times.push(mtimeOf(path));
  } catch {
    return null; // a read that failed is not an age
  }
  const known = times.filter(Number.isFinite);
  return known.length > 0 ? Math.min(...known) : null;
}

/**
 * THE LAST MERGE, as epoch ms, or `null`. ONE REST CALL on the core pool: the newest-UPDATED closed PRs, of which the latest
 * `merged_at` is the answer (merging updates the PR, so every recent merge is among them). `null` -- refused, unparseable, or no
 * merged PR in the window -- is a stated unknown, never "long ago": a refusal says nothing about when the last merge was.
 * @param {(args: string[]) => string} run @param {string} repo
 * @returns {number | null}
 */
export function readLastMergedAt(run, repo) {
  try {
    const out = run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MERGED_WINDOW}`,
      "--jq", "[.[] | select(.merged_at != null) | .merged_at] | max"]);
    // `gh --jq` prints a string RAW (no quotes) and the word `null` for an empty list, both of which `Date.parse` reads as NaN or a time.
    const at = Date.parse(out.trim());
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * ALL FOUR READINGS, in a fixed order.
 * @param {{ now: number, lastMergedAt: number | null, work: { greenPrs: number, claimableRows: number } | null, redPrs: RedPr[] | null,
 *           refusals: Record<string, { reason: string, ticks: number }> | null,
 *           drift: { behind: number, ahead: number, dirty: string[] } | null, primarySince: number | null }} facts
 * @returns {Reading[]}
 */
export function orgHealthReadings(facts) {
  return [noMergeReading(facts), redPrReading(facts), refusedRowReading(facts),
    primaryReading({ now: facts.now, drift: facts.drift, since: facts.primarySince })];
}

/** What a prompt says about each signal, in the chairman's words where they have them. */
const REMEDY = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  [SIGNALS.NO_MERGE]: "Nothing is landing while something could. Find which link is stuck (a green PR with no approval, an engineer pool that "
    + "cannot claim, a queue ruleset, a stopped tick), then FIX IT or FILE IT `" + READY_LABEL + "` WITH AN OWNER in this turn.",
  [SIGNALS.RED_PR]: "A red PR was ordered to its owner on its first red and nothing came of it. Read why (`gh pr checks <n>`), then fix it, "
    + "re-lane it by putting the label of a session that can on the PR (`pr-checks-failing` names the label shape), or close it if it is abandoned.",
  [SIGNALS.REFUSED_ROW]: "`product-manager` was told at 15 ticks and the claim is still refused. The refusal text is quoted: read whose tree "
    + "it is (`pnpm run worktree:whose -- <path>`), and free the row or take it off the shelf.",
  [SIGNALS.PRIMARY]: "`primary-stale` told you when this began and the primary is still behind. Every order the gate gives is given from the "
    + "primary's code, so the org has been running stale for this long: follow `primary-stale`'s own steps (save the diff first).",
}));

/**
 * ONE ORDER PER TRIPPED SIGNAL, to `ceo`, the numbers in the prompt. THE PROMPT CARRIES THE OTHER TRIPPED SIGNALS, because a
 * session is delivered one order per tick (`repeating-lines.mjs`' reason). An unknown or clear reading emits nothing here.
 * @param {Reading[]} readings
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function orgHealthOrders(readings) {
  const tripped = readings.filter((r) => r.status === "tripped");
  return tripped.map((r) => {
    const others = tripped.filter((o) => o !== r).map((o) => o.signal);
    const when = r.firstTrippedAt ? ` It first tripped at ${isoOf(r.firstTrippedAt)}.` : "";
    return {
      session: OFFERED_TO,
      cause: "org-health",
      subject: r.signal,
      discriminator: /** @type {string} */ (r.discriminator),
      prompt: `ORG HEALTH: \`${r.signal}\` HAS TRIPPED. ${r.detail}.${when}\n${REMEDY[r.signal]}\n`
        + "This is asked because the org fixes what it is told about and does not look (the chairman, 2026-10-01): leave the place "
        + "better than you found it, and say on #928 what you found and did. It holds for two hours unchanged and stops when the "
        + `condition clears.${others.length > 0 ? `\nALSO TRIPPED (${others.length}): ${others.join(", ")}.` : ""}`,
      causeKey: `${OFFERED_TO}/org-health/${r.discriminator}`,
    };
  });
}

/**
 * THE WHOLE TICK: say each unknown on stderr, return the orders. NEVER THROWS -- a detector that can crash the gate stops every
 * order behind it (`repeatingLinesTick`'s rule). Only unknowns are written: a tripped signal's report is its order, and a
 * line written every tick for a standing condition would be offered by `repeating-lines.mjs` as a fault of its own.
 * @param {Parameters<typeof orgHealthReadings>[0]} facts
 * @param {{ log?: (line: string) => void }} [io]
 */
export function orgHealthTick(facts, { log = (line) => process.stderr.write(line) } = {}) {
  try {
    const readings = orgHealthReadings(facts);
    for (const r of readings) if (r.status === "unknown") log(`org-health: ${r.signal} UNKNOWN -- ${r.detail}; it is not read as clear.\n`);
    return orgHealthOrders(readings);
  } catch (err) {
    log(`org-health: could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no order this tick.\n`);
    return [];
  }
}
