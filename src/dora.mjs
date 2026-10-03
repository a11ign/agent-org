#!/usr/bin/env node
// @ts-check
// command: dora -- the four DORA metrics, per repository, from the registry and GitHub (a11ign/a11ign#3135, ADR 0041 decision 7).
//
// WHY NOT FROM THE ORG'S OWN STATE: an org that reports its own deployment frequency from its own ledger can report a good day while nothing shipped.
// Every number here is read from where the world keeps it -- the npm registry's `time` map or a repository's GitHub Releases, its merged pull requests,
// its `regression` rows, and git ancestry -- and `agent-org` names no project, so WHICH repositories and WHERE each is read come from the project's
// declaration (`.agent-org/project.json`, field `dora`, read by `project-config.mjs`).
//
// THE FOUR (definitions ruled by `ceo`; `DORA_METRICS` below is the ONE table, so a number printed with no direction cannot be written):
//   1. Deployment frequency: releases per UTC day. Higher is better; the target is one on any day a releasable change merged.
//   2. Lead time for changes: merge -> publish of the FIRST release that CONTAINS the merge commit (ancestry, not guesswork), for each merged pull
//      request that touched a releasable path. An unreleased merge is counted with its CURRENT age and marked unreleased: a 14-day wait is a number.
//   3. Change failure rate: releases later deprecated, or followed within 24 hours by a release that closes a `regression` row, over releases.
//   4. Time to restore: the opening of that `regression` row to the publish of the release that closes it (still-open rows at their current age).
//
// A REFUSED READ IS `unknown`, NEVER 0 (#1286), AND AN EMPTY ANSWER TO EVERYTHING IS A REFUSED READ: a repository with a history is never empty in both
// its releases and its merged pull requests, so a reader that returns `[]` for both has read nothing. `undefined` is a third state, not a failure: a
// metric with nothing to measure (no regression ever opened) is undefined, and is never printed as 0 either.
//
// A LEAF: it imports nothing from the tool, so `org-retro.mjs` can import it and the test can run it with injected readers and no network.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** What an unreadable source prints. Never `0`. */
export const UNKNOWN = "unknown";

/** The trailing window every metric covers, and the unit of the baseline (a11ign: 1 release in 14 days at filing). */
export const LOOKBACK_DAYS = 14;
/** Below this many releases a failure RATE is a handful of events, and the report says so beside it instead of calling it a trend. */
export const MIN_RELEASES_FOR_A_RATE = 5;
/** A release that closes a `regression` row within this long after another release marks that one as having failed. */
export const FAILURE_FOLLOW_HOURS = 24;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const PERCENT = 100;
/** `gh pr list --json files` returns the first 100: a pull request showing that many may have touched more, so it is treated as releasable. */
const FILES_PAGE = 100;
const SHA_LENGTH = 40;
/** An npm registry document for a long-lived package is large. */
const MAX_BUFFER = 256 * 1024 * 1024;
const READ_TIMEOUT_SECONDS = 60;

/**
 * @typedef {{ repo: string, release: { kind: "npm", package: string } | { kind: "tag" }, releasablePaths: string[] }} Repository
 * @typedef {{ id: string, publishedAt: string, commit: string | null, deprecated: boolean }} Release `commit` is null when it could not be resolved, and for a release older than the window, which no change in it can be in
 * @typedef {{ number: number, mergedAt: string, mergeCommit: string | null, paths: string[] | null }} MergedPr `paths` null: the file list was truncated
 * @typedef {{ number: number, openedAt: string, closedAt: string | null, fixCommit: string | null, fixMergedAt: string | null }} Regression `fixCommit`: the merge commit of the pull request that closed it, merged at `fixMergedAt`
 * @typedef {{ releases: (r: Repository, window: { since: string }) => Release[] | null,
 *   mergedPrs: (r: Repository, window: { since: string | null }) => MergedPr[] | null,
 *   regressions: (r: Repository, window: { since: string }) => Regression[] | null,
 *   range: (r: Repository, commits: { base: string, head: string }) => Range | null }} Readers
 * @typedef {{ status: string, commits: string[] }} Range GitHub's compare of `base...head`: `status` is `ahead`/`identical` when `base` is in `head`'s history, `behind`/`diverged` when it is not;
 *   `commits` are the commits in `head`'s history that are not in `base`'s, so a commit is in `head` exactly when it is in that list or is `base` itself
 * Every reader answers `null` (or throws) for a read that was REFUSED, and `[]` only for a read that found nothing.
 */

