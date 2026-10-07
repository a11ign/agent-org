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
// A REFUSED READ IS `unknown`, NEVER 0 (#1286): a reader that threw, or answered `null`, read nothing. AN EMPTY ANSWER IS AN ANSWER (#3171): a declared repository
// with no release and no merged pull request is `no release yet`, and so is an npm package the registry answers 404 for (never published: the one refusal that
// is an answer, and only on a package the declaration names). `undefined` is a third state, not a failure: a metric with nothing to measure (no regression
// ever opened) is undefined, and is never printed as 0 either.
//
// A RELEASE'S COMMIT comes from the registry's `gitHead`, else the version's tag, else (#3591) its PROVENANCE ATTESTATION: a package published through CI
// provenance carries no `gitHead` and its repository has no tag, but the attestation names the commit it was built from. A release none of the three can place
// stays `unknown`, never `false`. A version `0.0.0-...` held a package NAME and was never a deployment, so it is not a release (#3591).
//
// ONE npm PACKAGE PER REPOSITORY IS READ (`release.package`), and `renderDora` says which: a release of another package in the same repository is not a
// deployment in this reading. a11ign publishes four together in one version pull request, so it declares the command.
//
// A LEAF: it imports nothing from the tool, so `org-retro.mjs` can import it and the test can run it with injected readers and no network.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** What an unreadable source prints. Never `0`. */
export const UNKNOWN = "unknown";

/** The `code` of the error a reader throws for an npm package the registry has no document for (HTTP 404): never published, which is an answer and not a refusal. */
export const NEVER_PUBLISHED = "never-published";

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
 * The longest ONE child (`gh`, `curl`) may run. Measured 2026-10-06: the merged-PR list of the biggest repository takes 28 s and the other calls 2 to 5 s, so 90 s is
 * three times the slowest read that succeeds, and a hung child ends here and says which call it was rather than holding the tick until `TimeoutStartSec`.
 */
export const READ_TIMEOUT_MS = 90 * 1000;
/**
 * The longest ONE repository's read may take in total, every child counted. A repository of 52 releases is 52 `commits/<tag>` lookups and a `compare` each at 2 to 5 s,
 * so about 3 minutes when healthy; this is that plus a margin, and past it the remaining children are not started and the repository is `unknown` with the call that ran out.
 */
export const REPOSITORY_BUDGET_MS = 240 * 1000;
const HTTP_OK = "200";
const HTTP_NOT_FOUND = "404";
/** The attestation predicate that names the build's source; the registry also serves a `publish` attestation beside it, which names no commit. */
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/**
 * @typedef {{ repo: string, release: { kind: "npm", package: string } | { kind: "tag" }, releasablePaths: string[] }} Repository
 * @typedef {{ id: string, publishedAt: string, commit: string | null, deprecated: boolean }} Release `commit` is null when it could not be resolved, and for a release older than the window, which no change in it can be in
 * @typedef {{ number: number, mergedAt: string, mergeCommit: string | null, paths: string[] | null }} MergedPr `paths` null: the file list was truncated
 * @typedef {{ number: number, openedAt: string, closedAt: string | null, fixCommit: string | null, fixMergedAt: string | null }} Regression `fixCommit`: the merge commit of the pull request that closed it, merged at `fixMergedAt`
 * @typedef {{ releases: (r: Repository, window: { since: string }) => Release[] | null,
 *   mergedPrs: (r: Repository, window: { since: string | null }) => MergedPr[] | null,
 *   regressions: (r: Repository, window: { since: string }) => Regression[] | null,
 *   range: (r: Repository, commits: { base: string, head: string }) => Range | null,
 *   parentOf?: (r: Repository, commit: string) => string | null }} Readers `parentOf` is the commit's only parent, `null` for none or two; a reader without it places a release by its own commit alone
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

/** @param {string} name @returns {Error} */
const neverPublished = (name) => Object.assign(new Error(`the registry has no package ${name}`), { code: NEVER_PUBLISHED });

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
 *
 * AND ONCE PER REPOSITORY WHEN THE NEWEST RELEASE'S RANGE CAN BE READ (a11ign/a11ign#3910). That range lists the commits oldest first, so it is the whole linear
 * history from `base`, and a release contains a commit exactly when it stands at or after it there. Measured 2026-10-07 for `a11ign/agent-org`: 317 releasable changes
 * and 184 releases in the window, whose one range from the oldest change to the newest release lists 863 commits, every one of the 863 in order of commit date.
 * One `compare` of ~4 s stands in for the one-per-release that no budget covers once a repository releases on every merge. A release or commit that range does not
 * list (a release cut from older history than `base`, a commit on no path to the newest release) is asked of its own range, as before.
 * @param {{ repository: Repository, readers: Readers, base: string | null, releases: Release[] }} input
 * @returns {{ contains: (release: Release, commit: string) => boolean | null, inHistory: (release: Release, commit: string) => boolean | undefined }}
 *   `contains` is `null` when the range could not be read: never read as `false`. `inHistory` answers from the one ordered history alone, and is `undefined`
 *   where that history does not place the release or the commit: asking it never reads anything.
 */
