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
// TWO CHANNELS, TWO MORE READINGS (#3949, outcome 3 of #3911): a merge is published to `next` and the fleet's verdict moves `latest` to it later. The registry's `time` map lists
// a version's publish time whatever dist-tag it went to, so lead time above is MERGE-TO-`next` with no change. What `time` does not record is when a dist-tag MOVED, so:
//   5. Lead time, `next` to `latest`: a version's publish to the `Promoted to latest: <time>` line the promotion leaves in its GitHub Release's notes (readable with no token).
//      A version never promoted is counted at its CURRENT age and marked unpromoted, as an unreleased merge is: a 14-day wait is a number.
//   6. Versions qualified: versions `latest` has pointed at, over versions published, in the same window (`MIN_RELEASES_FOR_A_RATE` caveat, as the failure rate has).
// A version whose record cannot be read (no Release for it, or `latest` names it and its Release records no time) makes both `unknown`, never 0 and never a guess.
// A PACKAGE WITH NO `next` HAS NO CHANNELS TO READ (#4040): its dist-tags are asked first, and one that names none publishes straight to `latest`, so both channel readings are
// `undefined` with the reason, not `unknown` for a promotion record that cannot exist. A dist-tags read that is refused stays `unknown`: a registry that cannot answer is not evidence.
// The chairman's TARGETS are in the table and print beside the number: `next` under 30 minutes, `latest` under 24 hours (the share of versions qualified has no target).
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

/** The chairman's targets (#3911): a merge is on `next` in under 30 minutes, and a version is on `latest` in under 24 hours. */
const NEXT_TARGET_MINUTES = 30;
const LATEST_TARGET_MINUTES = MINUTES_PER_DAY;

/**
 * The line a promotion leaves in its Release's notes: written by a11y-witness's `release.yml` (`promotion-record`) and read by `scripts/release-promote.mjs`, which this leaf
 * cannot import. `dora-channels.test.ts` pins it against the line the workflow prints, so a change to one side that misses the other is a red test and not a silent `unknown`.
 */
const PROMOTION_LINE = /^Promoted to latest: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \(qualification read on [0-9a-f]{40}\)$/m;
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

export type Repository = { repo: string, release: { kind: "npm", package: string } | { kind: "tag" }, releasablePaths: string[] };
/**
 * `commit` is null when it could not be resolved, and for a release older than the window, which no change in it can be in
 */
export type Release = { id: string, publishedAt: string, commit: string | null, deprecated: boolean };
/** `paths` null: the file list was truncated */
export type MergedPr = { number: number, mergedAt: string, mergeCommit: string | null, paths: string[] | null };
/** `fixCommit`: the merge commit of the pull request that closed it, merged at `fixMergedAt` */
export type Regression = { number: number, openedAt: string, closedAt: string | null, fixCommit: string | null, fixMergedAt: string | null };
/**
 * `parentOf` is the commit's only parent, `null` for none or two; a reader without it places a release by its own commit alone. `promotions` is where `latest` moved: a reader without it leaves the two channel readings `unknown`. `distTags` is the npm package's dist-tags, which say whether it HAS a `next` channel (#4040): a reader without it leaves that question unasked, and the repository is read as one that has the channel
 */
export type Readers = { releases: (r: Repository, window: { since: string }) => Release[] | null, mergedPrs: (r: Repository, window: { since: string | null }) => MergedPr[] | null, regressions: (r: Repository, window: { since: string }) => Regression[] | null, range: (r: Repository, commits: { base: string, head: string }) => Range | null, parentOf?: (r: Repository, commit: string) => string | null, promotions?: (r: Repository, window: { since: string }) => PromotionRecords | null, distTags?: (r: Repository) => Record<string, string> | null };
/**
 * `latest` is the version the `latest` dist-tag names now (`null`: it names none); `notes` is the notes of each version's GitHub Release, keyed by version, and a version with no Release has no key
 */
export type PromotionRecords = { latest: string | null, notes: Record<string, string> };
/**
 * GitHub's compare of `base...head`: `status` is `ahead`/`identical` when `base` is in `head`'s history, `behind`/`diverged` when it is not; `commits` are the commits in `head`'s history that are not in `base`'s, so a commit is in `head` exactly when it is in that list or is `base` itself Every reader answers `null` (or throws) for a read that was REFUSED, and `[]` only for a read that found nothing.
 */
export type Range = { status: string, commits: string[] };

// ---------------------------------------------------------------------------------------------------------------------
// PURE: the metrics, from what the readers returned.

/** @param {number[]} numbers @returns {number | null} `null` for none, never `0` */
function median(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {number} ms @returns {string} the UTC date, `YYYY-MM-DD` */
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** @param {string} name @returns {Error} */
const neverPublished = (name: string): Error => Object.assign(new Error(`the registry has no package ${name}`), { code: NEVER_PUBLISHED });

/** @template T @param {() => T | null} read @returns {T | null} a read that throws is a refused one */
function attempt<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null; // a refused read is `unknown` in the report, which says so; the cause is not narrated per read
  }
}

/** @param {MergedPr} pr @param {Repository} repository @returns {boolean} a truncated file list cannot show the change was NOT releasable, so it counts */
const isReleasable = (pr: MergedPr, repository: Repository): boolean => pr.paths === null || pr.paths.length >= FILES_PAGE || pr.paths.some((path) => repository.releasablePaths.some((prefix) => path.startsWith(prefix)));

/**
 * Releases ordered by publish time, or `null` when any release has no readable time (an order cannot be trusted).
 * @param {Release[]} releases @returns {(Release & { at: number })[] | null}
 */