// ---------------------------------------------------------------------------------------------------------------------
// PURE: the metrics, from what the readers returned.

/** @param {number[]} numbers @returns {number | null} `null` for none, never `0` */
function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {number} ms @returns {string} the UTC date, `YYYY-MM-DD` */
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @template T @param {() => T | null} read @returns {T | null} a read that throws is a refused one */
function attempt(read) {
  try {
    return read();
  } catch {
    return null; // a refused read is `unknown` in the report, which says so; the cause is not narrated per read
  }
}

/** @param {MergedPr} pr @param {Repository} repository @returns {boolean} a truncated file list cannot show the change was NOT releasable, so it counts */
const isReleasable = (pr, repository) => pr.paths === null || pr.paths.length >= FILES_PAGE || pr.paths.some((path) => repository.releasablePaths.some((prefix) => path.startsWith(prefix)));

/**
 * Releases ordered by publish time, or `null` when any release has no readable time (an order cannot be trusted).
 * @param {Release[]} releases @returns {(Release & { at: number })[] | null}
 */
function ordered(releases) {
  const stamped = releases.map((release) => ({ ...release, at: Date.parse(release.publishedAt) }));
  return stamped.some((release) => Number.isNaN(release.at)) ? null : stamped.sort((a, b) => a.at - b.at);
}

/**
 * ANCESTRY, ASKED ONCE PER RELEASE AND NOT ONCE PER CHANGE (measured 2026-10-03: a call per merged pull request took 3m49s for one repository with 623 changes,
 * and this runs inside the work gate's tick). `base` is the OLDEST commit anyone will ask about; a release's `range` from it lists every commit in the release
 * that is not in `base`, which answers every later question about that release from memory. Sound because the merged history is linear on the default branch (a
 * change merged later descends from one merged earlier), so a release that does not contain `base` contains none of the later changes either.
 * @param {{ repository: Repository, readers: Readers, base: string | null }} input
 * @returns {(release: Release, commit: string) => boolean | null} `null` when the range could not be read: never read as `false`
 */
function ancestryOf({ repository, readers, base }) {
  /** Keyed by COMMIT: a backport and the release it was cut beside can point at one commit, and the range is the commit's. @type {Map<string, { status: string, commits: Set<string> } | null>} */
  const ranges = new Map();
  const rangeOf = (/** @type {Release} */ release) => {
    const head = release.commit;
    if (head === null || base === null) return null;
    if (!ranges.has(head)) {
      const range = attempt(() => readers.range(repository, { base, head }));
      ranges.set(head, range === null ? null : { status: range.status, commits: new Set(range.commits) });
    }
    return ranges.get(head) ?? null;
  };
  return (release, commit) => {
    const range = rangeOf(release);
    if (range === null) return null;
    return commit === base ? range.status === "ahead" || range.status === "identical" : range.commits.has(commit);
  };
}

/**
 * The first release that CONTAINS `commit`. A release published before `notBefore` cannot contain it, so it is not asked.
 * `unreadable` is a question that could not be answered: it is never read as "no release contains it", which would make a change look unreleased.
 * @param {{ commit: string | null, notBefore: number, releases: (Release & { at: number })[], windowStart: number, contains: ReturnType<typeof ancestryOf> }} query
 * @returns {{ release: (Release & { at: number }) | null, unreadable: boolean }}
 */
function firstContaining({ commit, notBefore, releases, windowStart, contains }) {
  if (commit === null) return { release: null, unreadable: true };
  for (const release of releases.filter((candidate) => candidate.at >= notBefore)) {
    if (release.commit === null) {
      if (release.at >= windowStart) return { release: null, unreadable: true }; // a recent release we cannot place might be the one
      continue;
    }
    const contained = contains(release, commit);
    if (contained === null) return { release: null, unreadable: true };
    if (contained) return { release, unreadable: false };
  }
  return { release: null, unreadable: false };
}

/** @typedef {Omit<Parameters<typeof firstContaining>[0], "commit" | "notBefore">} Context what every ancestry question shares */

/** @param {number} now @returns {string[]} the `LOOKBACK_DAYS` UTC dates ending with today's, oldest first */
function windowDates(now) {
  return Array.from({ length: LOOKBACK_DAYS }, (_, back) => utcDate(now - (LOOKBACK_DAYS - 1 - back) * MS_PER_DAY));
}