function ancestryOf({ repository, readers, base, releases }) {
  /** Keyed by COMMIT: a backport and the release it was cut beside can point at one commit, and the range is the commit's. The Set keeps the order the commits were listed in. @type {Map<string, { status: string, commits: Set<string> } | null>} */
  const ranges = new Map();
  const rangeOf = (/** @type {Release} */ release) => {
    const head = release.commit;
    if (head === null || base === null) return null;
    if (!ranges.has(head)) {
      const range = attempt(() => { startable("compare"); return readers.range(repository, { base, head }); });
      ranges.set(head, range === null ? null : { status: range.status, commits: new Set(range.commits) });
    }
    return ranges.get(head) ?? null;
  };
  /** @type {Map<string, number> | null | undefined} undefined until first asked; null when the newest release's range is unreadable or does not descend from `base` */
  let positions;
  const positionsOfHistory = () => {
    if (positions !== undefined) return positions;
    const newest = releases.findLast((release) => release.commit !== null);
    const range = newest === undefined || base === null ? null : rangeOf(newest);
    const descends = range !== null && (range.status === "ahead" || range.status === "identical");
    positions = descends && base !== null ? new Map([[base, 0], ...[...range.commits].map((sha, index) => /** @type {[string, number]} */ ([sha, index + 1]))]) : null;
    return positions;
  };
  /** A release's place in the history: its own commit's, else its ONLY PARENT's, because a tag is often a one-commit "Release x.y.z" cut from a main commit and never merged back
   *  (all but 3 of agent-org's 185 in the window), and a commit that adds nothing but itself contains what its parent does. @type {Map<string, number | undefined>} */
  const placed = new Map();
  const placeOf = (/** @type {Release} */ release) => {
    const history = positionsOfHistory();
    const head = release.commit;
    if (history === null || head === null) return undefined;
    if (!placed.has(head)) {
      const parent = history.has(head) ? null : attempt(() => readers.parentOf?.(repository, head) ?? null);
      placed.set(head, history.get(head) ?? (parent === null ? undefined : history.get(parent)));
    }
    return placed.get(head);
  };
  const inHistory = (/** @type {Release} */ release, /** @type {string} */ commit) => {
    const at = placeOf(release);
    const wanted = positionsOfHistory()?.get(commit);
    return at === undefined || wanted === undefined ? undefined : at >= wanted;
  };
  const contains = (/** @type {Release} */ release, /** @type {string} */ commit) => {
    const known = inHistory(release, commit);
    if (known !== undefined) return known;
    const range = rangeOf(release);
    if (range === null) return null;
    return commit === base ? range.status === "ahead" || range.status === "identical" : range.commits.has(commit);
  };
  return { contains, inHistory };
}

/**
 * The smallest index in `[0, length)` at which `holds` is true, given that it is false up to some index and true from there on; `length` when it is never true.
 * `null` when `holds` could not be answered at an index it was asked about: the position is then unknown, and no neighbour's answer stands in for it.
 * @param {number} length @param {(index: number) => boolean | null} holds @returns {number | null}
 */