function ordered(releases: Release[]): (Release & { at: number; })[] | null {
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
function ancestryOf({ repository, readers, base, releases }: { repository: Repository; readers: Readers; base: string | null; releases: Release[]; }): { contains: (release: Release, commit: string) => boolean | null; inHistory: (release: Release, commit: string) => boolean | undefined; } {
  /** Keyed by COMMIT: a backport and the release it was cut beside can point at one commit, and the range is the commit's. The Set keeps the order the commits were listed in. @type {Map<string, { status: string, commits: Set<string> } | null>} */
  const ranges: Map<string, { status: string; commits: Set<string>; } | null> = new Map();
  const rangeOf = (release: Release) => {
    const head = release.commit;
    if (head === null || base === null) return null;
    if (!ranges.has(head)) {
      const range = attempt(() => { startable("compare"); return readers.range(repository, { base, head }); });
      ranges.set(head, range === null ? null : { status: range.status, commits: new Set(range.commits) });
    }
    return ranges.get(head) ?? null;
  };
  /** @type {Map<string, number> | null | undefined} undefined until first asked; null when the newest release's range is unreadable or does not descend from `base` */
  let positions: Map<string, number> | null | undefined;
  const positionsOfHistory = () => {
    if (positions !== undefined) return positions;
    const newest = releases.findLast((release) => release.commit !== null);
    const range = newest === undefined || base === null ? null : rangeOf(newest);
    const descends = range !== null && (range.status === "ahead" || range.status === "identical");
    positions = descends && base !== null ? new Map([[base, 0], ...[...range.commits].map((sha, index) => ([sha, index + 1] as [string, number]))]) : null;
    return positions;
  };
  /** A release's place in the history: its own commit's, else its ONLY PARENT's, because a tag is often a one-commit "Release x.y.z" cut from a main commit and never merged back
   *  (all but 3 of agent-org's 185 in the window), and a commit that adds nothing but itself contains what its parent does. @type {Map<string, number | undefined>} */
  const placed: Map<string, number | undefined> = new Map();
  const placeOf = (release: Release) => {
    const history = positionsOfHistory();
    const head = release.commit;
    if (history === null || head === null) return undefined;
    if (!placed.has(head)) {
      const parent = history.has(head) ? null : attempt(() => readers.parentOf?.(repository, head) ?? null);
      placed.set(head, history.get(head) ?? (parent === null ? undefined : history.get(parent)));
    }
    return placed.get(head);
  };
  const inHistory = (release: Release, commit: string) => {
    const at = placeOf(release);
    const wanted = positionsOfHistory()?.get(commit);
    return at === undefined || wanted === undefined ? undefined : at >= wanted;
  };
  const contains = (release: Release, commit: string) => {
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
function firstIndexWhere(length: number, holds: (index: number) => boolean | null): number | null {
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
function firstContaining({ commit, notBefore, releases, windowStart, contains, inHistory }: { commit: string | null; notBefore: number; releases: (Release & { at: number; })[]; windowStart: number; contains: ReturnType<typeof ancestryOf>["contains"]; inHistory: ReturnType<typeof ancestryOf>["inHistory"]; }): { release: (Release & { at: number; }) | null; unreadable: boolean; } {
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

/** what every ancestry question shares */
export type Context = Omit<Parameters<typeof firstContaining>[0], "commit" | "notBefore">;

/** @param {number} now @returns {string[]} the `LOOKBACK_DAYS` UTC dates ending with today's, oldest first */
function windowDates(now: number): string[] {
  return Array.from({ length: LOOKBACK_DAYS }, (_, back) => utcDate(now - (LOOKBACK_DAYS - 1 - back) * MS_PER_DAY));
}

/**
 * Deployment frequency: releases in the window, per UTC day, and the days a releasable change merged and nothing shipped (today excluded: it is not over).
 * @param {{ releases: (Release & { at: number })[], releasable: MergedPr[] | null, now: number }} input
 */
function deploymentFrequency({ releases, releasable, now }: { releases: (Release & { at: number; })[]; releasable: MergedPr[] | null; now: number; }) {
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
function leadTime({ releasable, context, now }: { releasable: MergedPr[]; context: Context; now: number; }): { block: object | null; reason: string | null; } {
  const minutes: number[] = [];
  const unreleased: { number: number; minutes: number; }[] = [];
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
function fixingReleases({ regressions, context }: { regressions: Regression[]; context: Context; }): { rows: { regression: Regression; fix: (Release & { at: number; }) | null; }[] | null; reason: string | null; } {
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
function changeFailure({ inWindow, fixes }: { inWindow: (Release & { at: number; })[]; fixes: (Release & { at: number; })[]; }) {
  const followed = (release: Release & { at: number; }) => fixes.some((fix) => fix.at > release.at && fix.at - release.at <= FAILURE_FOLLOW_HOURS * MS_PER_HOUR);
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
function timeToRestore({ rows, windowStart, now }: { rows: { regression: Regression; fix: (Release & { at: number; }) | null; }[]; windowStart: number; now: number; }) {
  const minutes: number[] = [];
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
const npmPackageOf = (repository: Repository): string | null => (repository.release.kind === "npm" ? repository.release.package : null);

/**
 * When `latest` moved, from a Release's notes: the time of its `Promoted to latest:` line, `null` when it has none.
 * @param {string} body @returns {string | null}
 */
export function promotionTimeFrom(body: string): string | null {
  return PROMOTION_LINE.exec(body)?.[1] ?? null;
}

/**
 * How long a version waited between `next` and `latest`: to the promotion when it has one, else to now (`unpromoted`). `unknown` when the record cannot say which.
 */
export type Wait = { id: string, state: "promoted" | "unpromoted", minutes: number } | { id: string, state: "unknown", why: string };

/** @param {{ release: Release & { at: number }, records: PromotionRecords, now: number }} input @returns {Wait} */
function waitOf({ release, records, now }: { release: Release & { at: number; }; records: PromotionRecords; now: number; }): Wait {
  const { id } = release;
  if (!Object.hasOwn(records.notes, id)) return { id, state: "unknown", why: "it has no GitHub Release to read a promotion record from" };
  const promotedAt = promotionTimeFrom(records.notes[id]);
  if (promotedAt === null) {
    return id === records.latest ? { id, state: "unknown", why: "`latest` names it and its Release records no time" }
      : { id, state: "unpromoted", minutes: (now - release.at) / MS_PER_MINUTE };
  }
  const minutes = (Date.parse(promotedAt) - release.at) / MS_PER_MINUTE;
  return minutes < 0 ? { id, state: "unknown", why: "its record says `latest` moved before it was published" } : { id, state: "promoted", minutes };
}

/** @param {Wait[]} waits the versions of the window @returns {object} `next` -> `latest`, the median and maximum over every version, the unpromoted at their current age */
function promotionLeadTime(waits: Wait[]): object {
  const minutes = waits.flatMap((wait) => (wait.state === "unknown" ? [] : [wait.minutes]));
  const unpromoted = waits.flatMap((wait) => (wait.state === "unpromoted" ? [wait.minutes] : []));
  return { medianMinutes: median(minutes), maxMinutes: Math.max(...minutes), versions: waits.length, unpromoted: unpromoted.length,
    oldestUnpromotedMinutes: unpromoted.length === 0 ? null : Math.max(...unpromoted), undefinedBecause: null };
}

/** @param {Wait[]} waits the versions of the window @returns {object} the share of them `latest` has pointed at */
function qualifiedShare(waits: Wait[]): object {
  const qualified = waits.filter((wait) => wait.state === "promoted").length;
  return { value: Math.round((PERCENT * qualified) / waits.length), qualified, published: waits.length, fewVersions: waits.length < MIN_RELEASES_FOR_A_RATE, undefinedBecause: null };
}

/** @param {string} why @returns {{ promotionLeadTime: object, qualified: object, reason: null }} both readings undefined, for a reason that is an answer */
const channelsUndefined = (why: string): { promotionLeadTime: object; qualified: object; reason: null; } => ({ promotionLeadTime: { undefinedBecause: why }, qualified: { undefinedBecause: why }, reason: null });

/** @param {Record<string, string> | undefined} tags @returns {boolean} the dist-tags were READ and name no `next`; `undefined` (not asked) is not that answer */
const publishesStraightToLatest = (tags: Record<string, string> | undefined): boolean => tags !== undefined && typeof tags.next !== "string";

/**
 * The two channel readings of the versions published in the window. ONE version whose record cannot be read leaves BOTH `unknown` (the lead time's rule too): a figure over
 * the versions that happened to be readable would read well because the unreadable ones were the slow ones.
 * A package whose dist-tags carry no `next` publishes straight to `latest`: there is nothing to wait on and no promotion to record, so both are `undefined` (an answer), never
 * `unknown` (a source that could not be read). `tags` is `null` when the registry would not say, which is NOT evidence that there is no channel (#4040).
 * @param {{ repository: Repository, versions: (Release & { at: number })[], tags?: Record<string, string> | null, records: PromotionRecords | null, now: number }} input
 * @returns {{ promotionLeadTime: object | null, qualified: object | null, reason: string | null }}
 */
function channelBlocks({ repository, versions, tags, records, now }: { repository: Repository; versions: (Release & { at: number; })[]; tags?: Record<string, string> | null; records: PromotionRecords | null; now: number; }): { promotionLeadTime: object | null; qualified: object | null; reason: string | null; } {
  if (repository.release.kind !== "npm") return channelsUndefined("its releases are tags, not npm versions: it has no channels");
  if (versions.length === 0) return channelsUndefined(`no version published in the last ${LOOKBACK_DAYS} days`);
  if (tags === null) return { promotionLeadTime: null, qualified: null, reason: `the dist-tags of ${repository.release.package} could not be read from the registry` };
  if (publishesStraightToLatest(tags)) return channelsUndefined("its releases publish straight to `latest`: it has no `next` channel");
  if (records === null) return { promotionLeadTime: null, qualified: null, reason: "its promotion records could not be read" };
  const waits = versions.map((release) => waitOf({ release, records, now }));
  const unknown = waits.filter((wait) => wait.state === "unknown");
  if (unknown.length > 0) {
    const [first] = unknown;
    return { promotionLeadTime: null, qualified: null, reason: `the promotion record of ${first.id} cannot be read (${first.why})${unknown.length > 1 ? `, and ${unknown.length - 1} more` : ""}` };
  }
  return { promotionLeadTime: promotionLeadTime(waits), qualified: qualifiedShare(waits), reason: null };
}

/** @param {Repository} repository @param {string} reason */
function unknownRepository(repository: Repository, reason: string) {
  return { repo: repository.repo, npmPackage: npmPackageOf(repository), status: ("unknown" as const), reason, oldestUnreleasedMinutes: null, deploymentFrequency: null, leadTime: null, promotionLeadTime: null, qualified: null, changeFailure: null, restore: null,
    reasons: ({} as Record<string, string>) };
}

/**
 * A regression row belongs to the window if it is still open, or was closed (by the pull request that fixed it, or by hand) inside it: one fixed before the
 * window is a restoration the window did not see, and no release in the window can be marked as followed by it.
 * @param {Regression} regression @param {number} windowStart @returns {boolean}
 */
function regressionInScope(regression: Regression, windowStart: number): boolean {
  if (regression.closedAt === null) return true;
  return Date.parse(regression.fixMergedAt ?? regression.closedAt) >= windowStart;
}

/**
 * The OLDEST commit the metrics will ask a release about: the base every range is taken from (see `ancestryOf`). `null` when nothing will be asked.
 * @param {{ releasable: MergedPr[], regressions: Regression[] }} input @returns {string | null}
 */
function oldestCommit({ releasable, regressions }: { releasable: MergedPr[]; regressions: Regression[]; }): string | null {
  const asked: { commit: string; at: number; }[] = [];
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
function readReleases({ repository, readers, windowStart }: { repository: Repository; readers: Readers; windowStart: number; }): Release[] | null {
  try {
    return readers.releases(repository, { since: new Date(windowStart).toISOString() });
  } catch (err: any) {
    return err?.code === NEVER_PUBLISHED && repository.release.kind === "npm" ? [] : null;
  }
}

/**
 * Where `latest` moved, read only for an npm repository that published a version in the window (a tag repository has no channels, and an empty window has nothing to
 * ask about), so the ordinary reading pays no call for it. `null` for a reader that is absent or refused: nothing was read.
 * @param {{ repository: Repository, readers: Readers, windowStart: number, versions: Release[] }} input @returns {PromotionRecords | null}
 */
function readPromotions({ repository, readers, windowStart, versions }: { repository: Repository; readers: Readers; windowStart: number; versions: Release[]; }): PromotionRecords | null {
  if (repository.release.kind !== "npm" || versions.length === 0) return null;
  const { promotions } = readers;
  return promotions === undefined ? null : attempt(() => promotions(repository, { since: new Date(windowStart).toISOString() }));
}

/**
 * The npm package's dist-tags, read only for an npm repository that published a version in the window. `undefined` when nothing was asked (a tag repository, an empty
 * window, a reader that is absent), `null` for a read that was refused: the two never share a value.
 * @param {{ repository: Repository, readers: Readers, versions: Release[] }} input @returns {Record<string, string> | null | undefined}
 */
function readDistTags({ repository, readers, versions }: { repository: Repository; readers: Readers; versions: Release[]; }): Record<string, string> | null | undefined {
  const { distTags } = readers;
  if (repository.release.kind !== "npm" || versions.length === 0 || distTags === undefined) return undefined;
  return attempt(() => distTags(repository));
}

/**
 * The two reads every metric stands on, or WHY the repository is unknown. No release and no merged pull request is `no release yet`, as the row that
 * declared the repository promised: the page shows it as unfinished. It is the readers' contract that makes that safe: a read that FAILED throws or
 * answers `null`, and `[]` is only a read that found nothing.
 * @param {{ repository: Repository, readers: Readers, windowStart: number }} input
 * @returns {{ refusal: string } | { releases: (Release & { at: number })[], merged: MergedPr[] | null }}
 */
function readSources({ repository, readers, windowStart }: { repository: Repository; readers: Readers; windowStart: number; }): { refusal: string; } | { releases: (Release & { at: number; })[]; merged: MergedPr[] | null; } {
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
function namingTheLimit(reason: string | null): string | null {
  const [first] = readLimits.timedOut;
  return reason === null || first === undefined ? reason : `${reason} (${first} hit its time limit)`;
}

/**
 * The channel readings of a repository: the dist-tags are asked FIRST, and a package with no `next` is not asked where `latest` moved (a paginated read of its Releases that
 * could only be thrown away).
 * @param {{ repository: Repository, readers: Readers, windowStart: number, versions: (Release & { at: number })[], now: number }} input
 */
function channelBlocksOf({ repository, readers, windowStart, versions, now }: { repository: Repository; readers: Readers; windowStart: number; versions: (Release & { at: number; })[]; now: number; }) {
  const tags = readDistTags({ repository, readers, versions });
  const decided = tags === null || publishesStraightToLatest(tags);
  return channelBlocks({ repository, versions, tags, now, records: decided ? null : readPromotions({ repository, readers, windowStart, versions }) });
}

/**
 * ONE repository's four metrics. Each block is `null` when ITS sources were refused (with the reason in `reasons`), so a refused regression list does
 * not hide a deployment frequency that was read, and none of them is ever a 0 made of an absence.
 * @param {Repository} repository @param {Readers} readers @param {number} now
 */
export function measureRepository(repository: Repository, readers: Readers, now: number) {
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
  const channel = channelBlocksOf({ repository, readers, windowStart, versions: frequency.releases, now });
  const reasons = {
    ...(lead.reason === null ? {} : { leadTime: lead.reason }),
    ...(channel.reason === null ? {} : { promotionLeadTime: channel.reason, qualified: channel.reason }),
    ...(fixing.reason === null ? {} : { changeFailure: fixing.reason, restore: fixing.reason }),
  };
  return {
    repo: repository.repo, npmPackage: npmPackageOf(repository), status: noReleaseYet ? ("no release yet" as const) : ("read" as const), reason: null,
    deploymentFrequency: frequency, leadTime: (lead.block as any), promotionLeadTime: (channel.promotionLeadTime as any), qualified: (channel.qualified as any),
    oldestUnreleasedMinutes: (lead.block as any)?.oldestUnreleasedMinutes ?? null,
    changeFailure: fixing.rows === null ? null : changeFailure({ inWindow: frequency.releases, fixes }),
    restore: fixing.rows === null ? null : timeToRestore({ rows: fixing.rows, windowStart, now }),
    reasons: (reasons as Record<string, string>),
  };
}

/** @param {Repository} repository @param {Readers} readers @param {number} now @returns {ReturnType<typeof measureRepository>} */
function measureOrUnknown(repository: Repository, readers: Readers, now: number): ReturnType<typeof measureRepository> {
  try {
    return measureRepository(repository, readers, now);
  } catch (err: any) {
    return unknownRepository(repository, `the measurement failed (${String(err?.message ?? err).split("\n")[0]})`);
  }
}

/**
 * ONE repository's reading, the unit the gate keeps as it goes (#3736). NEVER THROWS: a repository whose measure throws is `unknown` with the first line of why.
 * Every child it starts is bounded (`timeoutMs` each, `repositoryMs` for the repository), and an `unknown` that a bound caused names the call that hit it.
 * @param {{ repository: Repository, readers?: Readers, now: number, limits?: { timeoutMs?: number, repositoryMs?: number } }} input
 */
export function readRepository({ repository, readers = githubReaders, now, limits = {} }: { repository: Repository; readers?: Readers; now: number; limits?: { timeoutMs?: number; repositoryMs?: number; }; }) {
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
export function doraReport({ readings, now }: { readings: ReturnType<typeof measureRepository>[]; now: number; }) {
  return { date: utcDate(now), now, repositories: readings };
}

/**
 * THE FUNCTION: the four metrics for every declared repository, so all of them are on the page every day and an empty one is visible as empty.
 * @param {{ repositories: Repository[], readers: Readers, now: number }} input
 */
export function dora({ repositories, readers, now }: { repositories: Repository[]; readers: Readers; now: number; }) {
  return doraReport({ readings: repositories.map((repository) => readRepository({ repository, readers, now })), now });
}

export type DoraReport = ReturnType<typeof dora>;
export type RepositoryReading = DoraReport["repositories"][number];

// ---------------------------------------------------------------------------------------------------------------------
// THE ONE TABLE: what each metric is, which way is better, and how it prints.

/** @param {number} minutes @returns {string} `1d02h`, `3h10m`, `45m` */
function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < MINUTES_PER_HOUR) return `${whole}m`;
  if (whole < MINUTES_PER_DAY) return `${Math.floor(whole / MINUTES_PER_HOUR)}h${String(whole % MINUTES_PER_HOUR).padStart(2, "0")}m`;
  return `${Math.floor(whole / MINUTES_PER_DAY)}d${String(Math.floor((whole % MINUTES_PER_DAY) / MINUTES_PER_HOUR)).padStart(2, "0")}h`;
}

/** @param {any} b @returns {string} */
function frequencyText(b: any): string {
  const days = Object.entries(b.perDay).filter(([, n]) => (n as number) > 0).map(([date, n]) => `${date.slice(5)} x${n}`);
  const missed = b.missedDays === null ? "; days a releasable change merged with no release: unknown (merged pull requests unreadable)"
    : b.missedDays.length === 0 ? "" : `; MISSED (a releasable change merged, nothing shipped): ${b.missedDays.map((d: string) => d.slice(5)).join(", ")}`;
  return `${b.value} release${b.value === 1 ? "" : "s"} in ${LOOKBACK_DAYS} days${days.length === 0 ? "" : ` (${days.join(", ")})`}${missed}`;
}

/** @param {any} b @returns {string} */
function leadText(b: any): string {
  const unreleased = b.unreleased === 0 ? "" : `, ${b.unreleased} UNRELEASED (oldest ${duration(b.oldestUnreleasedMinutes)})`;
  return `median ${duration(b.medianMinutes)}, max ${duration(b.maxMinutes)} over ${b.changes} change${b.changes === 1 ? "" : "s"}${unreleased}`;
}

/** @param {any} b @returns {string} */
function promotionText(b: any): string {
  const unpromoted = b.unpromoted === 0 ? "" : `, ${b.unpromoted} UNPROMOTED (counted at current age; oldest ${duration(b.oldestUnpromotedMinutes)})`;
  return `median ${duration(b.medianMinutes)}, max ${duration(b.maxMinutes)} over ${b.versions} version${b.versions === 1 ? "" : "s"}${unpromoted}`;
}

/** @param {any} b @returns {string} */
function qualifiedText(b: any): string {
  const caveat = b.fewVersions ? `; ONLY ${b.published} version${b.published === 1 ? "" : "s"}, fewer than ${MIN_RELEASES_FOR_A_RATE}: a count of events, not a trend` : "";
  return `${b.value}% (${b.qualified} of ${b.published} versions have been \`latest\`)${caveat}`;
}

/** @param {any} b @returns {string} */
function failureText(b: any): string {
  const caveat = b.fewReleases ? `; ONLY ${b.releases} release${b.releases === 1 ? "" : "s"}, fewer than ${MIN_RELEASES_FOR_A_RATE}: a count of events, not a trend` : "";
  return `${b.value}% (${b.failed} of ${b.releases} releases)${caveat}`;
}

/** @param {any} b @returns {string} */
function restoreText(b: any): string {
  const open = b.unrestored === 0 ? "" : `, ${b.unrestored} UNRESTORED (counted at current age)`;
  const loose = b.unattributed === 0 ? "" : `; ${b.unattributed} closed with no pull request behind it, not measured`;
  return `median ${duration(b.value)}, max ${duration(b.maxMinutes)} over ${b.rows} row${b.rows === 1 ? "" : "s"}${open}${loose}`;
}

/** @param {number | null | undefined} n @returns {number | null} whole units, `null` staying `null` */
const whole = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : Math.round(n));

/**
 * Every metric: its id, which way is better, the block of a repository's reading it comes from, and how it prints. A block that is `null` is an
 * UNKNOWN metric; one with `undefinedBecause` is an UNDEFINED one; neither is a number. Every printed line ends with its direction.
 * `targetMinutes` is the chairman's target for a duration metric (`null`: none is set), printed beside the number.
 * @type {readonly { id: string, title: string, label: string, better: "lower" | "higher", block: "deploymentFrequency" | "leadTime" | "promotionLeadTime" | "qualified" | "changeFailure" | "restore",
 *   targetMinutes: number | null, of: (block: any) => number | null, text: (block: any) => string }[]}
 */
export const DORA_METRICS: readonly {
    id: string; title: string; label: string; better: "lower" | "higher"; block: "deploymentFrequency" | "leadTime" | "promotionLeadTime" | "qualified" | "changeFailure" | "restore";
    targetMinutes: number | null; of: (block: any) => number | null; text: (block: any) => string;
}[] = Object.freeze([
  { id: "deploymentFrequency", title: "Deployment frequency", label: "Deployment frequency (releases in 14 days)", better: "higher", block: "deploymentFrequency", targetMinutes: null, of: (b) => b.value, text: frequencyText },
  { id: "leadTimeMedianMinutes", title: "Lead time for changes", label: "Lead time for changes, median (minutes)", better: "lower", block: "leadTime", targetMinutes: NEXT_TARGET_MINUTES, of: (b) => whole(b.medianMinutes), text: leadText },
  { id: "leadTimeMaxMinutes", title: "Lead time for changes", label: "Lead time for changes, max (minutes)", better: "lower", block: "leadTime", targetMinutes: null, of: (b) => whole(b.maxMinutes), text: leadText },
  { id: "promotionLeadTimeMedianMinutes", title: "Lead time, next to latest", label: "Lead time next to latest, median (minutes)", better: "lower", block: "promotionLeadTime", targetMinutes: LATEST_TARGET_MINUTES, of: (b) => whole(b.medianMinutes), text: promotionText },
  { id: "qualifiedSharePercent", title: "Versions qualified", label: "Versions qualified (% of those published in 14 days)", better: "higher", block: "qualified", targetMinutes: null, of: (b) => b.value, text: qualifiedText },
  { id: "changeFailureRatePercent", title: "Change failure rate", label: "Change failure rate (%)", better: "lower", block: "changeFailure", targetMinutes: null, of: (b) => b.value, text: failureText },
  { id: "timeToRestoreMedianMinutes", title: "Time to restore", label: "Time to restore, median (minutes)", better: "lower", block: "restore", targetMinutes: null, of: (b) => whole(b.value), text: restoreText },
]);

/**
 * @param {RepositoryReading} reading @param {(typeof DORA_METRICS)[number]} metric
 * @returns {{ state: "value", value: number | null } | { state: "undefined" | "unknown", reason: string }}
 */
export function metricState(reading: RepositoryReading, metric: (typeof DORA_METRICS)[number]): { state: "value"; value: number | null; } | { state: "undefined" | "unknown"; reason: string; } {
  const block = (reading as any)[metric.block];
  if (block === undefined) return { state: "unknown", reason: "this reading was taken before the metric existed" };
  if (block === null) return { state: "unknown", reason: reading.reason ?? reading.reasons[metric.block] ?? "its source could not be read" };
  if (block.undefinedBecause !== null) return { state: "undefined", reason: block.undefinedBecause };
  return { state: "value", value: metric.of(block) };
}

/** The id a repository's metric is trended under. */
export const doraNumberId = (repo: string, metricId: string) => `dora:${repo}:${metricId}`;

/**
 * The numbers the retrospective trends: one per repository per metric, `null` for UNKNOWN and for UNDEFINED alike (the declarations say which).
 * @param {DoraReport | null | undefined} report @returns {Record<string, number | null>}
 */
export function doraNumbers(report: DoraReport | null | undefined): Record<string, number | null> {
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
export function doraDeclarations(report: DoraReport | null | undefined): { id: string; label: string; better: "lower" | "higher"; undefinedToday: boolean; }[] {
  if (!report) return [];
  return report.repositories.flatMap((reading) => DORA_METRICS.map((metric) => ({
    id: doraNumberId(reading.repo, metric.id), label: `${reading.repo}: ${metric.label}`, better: metric.better, undefinedToday: metricState(reading, metric).state === "undefined",
  })));
}

/** One line per BLOCK: lead time's median and maximum are one sentence, so the table's second row of a block prints nothing. */
const PRINTED = DORA_METRICS.filter((metric, index) => DORA_METRICS.findIndex((first) => first.block === metric.block) === index);

/** @param {(typeof DORA_METRICS)[number]} metric @returns {string} ` (target under 30m)` beside the title, and nothing for a metric with no target */
const targetNote = (metric: (typeof DORA_METRICS)[number]): string => (metric.targetMinutes === null ? "" : ` (target under ${duration(metric.targetMinutes)})`);

/** @param {RepositoryReading} reading @returns {string[]} */
function repositoryLines(reading: RepositoryReading): string[] {
  if (reading.status === "unknown") return [`- ${reading.repo}: ${UNKNOWN} -- ${reading.reason}. Not 0: nothing was measured.`];
  const age = reading.oldestUnreleasedMinutes === null ? "" : `; oldest unreleased merge is ${duration(reading.oldestUnreleasedMinutes)} old`;
  const lines = [reading.status === "no release yet" ? `- ${reading.repo}: no release yet${age}` : `- ${reading.repo}:`];
  for (const metric of PRINTED) {
    const state = metricState(reading, metric);
    const body = state.state === "value" ? metric.text((reading as any)[metric.block]) : `${state.state} -- ${state.reason}`;
    lines.push(`    ${metric.title}${targetNote(metric)}: ${body} (${metric.better} is better)`);
  }
  return lines;
}

/**
 * Which npm package each npm repository's releases are read from: ONE, so a release of another package in it is not counted, and the page says so
 * rather than leaving a reader to assume every package is. A report cached before this field existed names none, and prints no line.
 * @param {DoraReport} report @returns {string[]}
 */
function packagesLine(report: DoraReport): string[] {
  const read = report.repositories.flatMap((reading) => (reading.npmPackage ? [`${reading.repo} reads \`${reading.npmPackage}\``] : []));
  return read.length === 0 ? [] : [`- npm releases are read from ONE package per repository (a release of another is not a deployment here): ${read.join("; ")}`];
}

/**
 * The DORA block as the text `ceo` is handed and posts on #928.
 * @param {DoraReport} report @returns {string[]}
 */
export function renderDora(report: DoraReport): string[] {
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
let readLimits: { timeoutMs: number; deadlineAt: number; timedOut: string[]; } = { timeoutMs: READ_TIMEOUT_MS, deadlineAt: Infinity, timedOut: [] };

/** @param {string} command @param {string[]} args @returns {string} the call as a person would name it: the command and the first two words that are not flags */
const callName = (command: string, args: string[]): string => [command, ...args.filter((arg) => !arg.startsWith("-")).slice(0, 2)].join(" ");

/**
 * The milliseconds left of this repository's budget, or a throw that records `call` as the one the budget ended. Every read starts here, so a reader that
 * does not go through `run` (the ones a test injects) is bound by the same deadline.
 * @param {string} call @returns {number}
 */
function startable(call: string): number {
  const left = readLimits.deadlineAt - Date.now();
  if (left <= 0) {
    readLimits.timedOut.push(call);
    throw new Error(`${call} was not started: this repository's read budget is spent`);
  }
  return left;
}

/** @param {string} command @param {string[]} args @returns {string} */
function run(command: string, args: string[]): string {
  const call = callName(command, args);
  const timeout = Math.min(readLimits.timeoutMs, startable(call));
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"], timeout });
  } catch (err: any) {
    if (err?.code !== "ETIMEDOUT") throw err;
    readLimits.timedOut.push(call);
    throw new Error(`${call} timed out after ${Math.round(timeout / 1000)} s`, { cause: err });
  }
}

/** @param {string[]} args @returns {any} */
const ghJson = (args: string[]): any => JSON.parse(run("gh", args));

/**
 * The ONE parent of every commit this process has read, keyed `repo@sha` (a commit's parents never change, so it is never stale): `null` for a commit with none or with two.
 * Filled by the call that resolves a release's commit, which already carries the parents, so knowing them costs no read of its own (a11ign/a11ign#3910).
 * @type {Map<string, string | null>}
 */
const onlyParents: Map<string, string | null> = new Map();

/** @param {string} repo @param {string} ref @returns {{ sha: string, parent: string | null } | null} the commit a tag or sha names; `null` when GitHub does not know it */
function readCommit(repo: string, ref: string): { sha: string; parent: string | null; } | null {
  const answer = attempt(() => run("gh", ["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`, "--jq", `[.sha, (.parents | map(.sha) | join(","))] | join(" ")`]).trim());
  const [sha, parents = ""] = answer === null ? [] : answer.split(" ");
  if (sha === undefined || sha.length !== SHA_LENGTH) return null;
  const parent = parents.length === SHA_LENGTH ? parents : null;
  onlyParents.set(`${repo}@${sha}`, parent);
  return { sha, parent };
}

/** @param {string} repo @param {string} ref @returns {string | null} the commit a tag or sha names; `null` when GitHub does not know it */
const commitOf = (repo: string, ref: string): string | null => readCommit(repo, ref)?.sha ?? null;

/** @param {string} repo @param {string} commit @returns {string | null} its only parent, `null` when it has none or two, or it could not be read */
function parentOf(repo: string, commit: string): string | null {
  const key = `${repo}@${commit}`;
  return onlyParents.has(key) ? onlyParents.get(key) ?? null : readCommit(repo, commit)?.parent ?? null;
}

/**
 * A release's commit, resolved only for a release inside the window: one older cannot contain a change merged in it, and asking for every tag of a
 * long-lived package is hundreds of calls for nothing. `null` for an older one, and for one no lookup can place. `lookups` run in order and stop at the
 * first answer, so a costlier read is only made for a release the cheaper ones could not place.
 * @param {{ publishedAt: string | undefined, since: string, known: string | undefined, lookups: (() => string | null)[] }} release @returns {string | null}
 */
function resolveCommit({ publishedAt, since, known, lookups }: { publishedAt: string | undefined; since: string; known: string | undefined; lookups: (() => string | null)[]; }): string | null {
  if (known) return known;
  if (publishedAt === undefined || Date.parse(publishedAt) < Date.parse(since)) return null;
  for (const lookup of lookups) {
    const commit = lookup();
    if (commit !== null) return commit;
  }
  return null;
}

/** A version that held a package NAME (`0.0.0-reserved.0`, `0.0.0-stage`): published to reserve it, never a deployment of anything. @param {string} version */
export const isNameReservation = (version: string) => version.startsWith("0.0.0-");

/**
 * The commit a version's provenance attestation says it was built from. Reads only the `slsa.dev/provenance/v1` statement and only a 40-character
 * `gitCommit`, so a malformed or absent one is `null` (unplaced, i.e. `unknown`), never a guess.
 * @param {any} document the registry's `attestations` document for one version @returns {string | null}
 */
export function commitFromAttestations(document: any): string | null {
  const payload = document?.attestations?.find((a: any) => a?.predicateType === PROVENANCE_PREDICATE)?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") return null;
  const statement = attempt(() => JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
  const source = statement?.predicate?.buildDefinition?.resolvedDependencies?.find((dependency: any) => dependency?.digest?.gitCommit);
  const commit = source?.digest?.gitCommit;
  return typeof commit === "string" && commit.length === SHA_LENGTH && /^[0-9a-f]+$/.test(commit) ? commit : null;
}

export type CommitReaders = { commitOf: (repo: string, ref: string) => string | null, attestedCommit: (npmPackage: string, version: string) => string | null };

/**
 * The releases of an npm package from its registry document: name reservations dropped, and each version in the window placed by its `gitHead`, then its
 * tag, then its attestation. The attestation read costs ONE request per release in the window that has neither of the first two.
 * @param {{ document: any, repository: Repository & { release: { kind: "npm", package: string } }, since: string, commits: CommitReaders }} input @returns {Release[]}
 */
export function npmReleasesFrom({ document, repository, since, commits }: { document: any; repository: Repository & { release: { kind: "npm"; package: string; }; }; since: string; commits: CommitReaders; }): Release[] {
  const npmPackage = repository.release.package;
  return Object.entries(document.versions ?? {}).filter(([version]) => !isNameReservation(version)).map(([version, meta]) => ({
    id: version, publishedAt: document.time?.[version], deprecated: Boolean((meta as any).deprecated),
    commit: resolveCommit({ publishedAt: document.time?.[version], since, known: (meta as any).gitHead,
      lookups: [() => commits.commitOf(repository.repo, `v${version}`), () => commits.attestedCommit(npmPackage, version)] }),
  }));
}

/** @param {string} npmPackage @param {string} version @returns {string | null} `null` when the attestation cannot be read or names no commit */
function attestedCommit(npmPackage: string, version: string): string | null {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${npmPackage.replace("/", "%2f")}@${version}`;
  return attempt(() => commitFromAttestations(JSON.parse(run("curl", ["-sSf", "--max-time", String(READ_TIMEOUT_SECONDS), "-H", "Accept: application/json", url]))));
}

/** @param {Repository & { release: { kind: "npm", package: string } }} repository @param {{ since: string }} window @returns {Release[]} */
function npmReleases(repository: Repository & { release: { kind: "npm"; package: string; }; }, { since }: { since: string; }): Release[] {
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
function tagReleases(repository: Repository, { since }: { since: string; }): Release[] {
  const rows = ghJson(["api", `repos/${repository.repo}/releases`, "--paginate", "--slurp"]).flat();
  return rows.filter((r: any) => !r.draft && typeof r.tag_name === "string" && r.tag_name.startsWith("v")).map((r: any) => ({
    id: r.tag_name, publishedAt: r.published_at, deprecated: false,
    commit: resolveCommit({ publishedAt: r.published_at, since, known: undefined, lookups: [() => commitOf(repository.repo, r.tag_name)] }),
  }));
}

/**
 * The records of a package's promotions: the notes of each GitHub Release named `<package>@<version>`, keyed by version (drafts are not Releases yet), beside the version
 * `latest` names now. A Release of another package of the repository is not this package's version.
 * @param {{ releases: any[], latest: string | null, npmPackage: string }} input @returns {PromotionRecords}
 */
export function promotionRecordsFrom({ releases, latest, npmPackage }: { releases: any[]; latest: string | null; npmPackage: string; }): PromotionRecords {
  const prefix = `${npmPackage}@`;
  const named = releases.filter((release) => !release.draft && typeof release.tag_name === "string" && release.tag_name.startsWith(prefix));
  return { latest, notes: Object.fromEntries(named.map((release) => [release.tag_name.slice(prefix.length), release.body ?? ""])) };
}

/** @param {string} npmPackage @returns {Record<string, string>} the package's dist-tags; throws when the registry cannot say */
function distTagsOf(npmPackage: string): Record<string, string> {
  const url = `https://registry.npmjs.org/-/package/${npmPackage.replace("/", "%2f")}/dist-tags`;
  const tags = JSON.parse(run("curl", ["-sSf", "--max-time", String(READ_TIMEOUT_SECONDS), "-H", "Accept: application/json", url]));
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) throw new Error(`the registry's dist-tags for ${npmPackage} are not a map`);
  return tags;
}

/** @param {string} npmPackage @returns {string | null} the version the `latest` dist-tag names; throws when the registry cannot say */
function latestTag(npmPackage: string): string | null {
  const { latest } = distTagsOf(npmPackage);
  return typeof latest === "string" ? latest : null;
}

/** @param {Repository & { release: { kind: "npm", package: string } }} repository @returns {PromotionRecords} */
function promotionRecords(repository: Repository & { release: { kind: "npm"; package: string; }; }): PromotionRecords {
  const npmPackage = repository.release.package;
  const releases = ghJson(["api", `repos/${repository.repo}/releases`, "--paginate", "--slurp"]).flat();
  return promotionRecordsFrom({ releases, latest: latestTag(npmPackage), npmPackage });
}

/**
 * The `regression` rows of a repository, `[]` for one whose issues are DISABLED (it has no rows and can have none: `gh issue list` refuses it, which would
 * read as `unknown` for every metric of a repository that only exists to hold code, #3171). A failed read of the setting itself throws, and is refused.
 * @param {string} repo @param {string} since @returns {Regression[]}
 */
function regressionRows(repo: string, since: string): Regression[] {
  if (ghJson(["repo", "view", repo, "--json", "hasIssuesEnabled"]).hasIssuesEnabled !== true) return [];
  return ghJson(["issue", "list", "-R", repo, "--label", "regression", "--state", "all", "--limit", "200",
    "--json", "number,createdAt,closedAt,closedByPullRequestsReferences"]).map((row: any) => ({
    number: row.number, openedAt: row.createdAt, closedAt: row.closedAt ?? null,
    ...(row.closedAt && row.closedAt >= since ? fixOf(repo, row.closedByPullRequestsReferences ?? []) : { fixCommit: null, fixMergedAt: null }),
  }));
}

export const githubReaders: Readers = {
  releases: (repository, window) => (repository.release.kind === "npm" ? npmReleases((repository as any), window) : tagReleases(repository, window)),
  mergedPrs: (repository, { since }) => ghJson(["pr", "list", "-R", repository.repo, "--state", "merged", ...(since === null ? [] : ["--search", `merged:>=${since}`]),
    "--limit", "1000", "--json", "number,mergedAt,mergeCommit,files"]).map((pr: any) => ({
    number: pr.number, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? null, paths: Array.isArray(pr.files) ? pr.files.map((f: any) => f.path) : null,
  })),
  regressions: (repository, { since }) => regressionRows(repository.repo, since),
  promotions: (repository) => (repository.release.kind === "npm" ? promotionRecords((repository as any)) : null),
  distTags: (repository) => (repository.release.kind === "npm" ? distTagsOf(repository.release.package) : null),
  // `compare/<base>...<head>`, every page: `status` once, and the commits of `head` that `base` lacks.
  parentOf: (repository, commit) => parentOf(repository.repo, commit),
  range: (repository, { base, head }) => {
    const pages = ghJson(["api", `repos/${repository.repo}/compare/${base}...${head}?per_page=100`, "--paginate", "--slurp"]);
    return { status: pages[0].status, commits: pages.flatMap((page: any) => page.commits.map((commit: any) => commit.sha))};
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
function fixOf(repo: string, references: { number: number; repository?: { name: string; owner: { login: string; }; }; }[]): { fixCommit: string | null; fixMergedAt: string | null; } {
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
export function readDora({ repositories, now, readers = githubReaders }: { repositories: Repository[]; now: number; readers?: Readers; }) {
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
  const { homeProjectDeclaration } = await import("./project-config.ts");
  process.stdout.write(`${renderDora(readDora({ repositories: homeProjectDeclaration().dora, now })).join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main().catch((err: any) => {
    process.stderr.write(`dora: ${String(err?.message ?? err)}\n`);
    process.exit(1);
  });
}