/**
 * Deployment frequency: releases in the window, per UTC day, and the days a releasable change merged and nothing shipped (today excluded: it is not over).
 * @param {{ releases: (Release & { at: number })[], releasable: MergedPr[] | null, now: number }} input
 */
function deploymentFrequency({ releases, releasable, now }) {
  const dates = windowDates(now);
  const inWindow = releases.filter((release) => dates.includes(utcDate(release.at)) && release.at <= now);
  const perDay = Object.fromEntries(dates.map((date) => [date, inWindow.filter((release) => utcDate(release.at) === date).length]));
  const mergedDays = releasable === null ? null : new Set(releasable.map((pr) => utcDate(Date.parse(pr.mergedAt))));
  const missedDays = mergedDays === null ? null : dates.filter((date) => date !== utcDate(now) && mergedDays.has(date) && perDay[date] === 0);
  return { value: inWindow.length, releases: inWindow, perDay, missedDays, undefinedBecause: null };
}

/**
 * Lead time: merge -> the first release containing the merge commit; an unreleased merge at its current age. Median and maximum over all of them.
 * @param {{ releasable: MergedPr[], context: Context, now: number }} input
 * @returns {{ block: object | null, reason: string | null }} `block` null with a reason when any ancestry could not be read
 */
function leadTime({ releasable, context, now }) {
  /** @type {number[]} */ const minutes = [];
  /** @type {{ number: number, minutes: number }[]} */ const unreleased = [];
  for (const pr of releasable) {
    const mergedAt = Date.parse(pr.mergedAt);
    const { release, unreadable } = firstContaining({ ...context, commit: pr.mergeCommit, notBefore: mergedAt });
    if (unreadable) return { block: null, reason: `ancestry of #${pr.number} could not be read` };
    if (release === null) unreleased.push({ number: pr.number, minutes: (now - mergedAt) / MS_PER_MINUTE });
    else minutes.push((release.at - mergedAt) / MS_PER_MINUTE);
  }
  const all = [...minutes, ...unreleased.map((u) => u.minutes)];
  const oldest = unreleased.length === 0 ? null : Math.max(...unreleased.map((u) => u.minutes));
  return { block: { medianMinutes: median(all), maxMinutes: all.length === 0 ? null : Math.max(...all), changes: all.length, unreleased: unreleased.length, oldestUnreleasedMinutes: oldest,
    undefinedBecause: all.length === 0 ? `no releasable change merged in the last ${LOOKBACK_DAYS} days` : null }, reason: null };
}

/**
 * For each regression row: the release that closes it (the first containing its fix commit), or none yet.
 * @param {{ regressions: Regression[], context: Context }} input
 * @returns {{ rows: { regression: Regression, fix: (Release & { at: number }) | null }[] | null, reason: string | null }}
 */
function fixingReleases({ regressions, context }) {
  const rows = [];
  for (const regression of regressions) {
    if (regression.fixCommit === null) { rows.push({ regression, fix: null }); continue; }
    const notBefore = Date.parse(regression.fixMergedAt ?? regression.openedAt);
    const { release, unreadable } = firstContaining({ ...context, commit: regression.fixCommit, notBefore: Number.isNaN(notBefore) ? 0 : notBefore });
    if (unreadable) return { rows: null, reason: `ancestry of the fix for regression #${regression.number} could not be read` };
    rows.push({ regression, fix: release });
  }
  return { rows, reason: null };
}

/**
 * Change failure rate over the window's releases: deprecated, or followed within `FAILURE_FOLLOW_HOURS` by a release that closes a regression row.
 * @param {{ inWindow: (Release & { at: number })[], fixes: (Release & { at: number })[] }} input
 */
function changeFailure({ inWindow, fixes }) {
  const followed = (/** @type {Release & { at: number }} */ release) => fixes.some((fix) => fix.at > release.at && fix.at - release.at <= FAILURE_FOLLOW_HOURS * MS_PER_HOUR);
  const failed = inWindow.filter((release) => release.deprecated || followed(release));
  const rate = inWindow.length === 0 ? null : Math.round((PERCENT * failed.length) / inWindow.length);
  return { value: rate, releases: inWindow.length, failed: failed.length, fewReleases: inWindow.length < MIN_RELEASES_FOR_A_RATE,
    undefinedBecause: rate === null ? `no release in the last ${LOOKBACK_DAYS} days` : null };
}

/**
 * Time to restore: regression opened -> the release that closes it. A row not yet closed by a release is counted at its CURRENT age and marked unrestored.
 * A row closed with no pull request behind it has no release to measure to: it is named, not guessed.
 * @param {{ rows: { regression: Regression, fix: (Release & { at: number }) | null }[], windowStart: number, now: number }} input
 */