function firstIndexWhere(length, holds) {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const answer = holds(middle);
    if (answer === null) return null;
    if (answer) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The first release that CONTAINS `commit`. A release published before `notBefore` cannot contain it, so it is not asked.
 * WHEN THE ORDERED HISTORY PLACES EVERY RELEASE THE ANSWER COSTS NO READ, so the releases are walked in time order exactly as they always were (a backport published
 * after a newer release is still handled, because nothing assumes the answers are monotone). When some release needs a read of its own range, they are BISECTED
 * instead: the merged history is linear, so once a release contains the commit every later one does, and the reads are `O(log n)` rather than one `compare` for each
 * release walked past, which no budget covers once a repository releases on every merge (a11ign/a11ign#3910).
 * A release with no commit cannot be asked: one inside the window that sits BEFORE the answer might be the one, so it makes the question unreadable.
 * `unreadable` is a question that could not be answered: it is never read as "no release contains it", which would make a change look unreleased.
 * @param {{ commit: string | null, notBefore: number, releases: (Release & { at: number })[], windowStart: number, contains: ReturnType<typeof ancestryOf>["contains"], inHistory: ReturnType<typeof ancestryOf>["inHistory"] }} query
 * @returns {{ release: (Release & { at: number }) | null, unreadable: boolean }}
 */
function firstContaining({ commit, notBefore, releases, windowStart, contains, inHistory }) {
  const unreadable = { release: null, unreadable: true };
  if (commit === null) return unreadable;
  const candidates = releases.filter((candidate) => candidate.at >= notBefore);
  const placed = candidates.filter((candidate) => candidate.commit !== null);
  const free = placed.every((candidate) => inHistory(candidate, commit) !== undefined);
  const found = free ? placed.findIndex((candidate) => inHistory(candidate, commit)) : firstIndexWhere(placed.length, (index) => contains(placed[index], commit));
  if (found === null) return unreadable;
  const release = placed[found === -1 ? placed.length : found] ?? null;
  const askedBefore = release === null ? candidates : candidates.slice(0, candidates.indexOf(release));
  if (askedBefore.some((candidate) => candidate.commit === null && candidate.at >= windowStart)) return unreadable; // a recent release we cannot place might be the one
  return { release, unreadable: false };
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

/** @param {Repository} repository @returns {string | null} the one npm package this repository's releases are read from, `null` for a tag repository */
const npmPackageOf = (repository) => (repository.release.kind === "npm" ? repository.release.package : null);

/** @param {Repository} repository @param {string} reason */
function unknownRepository(repository, reason) {
  return { repo: repository.repo, npmPackage: npmPackageOf(repository), status: /** @type {const} */ ("unknown"), reason, oldestUnreleasedMinutes: null, deploymentFrequency: null, leadTime: null, changeFailure: null, restore: null,
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
 * The releases, `[]` when the declared npm package was never published (the registry's 404), or `null` when the read was refused. A 404 is told from a
 * network error by the reader's `NEVER_PUBLISHED` code, and only an npm repository can have one: a tag repository's 404 is a refusal like any other.
 * @param {{ repository: Repository, readers: Readers, windowStart: number }} input @returns {Release[] | null}
 */
function readReleases({ repository, readers, windowStart }) {
  try {
    return readers.releases(repository, { since: new Date(windowStart).toISOString() });
  } catch (/** @type {any} */ err) {
    return err?.code === NEVER_PUBLISHED && repository.release.kind === "npm" ? [] : null;
  }
}

/**
 * The two reads every metric stands on, or WHY the repository is unknown. No release and no merged pull request is `no release yet`, as the row that
 * declared the repository promised: the page shows it as unfinished. It is the readers' contract that makes that safe: a read that FAILED throws or
 * answers `null`, and `[]` is only a read that found nothing.
 * @param {{ repository: Repository, readers: Readers, windowStart: number }} input
 * @returns {{ refusal: string } | { releases: (Release & { at: number })[], merged: MergedPr[] | null }}
 */
function readSources({ repository, readers, windowStart }) {
  const listed = readReleases({ repository, readers, windowStart });
  if (listed === null) return { refusal: "its releases could not be read" };
  const releases = ordered(listed);
  if (releases === null) return { refusal: "a release has no publish time that can be read" };
  const merged = attempt(() => readers.mergedPrs(repository, { since: releases.length === 0 ? null : new Date(windowStart).toISOString() }));
  if (releases.length === 0 && merged === null) return { refusal: "it has no release and its merged pull requests could not be read" };
  return { releases, merged };
}

/**
 * A refusal says so when the TIME LIMIT is what ended a read of this repository: taken the moment a metric is refused, so a limit that was hit only after it does
 * not rewrite it, and a `compare` that was refused for any other reason still reads as it always did. Without it the report blamed an ancestry for a budget (#3910).
 * @param {string | null} reason @returns {string | null}
 */
function namingTheLimit(reason) {
  const [first] = readLimits.timedOut;
  return reason === null || first === undefined ? reason : `${reason} (${first} hit its time limit)`;
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
  const context = { releases, windowStart, ...ancestryOf({ repository, readers, releases, base: oldestCommit({ releasable: releasable ?? [], regressions: inScope ?? [] }) }) };
  const frequency = deploymentFrequency({ releases, releasable, now });
  const lead = releasable === null ? { block: null, reason: "its merged pull requests could not be read" } : leadTime({ releasable, context, now });
  lead.reason = namingTheLimit(lead.reason);
  const fixing = inScope === null ? { rows: null, reason: "its regression rows could not be read" } : fixingReleases({ regressions: inScope, context });
  fixing.reason = namingTheLimit(fixing.reason);
  const fixes = fixing.rows === null ? [] : fixing.rows.flatMap((row) => (row.fix === null ? [] : [row.fix]));
  const reasons = {
    ...(lead.reason === null ? {} : { leadTime: lead.reason }),
    ...(fixing.reason === null ? {} : { changeFailure: fixing.reason, restore: fixing.reason }),
  };
  return {
    repo: repository.repo, npmPackage: npmPackageOf(repository), status: noReleaseYet ? /** @type {const} */ ("no release yet") : /** @type {const} */ ("read"), reason: null,
    deploymentFrequency: frequency, leadTime: /** @type {any} */ (lead.block), oldestUnreleasedMinutes: /** @type {any} */ (lead.block)?.oldestUnreleasedMinutes ?? null,
    changeFailure: fixing.rows === null ? null : changeFailure({ inWindow: frequency.releases, fixes }),
    restore: fixing.rows === null ? null : timeToRestore({ rows: fixing.rows, windowStart, now }),
    reasons: /** @type {Record<string, string>} */ (reasons),
  };
}

/** @param {Repository} repository @param {Readers} readers @param {number} now @returns {ReturnType<typeof measureRepository>} */
function measureOrUnknown(repository, readers, now) {
  try {
    return measureRepository(repository, readers, now);
  } catch (/** @type {any} */ err) {
    return unknownRepository(repository, `the measurement failed (${String(err?.message ?? err).split("\n")[0]})`);
  }
}

/**
 * ONE repository's reading, the unit the gate keeps as it goes (#3736). NEVER THROWS: a repository whose measure throws is `unknown` with the first line of why.
 * Every child it starts is bounded (`timeoutMs` each, `repositoryMs` for the repository), and an `unknown` that a bound caused names the call that hit it.
 * @param {{ repository: Repository, readers?: Readers, now: number, limits?: { timeoutMs?: number, repositoryMs?: number } }} input
 */
export function readRepository({ repository, readers = githubReaders, now, limits = {} }) {
  const outer = readLimits;
  readLimits = { timeoutMs: limits.timeoutMs ?? READ_TIMEOUT_MS, deadlineAt: Date.now() + (limits.repositoryMs ?? REPOSITORY_BUDGET_MS), timedOut: [] };
  try {
    const reading = measureOrUnknown(repository, readers, now);
    const [first] = readLimits.timedOut;
    return reading.status === "unknown" && first !== undefined ? { ...reading, reason: `${reading.reason} (${first} hit its time limit)` } : reading;
  } finally {
    readLimits = outer;
  }
}

/**
 * The report of readings already taken, in the order the repositories are declared. THE ONE PLACE a report is assembled, so a resumed read and a whole one agree.
 * @param {{ readings: ReturnType<typeof measureRepository>[], now: number }} input
 */
export function doraReport({ readings, now }) {
  return { date: utcDate(now), now, repositories: readings };
}

/**
 * THE FUNCTION: the four metrics for every declared repository, so all of them are on the page every day and an empty one is visible as empty.
 * @param {{ repositories: Repository[], readers: Readers, now: number }} input
 */
export function dora({ repositories, readers, now }) {
  return doraReport({ readings: repositories.map((repository) => readRepository({ repository, readers, now })), now });
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
 * Which npm package each npm repository's releases are read from: ONE, so a release of another package in it is not counted, and the page says so
 * rather than leaving a reader to assume every package is. A report cached before this field existed names none, and prints no line.
 * @param {DoraReport} report @returns {string[]}
 */
function packagesLine(report) {
  const read = report.repositories.flatMap((reading) => (reading.npmPackage ? [`${reading.repo} reads \`${reading.npmPackage}\``] : []));
  return read.length === 0 ? [] : [`- npm releases are read from ONE package per repository (a release of another is not a deployment here): ${read.join("; ")}`];
}

/**
 * The DORA block as the text `ceo` is handed and posts on #928.
 * @param {DoraReport} report @returns {string[]}
 */
export function renderDora(report) {
  const head = `DORA ${report.date} -- the four metrics per repository, from the registry and GitHub, last ${LOOKBACK_DAYS} days (an unreadable source is "${UNKNOWN}", an empty one "undefined", neither is 0)`;
  if (report.repositories.length === 0) return [head, "- no repository is declared (`dora` in .agent-org/project.json is empty)"];
  return [head, ...packagesLine(report), ...report.repositories.flatMap(repositoryLines)];
}

// ---------------------------------------------------------------------------------------------------------------------
// The READS. Each returns `null` for a refused one; everything above is pure.

/**
 * THE LIMITS THE CHILDREN RUN UNDER, for the repository being read. Module state because the readers are plain functions that call `run`, and the read is
 * synchronous, so one repository is read at a time (`readRepository` sets it and puts it back). `timedOut` names the calls that hit a limit, for the repository's reason.
 * @type {{ timeoutMs: number, deadlineAt: number, timedOut: string[] }}
 */
let readLimits = { timeoutMs: READ_TIMEOUT_MS, deadlineAt: Infinity, timedOut: [] };

/** @param {string} command @param {string[]} args @returns {string} the call as a person would name it: the command and the first two words that are not flags */
const callName = (command, args) => [command, ...args.filter((arg) => !arg.startsWith("-")).slice(0, 2)].join(" ");

/**
 * The milliseconds left of this repository's budget, or a throw that records `call` as the one the budget ended. Every read starts here, so a reader that
 * does not go through `run` (the ones a test injects) is bound by the same deadline.
 * @param {string} call @returns {number}
 */
function startable(call) {
  const left = readLimits.deadlineAt - Date.now();
  if (left <= 0) {
    readLimits.timedOut.push(call);
    throw new Error(`${call} was not started: this repository's read budget is spent`);
  }
  return left;
}

/** @param {string} command @param {string[]} args @returns {string} */
function run(command, args) {
  const call = callName(command, args);
  const timeout = Math.min(readLimits.timeoutMs, startable(call));
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"], timeout });
  } catch (/** @type {any} */ err) {
    if (err?.code !== "ETIMEDOUT") throw err;
    readLimits.timedOut.push(call);
    throw new Error(`${call} timed out after ${Math.round(timeout / 1000)} s`, { cause: err });
  }
}

/** @param {string[]} args @returns {any} */
const ghJson = (args) => JSON.parse(run("gh", args));

/**
 * The ONE parent of every commit this process has read, keyed `repo@sha` (a commit's parents never change, so it is never stale): `null` for a commit with none or with two.
 * Filled by the call that resolves a release's commit, which already carries the parents, so knowing them costs no read of its own (a11ign/a11ign#3910).
 * @type {Map<string, string | null>}
 */
const onlyParents = new Map();

/** @param {string} repo @param {string} ref @returns {{ sha: string, parent: string | null } | null} the commit a tag or sha names; `null` when GitHub does not know it */
function readCommit(repo, ref) {
  const answer = attempt(() => run("gh", ["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`, "--jq", `[.sha, (.parents | map(.sha) | join(","))] | join(" ")`]).trim());
  const [sha, parents = ""] = answer === null ? [] : answer.split(" ");
  if (sha === undefined || sha.length !== SHA_LENGTH) return null;
  const parent = parents.length === SHA_LENGTH ? parents : null;
  onlyParents.set(`${repo}@${sha}`, parent);
  return { sha, parent };
}

/** @param {string} repo @param {string} ref @returns {string | null} the commit a tag or sha names; `null` when GitHub does not know it */
const commitOf = (repo, ref) => readCommit(repo, ref)?.sha ?? null;

/** @param {string} repo @param {string} commit @returns {string | null} its only parent, `null` when it has none or two, or it could not be read */
function parentOf(repo, commit) {
  const key = `${repo}@${commit}`;
  return onlyParents.has(key) ? onlyParents.get(key) ?? null : readCommit(repo, commit)?.parent ?? null;
}

/**
 * A release's commit, resolved only for a release inside the window: one older cannot contain a change merged in it, and asking for every tag of a
 * long-lived package is hundreds of calls for nothing. `null` for an older one, and for one no lookup can place. `lookups` run in order and stop at the
 * first answer, so a costlier read is only made for a release the cheaper ones could not place.
 * @param {{ publishedAt: string | undefined, since: string, known: string | undefined, lookups: (() => string | null)[] }} release @returns {string | null}
 */
function resolveCommit({ publishedAt, since, known, lookups }) {
  if (known) return known;
  if (publishedAt === undefined || Date.parse(publishedAt) < Date.parse(since)) return null;
  for (const lookup of lookups) {
    const commit = lookup();
    if (commit !== null) return commit;
  }
  return null;
}

/** A version that held a package NAME (`0.0.0-reserved.0`, `0.0.0-stage`): published to reserve it, never a deployment of anything. @param {string} version */
export const isNameReservation = (version) => version.startsWith("0.0.0-");

/**
 * The commit a version's provenance attestation says it was built from. Reads only the `slsa.dev/provenance/v1` statement and only a 40-character
 * `gitCommit`, so a malformed or absent one is `null` (unplaced, i.e. `unknown`), never a guess.
 * @param {any} document the registry's `attestations` document for one version @returns {string | null}
 */
export function commitFromAttestations(document) {
  const payload = document?.attestations?.find((/** @type {any} */ a) => a?.predicateType === PROVENANCE_PREDICATE)?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") return null;
  const statement = attempt(() => JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
  const source = statement?.predicate?.buildDefinition?.resolvedDependencies?.find((/** @type {any} */ dependency) => dependency?.digest?.gitCommit);
  const commit = source?.digest?.gitCommit;
  return typeof commit === "string" && commit.length === SHA_LENGTH && /^[0-9a-f]+$/.test(commit) ? commit : null;
}

/** @typedef {{ commitOf: (repo: string, ref: string) => string | null, attestedCommit: (npmPackage: string, version: string) => string | null }} CommitReaders */

/**
 * The releases of an npm package from its registry document: name reservations dropped, and each version in the window placed by its `gitHead`, then its
 * tag, then its attestation. The attestation read costs ONE request per release in the window that has neither of the first two.
 * @param {{ document: any, repository: Repository & { release: { kind: "npm", package: string } }, since: string, commits: CommitReaders }} input @returns {Release[]}
 */
export function npmReleasesFrom({ document, repository, since, commits }) {
  const npmPackage = repository.release.package;
  return Object.entries(document.versions ?? {}).filter(([version]) => !isNameReservation(version)).map(([version, meta]) => ({
    id: version, publishedAt: document.time?.[version], deprecated: Boolean(/** @type {any} */ (meta).deprecated),
    commit: resolveCommit({ publishedAt: document.time?.[version], since, known: /** @type {any} */ (meta).gitHead,
      lookups: [() => commits.commitOf(repository.repo, `v${version}`), () => commits.attestedCommit(npmPackage, version)] }),
  }));
}

/** @param {string} npmPackage @param {string} version @returns {string | null} `null` when the attestation cannot be read or names no commit */
function attestedCommit(npmPackage, version) {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${npmPackage.replace("/", "%2f")}@${version}`;
  return attempt(() => commitFromAttestations(JSON.parse(run("curl", ["-sSf", "--max-time", String(READ_TIMEOUT_SECONDS), "-H", "Accept: application/json", url]))));
}

/** @param {Repository & { release: { kind: "npm", package: string } }} repository @param {{ since: string }} window @returns {Release[]} */
function npmReleases(repository, { since }) {
  const url = `https://registry.npmjs.org/${repository.release.package.replace("/", "%2f")}`;
  // No `-f`: it would make a 404 (never published) and a failed read the same exit status. The status is the last line, after the document.
  const answer = run("curl", ["-sS", "--max-time", String(READ_TIMEOUT_SECONDS), "-H", "Accept: application/json", "-w", "\n%{http_code}", url]);
  const split = answer.lastIndexOf("\n");
  const status = answer.slice(split + 1);
  if (status === HTTP_NOT_FOUND) throw neverPublished(repository.release.package);
  if (status !== HTTP_OK) throw new Error(`the registry answered HTTP ${status} for ${repository.release.package}`);
  return npmReleasesFrom({ document: JSON.parse(answer.slice(0, split)), repository, since, commits: { commitOf, attestedCommit } });
}

/** @param {Repository} repository @param {{ since: string }} window @returns {Release[]} the `v*` tags that have a published GitHub Release */
function tagReleases(repository, { since }) {
  const rows = ghJson(["api", `repos/${repository.repo}/releases`, "--paginate", "--slurp"]).flat();
  return rows.filter((/** @type {any} */ r) => !r.draft && typeof r.tag_name === "string" && r.tag_name.startsWith("v")).map((/** @type {any} */ r) => ({
    id: r.tag_name, publishedAt: r.published_at, deprecated: false,
    commit: resolveCommit({ publishedAt: r.published_at, since, known: undefined, lookups: [() => commitOf(repository.repo, r.tag_name)] }),
  }));
}

/**
 * The `regression` rows of a repository, `[]` for one whose issues are DISABLED (it has no rows and can have none: `gh issue list` refuses it, which would
 * read as `unknown` for every metric of a repository that only exists to hold code, #3171). A failed read of the setting itself throws, and is refused.
 * @param {string} repo @param {string} since @returns {Regression[]}
 */
function regressionRows(repo, since) {
  if (ghJson(["repo", "view", repo, "--json", "hasIssuesEnabled"]).hasIssuesEnabled !== true) return [];
  return ghJson(["issue", "list", "-R", repo, "--label", "regression", "--state", "all", "--limit", "200",
    "--json", "number,createdAt,closedAt,closedByPullRequestsReferences"]).map((/** @type {any} */ row) => ({
    number: row.number, openedAt: row.createdAt, closedAt: row.closedAt ?? null,
    ...(row.closedAt && row.closedAt >= since ? fixOf(repo, row.closedByPullRequestsReferences ?? []) : { fixCommit: null, fixMergedAt: null }),
  }));
}

/** @type {Readers} */
export const githubReaders = {
  releases: (repository, window) => (repository.release.kind === "npm" ? npmReleases(/** @type {any} */ (repository), window) : tagReleases(repository, window)),
  mergedPrs: (repository, { since }) => ghJson(["pr", "list", "-R", repository.repo, "--state", "merged", ...(since === null ? [] : ["--search", `merged:>=${since}`]),
    "--limit", "1000", "--json", "number,mergedAt,mergeCommit,files"]).map((/** @type {any} */ pr) => ({
    number: pr.number, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? null, paths: Array.isArray(pr.files) ? pr.files.map((/** @type {any} */ f) => f.path) : null,
  })),
  regressions: (repository, { since }) => regressionRows(repository.repo, since),
  // `compare/<base>...<head>`, every page: `status` once, and the commits of `head` that `base` lacks.
  parentOf: (repository, commit) => parentOf(repository.repo, commit),
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