function timeToRestore({ rows, windowStart, now }) {
  /** @type {number[]} */ const minutes = [];
  let unrestored = 0;
  let unattributed = 0;
  for (const { regression, fix } of rows) {
    const opened = Date.parse(regression.openedAt);
    if (fix !== null && fix.at >= windowStart) minutes.push((fix.at - opened) / MS_PER_MINUTE);
    else if (fix === null && regression.fixCommit === null && regression.closedAt !== null) unattributed += 1;
    else if (fix === null) { unrestored += 1; minutes.push((now - opened) / MS_PER_MINUTE); }
  }
  return { value: median(minutes), maxMinutes: minutes.length === 0 ? null : Math.max(...minutes), rows: minutes.length, unrestored, unattributed,
    undefinedBecause: minutes.length === 0 ? `no regression row restored or still open in the last ${LOOKBACK_DAYS} days` : null };
}

/** @param {Repository} repository @param {string} reason */
function unknownRepository(repository, reason) {
  return { repo: repository.repo, status: /** @type {const} */ ("unknown"), reason, oldestUnreleasedMinutes: null, deploymentFrequency: null, leadTime: null, changeFailure: null, restore: null,
    reasons: /** @type {Record<string, string>} */ ({}) };
}

/**
 * A regression row belongs to the window if it is still open, or was closed (by the pull request that fixed it, or by hand) inside it: one fixed before the
 * window is a restoration the window did not see, and no release in the window can be marked as followed by it.
 * @param {Regression} regression @param {number} windowStart @returns {boolean}
 */
function regressionInScope(regression, windowStart) {
  if (regression.closedAt === null) return true;
  return Date.parse(regression.fixMergedAt ?? regression.closedAt) >= windowStart;
}

/**
 * The OLDEST commit the metrics will ask a release about: the base every range is taken from (see `ancestryOf`). `null` when nothing will be asked.
 * @param {{ releasable: MergedPr[], regressions: Regression[] }} input @returns {string | null}
 */
function oldestCommit({ releasable, regressions }) {
  /** @type {{ commit: string, at: number }[]} */
  const asked = [];
  for (const pr of releasable) if (pr.mergeCommit !== null) asked.push({ commit: pr.mergeCommit, at: Date.parse(pr.mergedAt) });
  for (const regression of regressions) if (regression.fixCommit !== null) asked.push({ commit: regression.fixCommit, at: Date.parse(regression.fixMergedAt ?? regression.openedAt) });
  const dated = asked.filter((entry) => !Number.isNaN(entry.at)).sort((a, b) => a.at - b.at);
  return dated.length === 0 ? null : dated[0].commit;
}

/**
 * The two reads every metric stands on, or WHY the repository is unknown. A repository with no release and no merged pull request has been read as
 * EMPTY IN BOTH, which no repository with a history is: that is a reader that found nothing because it read nothing, and it is refused.
 * @param {{ repository: Repository, readers: Readers, windowStart: number }} input
 * @returns {{ refusal: string } | { releases: (Release & { at: number })[], merged: MergedPr[] | null }}
 */
function readSources({ repository, readers, windowStart }) {
  const listed = attempt(() => readers.releases(repository, { since: new Date(windowStart).toISOString() }));
  if (listed === null) return { refusal: "its releases could not be read" };
  const releases = ordered(listed);
  if (releases === null) return { refusal: "a release has no publish time that can be read" };
  const merged = attempt(() => readers.mergedPrs(repository, { since: releases.length === 0 ? null : new Date(windowStart).toISOString() }));
  if (releases.length > 0) return { releases, merged };
  if (merged === null) return { refusal: "it has no release and its merged pull requests could not be read" };
  if (merged.length === 0) return { refusal: "the readers returned nothing at all (no release and no merged pull request): a repository with a history is not empty in both, so nothing was read" };
  return { releases, merged };
}

/**
 * ONE repository's four metrics. Each block is `null` when ITS sources were refused (with the reason in `reasons`), so a refused regression list does
 * not hide a deployment frequency that was read, and none of them is ever a 0 made of an absence.
 * @param {Repository} repository @param {Readers} readers @param {number} now
 */
export function measureRepository(repository, readers, now) {
  const windowStart = now - LOOKBACK_DAYS * MS_PER_DAY;
  const sources = readSources({ repository, readers, windowStart });
  if ("refusal" in sources) return unknownRepository(repository, sources.refusal);
  const { releases, merged } = sources;
  const noReleaseYet = releases.length === 0;
  const releasable = merged === null ? null : merged.filter((pr) => (noReleaseYet || Date.parse(pr.mergedAt) >= windowStart) && isReleasable(pr, repository));
  const regressions = attempt(() => readers.regressions(repository, { since: new Date(windowStart).toISOString() }));
  const inScope = regressions === null ? null : regressions.filter((regression) => regressionInScope(regression, windowStart));
  const context = { releases, windowStart, contains: ancestryOf({ repository, readers, base: oldestCommit({ releasable: releasable ?? [], regressions: inScope ?? [] }) }) };
  const frequency = deploymentFrequency({ releases, releasable, now });
  const lead = releasable === null ? { block: null, reason: "its merged pull requests could not be read" } : leadTime({ releasable, context, now });
  const fixing = inScope === null ? { rows: null, reason: "its regression rows could not be read" } : fixingReleases({ regressions: inScope, context });
  const fixes = fixing.rows === null ? [] : fixing.rows.flatMap((row) => (row.fix === null ? [] : [row.fix]));
  const reasons = {
    ...(lead.reason === null ? {} : { leadTime: lead.reason }),
    ...(fixing.reason === null ? {} : { changeFailure: fixing.reason, restore: fixing.reason }),
  };
  return {
    repo: repository.repo, status: noReleaseYet ? /** @type {const} */ ("no release yet") : /** @type {const} */ ("read"), reason: null,
    deploymentFrequency: frequency, leadTime: /** @type {any} */ (lead.block), oldestUnreleasedMinutes: /** @type {any} */ (lead.block)?.oldestUnreleasedMinutes ?? null,
    changeFailure: fixing.rows === null ? null : changeFailure({ inWindow: frequency.releases, fixes }),
    restore: fixing.rows === null ? null : timeToRestore({ rows: fixing.rows, windowStart, now }),
    reasons: /** @type {Record<string, string>} */ (reasons),
  };
}

/**
 * THE FUNCTION: the four metrics for every declared repository, so all of them are on the page every day and an empty one is visible as empty.
 * NEVER THROWS: a repository whose measure throws is `unknown` with the first line of why.
 * @param {{ repositories: Repository[], readers: Readers, now: number }} input
 */
export function dora({ repositories, readers, now }) {
  const results = repositories.map((repository) => {
    try {
      return measureRepository(repository, readers, now);
    } catch (/** @type {any} */ err) {
      return unknownRepository(repository, `the measurement failed (${String(err?.message ?? err).split("\n")[0]})`);
    }
  });
  return { date: utcDate(now), now, repositories: results };
}

/** @typedef {ReturnType<typeof dora>} DoraReport */
/** @typedef {DoraReport["repositories"][number]} RepositoryReading */

// ---------------------------------------------------------------------------------------------------------------------
// THE ONE TABLE: what each metric is, which way is better, and how it prints.

/** @param {number} minutes @returns {string} `1d02h`, `3h10m`, `45m` */
function duration(minutes) {
  const whole = Math.round(minutes);
  if (whole < MINUTES_PER_HOUR) return `${whole}m`;
  if (whole < MINUTES_PER_DAY) return `${Math.floor(whole / MINUTES_PER_HOUR)}h${String(whole % MINUTES_PER_HOUR).padStart(2, "0")}m`;
  return `${Math.floor(whole / MINUTES_PER_DAY)}d${String(Math.floor((whole % MINUTES_PER_DAY) / MINUTES_PER_HOUR)).padStart(2, "0")}h`;
}

/** @param {any} b @returns {string} */
function frequencyText(b) {
  const days = Object.entries(b.perDay).filter(([, n]) => /** @type {number} */ (n) > 0).map(([date, n]) => `${date.slice(5)} x${n}`);
  const missed = b.missedDays === null ? "; days a releasable change merged with no release: unknown (merged pull requests unreadable)"
    : b.missedDays.length === 0 ? "" : `; MISSED (a releasable change merged, nothing shipped): ${b.missedDays.map((/** @type {string} */ d) => d.slice(5)).join(", ")}`;
  return `${b.value} release${b.value === 1 ? "" : "s"} in ${LOOKBACK_DAYS} days${days.length === 0 ? "" : ` (${days.join(", ")})`}${missed}`;
}

/** @param {any} b @returns {string} */
function leadText(b) {
  const unreleased = b.unreleased === 0 ? "" : `, ${b.unreleased} UNRELEASED (oldest ${duration(b.oldestUnreleasedMinutes)})`;
  return `median ${duration(b.medianMinutes)}, max ${duration(b.maxMinutes)} over ${b.changes} change${b.changes === 1 ? "" : "s"}${unreleased}`;
}

/** @param {any} b @returns {string} */
function failureText(b) {
  const caveat = b.fewReleases ? `; ONLY ${b.releases} release${b.releases === 1 ? "" : "s"}, fewer than ${MIN_RELEASES_FOR_A_RATE}: a count of events, not a trend` : "";
  return `${b.value}% (${b.failed} of ${b.releases} releases)${caveat}`;
}

/** @param {any} b @returns {string} */
function restoreText(b) {
  const open = b.unrestored === 0 ? "" : `, ${b.unrestored} UNRESTORED (counted at current age)`;
  const loose = b.unattributed === 0 ? "" : `; ${b.unattributed} closed with no pull request behind it, not measured`;
  return `median ${duration(b.value)}, max ${duration(b.maxMinutes)} over ${b.rows} row${b.rows === 1 ? "" : "s"}${open}${loose}`;
}

/** @param {number | null | undefined} n @returns {number | null} whole units, `null` staying `null` */
const whole = (n) => (n === null || n === undefined ? null : Math.round(n));

/**
 * Every metric: its id, which way is better, the block of a repository's reading it comes from, and how it prints. A block that is `null` is an
 * UNKNOWN metric; one with `undefinedBecause` is an UNDEFINED one; neither is a number. Every printed line ends with its direction.
 * @type {readonly { id: string, title: string, label: string, better: "lower" | "higher", block: "deploymentFrequency" | "leadTime" | "changeFailure" | "restore",
 *   of: (block: any) => number | null, text: (block: any) => string }[]}
 */
export const DORA_METRICS = Object.freeze([
  { id: "deploymentFrequency", title: "Deployment frequency", label: "Deployment frequency (releases in 14 days)", better: "higher", block: "deploymentFrequency", of: (b) => b.value, text: frequencyText },
  { id: "leadTimeMedianMinutes", title: "Lead time for changes", label: "Lead time for changes, median (minutes)", better: "lower", block: "leadTime", of: (b) => whole(b.medianMinutes), text: leadText },
  { id: "leadTimeMaxMinutes", title: "Lead time for changes", label: "Lead time for changes, max (minutes)", better: "lower", block: "leadTime", of: (b) => whole(b.maxMinutes), text: leadText },
  { id: "changeFailureRatePercent", title: "Change failure rate", label: "Change failure rate (%)", better: "lower", block: "changeFailure", of: (b) => b.value, text: failureText },
  { id: "timeToRestoreMedianMinutes", title: "Time to restore", label: "Time to restore, median (minutes)", better: "lower", block: "restore", of: (b) => whole(b.value), text: restoreText },
]);

/**
 * @param {RepositoryReading} reading @param {(typeof DORA_METRICS)[number]} metric
 * @returns {{ state: "value", value: number | null } | { state: "undefined" | "unknown", reason: string }}
 */
export function metricState(reading, metric) {
  const block = /** @type {any} */ (reading)[metric.block];
  if (block === null) return { state: "unknown", reason: reading.reason ?? reading.reasons[metric.block] ?? "its source could not be read" };
  if (block.undefinedBecause !== null) return { state: "undefined", reason: block.undefinedBecause };
  return { state: "value", value: metric.of(block) };
}

/** The id a repository's metric is trended under. */
export const doraNumberId = (/** @type {string} */ repo, /** @type {string} */ metricId) => `dora:${repo}:${metricId}`;

/**
 * The numbers the retrospective trends: one per repository per metric, `null` for UNKNOWN and for UNDEFINED alike (the declarations say which).
 * @param {DoraReport | null | undefined} report @returns {Record<string, number | null>}
 */
export function doraNumbers(report) {
  if (!report) return {};
  return Object.fromEntries(report.repositories.flatMap((reading) => DORA_METRICS.map((metric) => {
    const state = metricState(reading, metric);
    return [doraNumberId(reading.repo, metric.id), state.state === "value" ? state.value : null];
  })));
}

/**
 * The same numbers as `org-retro.mjs`'s `NUMBERS` rows, for the repositories declared TODAY, plus whether the metric is `undefined` today.
 * @param {DoraReport | null | undefined} report
 * @returns {{ id: string, label: string, better: "lower" | "higher", undefinedToday: boolean }[]}
 */
export function doraDeclarations(report) {
  if (!report) return [];
  return report.repositories.flatMap((reading) => DORA_METRICS.map((metric) => ({
    id: doraNumberId(reading.repo, metric.id), label: `${reading.repo}: ${metric.label}`, better: metric.better, undefinedToday: metricState(reading, metric).state === "undefined",
  })));
}

/** One line per BLOCK: lead time's median and maximum are one sentence, so the table's second row of a block prints nothing. */
const PRINTED = DORA_METRICS.filter((metric, index) => DORA_METRICS.findIndex((first) => first.block === metric.block) === index);

/** @param {RepositoryReading} reading @returns {string[]} */
function repositoryLines(reading) {
  if (reading.status === "unknown") return [`- ${reading.repo}: ${UNKNOWN} -- ${reading.reason}. Not 0: nothing was measured.`];
  const age = reading.oldestUnreleasedMinutes === null ? "" : `; oldest unreleased merge is ${duration(reading.oldestUnreleasedMinutes)} old`;
  const lines = [reading.status === "no release yet" ? `- ${reading.repo}: no release yet${age}` : `- ${reading.repo}:`];
  for (const metric of PRINTED) {
    const state = metricState(reading, metric);
    const body = state.state === "value" ? metric.text(/** @type {any} */ (reading)[metric.block]) : `${state.state} -- ${state.reason}`;
    lines.push(`    ${metric.title}: ${body} (${metric.better} is better)`);
  }
  return lines;
}

/**
 * The DORA block as the text `ceo` is handed and posts on #928.
 * @param {DoraReport} report @returns {string[]}
 */
export function renderDora(report) {
  const head = `DORA ${report.date} -- the four metrics per repository, from the registry and GitHub, last ${LOOKBACK_DAYS} days (an unreadable source is "${UNKNOWN}", an empty one "undefined", neither is 0)`;
  if (report.repositories.length === 0) return [head, "- no repository is declared (`dora` in .agent-org/project.json is empty)"];
  return [head, ...report.repositories.flatMap(repositoryLines)];
}

// ---------------------------------------------------------------------------------------------------------------------
// The READS. Each returns `null` for a refused one; everything above is pure.

/** @param {string} command @param {string[]} args @returns {string} */
function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] });
}

/** @param {string[]} args @returns {any} */
const ghJson = (args) => JSON.parse(run("gh", args));

/** @param {string} repo @param {string} ref @returns {string | null} the commit a tag or sha names; `null` when GitHub does not know it */
function commitOf(repo, ref) {
  const sha = attempt(() => run("gh", ["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`, "--jq", ".sha"]).trim());
  return sha !== null && sha.length === SHA_LENGTH ? sha : null;
}

/**
 * A release's commit, resolved only for a release inside the window: one older cannot contain a change merged in it, and asking for every tag of a
 * long-lived package is hundreds of calls for nothing. `null` for an older one, and for one GitHub does not know.
 * @param {{ publishedAt: string | undefined, since: string, known: string | undefined, repo: string, ref: string }} release @returns {string | null}
 */
function resolveCommit({ publishedAt, since, known, repo, ref }) {
  if (known) return known;
  return publishedAt !== undefined && Date.parse(publishedAt) >= Date.parse(since) ? commitOf(repo, ref) : null;
}

/** @param {Repository & { release: { kind: "npm", package: string } }} repository @param {{ since: string }} window @returns {Release[]} */
function npmReleases(repository, { since }) {
  const url = `https://registry.npmjs.org/${repository.release.package.replace("/", "%2f")}`;
  const document = JSON.parse(run("curl", ["-fsS", "--max-time", String(READ_TIMEOUT_SECONDS), "-H", "Accept: application/json", url]));
  return Object.entries(document.versions ?? {}).map(([version, meta]) => ({
    id: version, publishedAt: document.time?.[version], deprecated: Boolean(/** @type {any} */ (meta).deprecated),
    commit: resolveCommit({ publishedAt: document.time?.[version], since, known: /** @type {any} */ (meta).gitHead, repo: repository.repo, ref: `v${version}` }),
  }));
}

/** @param {Repository} repository @param {{ since: string }} window @returns {Release[]} the `v*` tags that have a published GitHub Release */
function tagReleases(repository, { since }) {
  const rows = ghJson(["api", `repos/${repository.repo}/releases`, "--paginate", "--slurp"]).flat();
  return rows.filter((/** @type {any} */ r) => !r.draft && typeof r.tag_name === "string" && r.tag_name.startsWith("v")).map((/** @type {any} */ r) => ({
    id: r.tag_name, publishedAt: r.published_at, deprecated: false,
    commit: resolveCommit({ publishedAt: r.published_at, since, known: undefined, repo: repository.repo, ref: r.tag_name }),
  }));
}

/** @type {Readers} */
export const githubReaders = {
  releases: (repository, window) => (repository.release.kind === "npm" ? npmReleases(/** @type {any} */ (repository), window) : tagReleases(repository, window)),
  mergedPrs: (repository, { since }) => ghJson(["pr", "list", "-R", repository.repo, "--state", "merged", ...(since === null ? [] : ["--search", `merged:>=${since}`]),
    "--limit", "1000", "--json", "number,mergedAt,mergeCommit,files"]).map((/** @type {any} */ pr) => ({
    number: pr.number, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? null, paths: Array.isArray(pr.files) ? pr.files.map((/** @type {any} */ f) => f.path) : null,
  })),
  regressions: (repository, { since }) => ghJson(["issue", "list", "-R", repository.repo, "--label", "regression", "--state", "all", "--limit", "200",
    "--json", "number,createdAt,closedAt,closedByPullRequestsReferences"]).map((/** @type {any} */ row) => ({
    number: row.number, openedAt: row.createdAt, closedAt: row.closedAt ?? null,
    ...(row.closedAt && row.closedAt >= since ? fixOf(repository.repo, row.closedByPullRequestsReferences ?? []) : { fixCommit: null, fixMergedAt: null }),
  })),
  // `compare/<base>...<head>`, every page: `status` once, and the commits of `head` that `base` lacks.
  range: (repository, { base, head }) => {
    const pages = ghJson(["api", `repos/${repository.repo}/compare/${base}...${head}?per_page=100`, "--paginate", "--slurp"]);
    return { status: pages[0].status, commits: pages.flatMap((/** @type {any} */ page) => page.commits.map((/** @type {any} */ commit) => commit.sha))};
  },
};

/**
 * The pull request IN THIS REPOSITORY that closed a regression row: its merge commit and when it merged. The row's own `closedAt` is NOT the merge time, and
 * the window test and the base of every range are measured from the commit, so it is read from the pull request. A row can be closed by a pull request in
 * ANOTHER repository (measured: a row here closed by one in `agent-org`), whose commit is in no history of this one; it is skipped, and the row is named as
 * closed with no release to measure to (`unattributed`). A row closed with no merged pull request behind it has none either.
 * @param {string} repo @param {{ number: number, repository?: { name: string, owner: { login: string } } }[]} references
 * @returns {{ fixCommit: string | null, fixMergedAt: string | null }}
 */
function fixOf(repo, references) {
  for (const reference of references) {
    if (reference.repository === undefined || `${reference.repository.owner.login}/${reference.repository.name}` !== repo) continue;
    const merged = attempt(() => ghJson(["pr", "view", String(reference.number), "-R", repo, "--json", "mergeCommit,mergedAt"]));
    if (merged?.mergeCommit?.oid) return { fixCommit: merged.mergeCommit.oid, fixMergedAt: merged.mergedAt ?? null };
  }
  return { fixCommit: null, fixMergedAt: null };
}

/**
 * THE READING FOR TODAY: every declared repository, through the real readers. THE ONE CALL `org-retro.mjs` makes.
 * @param {{ repositories: Repository[], now: number, readers?: Readers }} input
 */
export function readDora({ repositories, now, readers = githubReaders }) {
  return dora({ repositories, readers, now });
}

async function main() {
  const { refuseUnknownFlags, flagValue } = await import("./lib/cli-flags.mjs");
  refuseUnknownFlags(["--now"], { entry: import.meta.url, command: "agent-org dora" });
  const nowFlag = flagValue(process.argv, "now");
  const now = nowFlag === undefined ? Date.now() : Date.parse(nowFlag);
  if (!Number.isFinite(now)) {
    process.stderr.write(`dora: --now=${nowFlag} is not a date this can read.\n`);
    process.exit(2);
  }
  const { homeProjectDeclaration } = await import("./project-config.mjs");
  process.stdout.write(`${renderDora(readDora({ repositories: homeProjectDeclaration().dora, now })).join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main().catch((/** @type {any} */ err) => {
    process.stderr.write(`dora: ${String(err?.message ?? err)}\n`);
    process.exit(1);
  });
}
