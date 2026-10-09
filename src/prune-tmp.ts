// @ts-check
// command: classify every /tmp entry this host leaks, and remove only the ones an authority calls dead
//
// `/tmp` ON THE AGENTS HOST IS A 16G RAM-BACKED tmpfs, AND THE RESOURCE THAT RUNS OUT IS RAM. It reached
// 80% (3.1G free) on 2026-09-23T14:2xZ and a write failed with `disk quota exceeded`; the root disk was
// 47% at the same moment, so anything watching DISK saw nothing. The chairman cleared ~2.5G by hand. That
// hand pass is what does not scale, and it is why this file exists rather than a cleanup (#2166).
//
// THE NAMING IS THE WHOLE TRAP, AND IT IS WHY THIS IS A CLASSIFIER RATHER THAN A GLOB. The obvious
// remedy -- a sweep keyed to `rv-*`, which is what the hand cleanup implies -- sees 3 of 240 review
// leftovers and NONE of the 6.2G of dead session scratchpads that actually filled the tmpfs. Measured on
// the host at `d9521699e`, 2026-09-23T20:5xZ: 297 review-family entries under six different spellings,
// 1,009 session scratchpads totalling 6,931 MB. A leak measured by one spelling is not the same thing as
// a leak (#2146's lesson, arriving through a different door).
//
// A THIRD FAMILY IS THE ONE THAT FILLED THE DISK, AND A TIMER NOW RUNS THIS (#3849, incident #3846). On 2026-10-06 `/tmp` held
// 121,411 entries, all but a few thousand of them test fixtures that were made and never removed, and the host's soft lockup
// was an `rmdir` over a directory that size. So the sweep is now a JANITOR, not a report: `tmp-prune.timer` runs it every minute
// as `Nice=19` / `IOSchedulingClass=idle`, and it does a SMALL amount of work per run -- `MAX_REMOVALS_PER_RUN` filesystem
// entries, a pause after each, and never one `rm -r` of a tree. The pile is cleared by that same code over its first runs, not
// by a one-off script, so what removes 121k entries gently is what keeps it from growing back.
//
// TWO FAMILIES WERE CLASSIFIED FIRST, AND EVERYTHING ELSE IS NAMED AS UNRECOGNISED RATHER THAN GUESSED AT:
//   - REVIEW LEFTOVERS, direct children of `/tmp`, carrying a pull request number in the name under six
//     observed spellings (`rv<n>…`, `rv-<n>…`, `rv2-<n>…`, `review-base-<n>`, `reviewer-source-<n>`,
//     `npm-cache-<n>`, `npm-cache-rv2-<n>`). Removable only when that pull request is CLOSED.
//   - SESSION SCRATCHPADS at `/tmp/claude-1000/<project>/<session-uuid>`. Removable only when no
//     authority below can find a live session behind the uuid.
// `classifyEntry` answers for ANY path handed to it, including one in neither family -- that answer is a
// REFUSAL naming the path as unrecognised, never a silent skip and never a removal. The sweep walks only
// the two families, because `/tmp` held 40,116 entries at the same measurement and this tool does not
// claim to know what `board.json` (168M) or `tsx-1000` (141M) are for.
//
// ## Liveness cannot be read off a session list, and the trap is measured
//
// `herdr --session org workspace list` returns `label`, `workspace_id` and `agent_status` -- and NO session
// uuid. It answers "which sessions are alive", never "which scratchpad is theirs". Worse, every live
// `claude` process runs `claude --resume <uuid>` holding `<that uuid>/tasks` open, and that uuid is the one
// it STARTED with: `prompt:session`/`wake.mjs` clear before every order, and a clear mints a NEW uuid and a
// NEW scratchpad. Measured 2026-09-23T21:5xZ on this host: six live `claude` processes, every argv uuid
// 7-9h cold, while the uuid each of those sessions is actually WRITING is named by no process at all.
//
// **So a sweep keyed on "is this uuid live" preserves the dead uuids and deletes the live ones, including
// its own.** That is the failure this file's refusals exist to prevent, and it is why there are four of
// them rather than one:
//
//   1. SELF -- `CLAUDE_CODE_SESSION_ID` is set in the environment of every process a session spawns, and it
//      carries the CURRENT uuid rather than the resumed one (measured: three live subprocesses read
//      `14cd3061…`, `5913388d…`, `d66ddfbe…`, none of which appears in any argv). A sweep run by a session
//      therefore knows its own scratchpad, which is the one thing a naive sweep deletes first.
//   2. HELD -- any running process naming the path in an open fd, its cwd, its argv or its environment.
//      This is what catches the six resumed uuids, and it caught a live `/bin/bash` running a script FROM
//      inside a scratchpad.
//   3. OPEN PULL REQUEST -- a review leftover whose pull request is still open is somebody's current work.
//   4. RECENT WRITES -- the window below, which is the only authority that can see a live session holding
//      no subprocess and no open handle. It is load-bearing for exactly that case, so it is generous.
//
// Each is a REFUSAL WITH A REASON, printed against the path. A refusal nobody can read is the same defect
// as no refusal at all -- that is `formatReport`'s whole job.
//
// ## Nothing here can tell you a refusal did not happen, so read this back per PATH
//
// #2012 measured a would-remove COUNT reading 79 before a change and 79 after it, with different
// membership, because the population moves between runs minutes apart. Both populations here move faster
// than that: a scratchpad is minted on every clear. So `prune-tmp.test.ts` reads this back by calling
// `classifyEntry` on a NAMED path and quoting its reason, never by watching a total, and the CLI prints
// the reason beside every path for the same reason.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, lstatSync, readlinkSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
// RELATIVE rather than `@a11ign/screenreader-fleet/cli-flags` for the reason `prune-worktrees.mjs` records:
// files in this package run before `pnpm install`, where a package specifier dies.
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { worktreeOwner } from "./worktree-owner.ts";
import { claimRefusal, nestedWorktrees, recordRemoval, worktreeBranch } from "./worktree-removal.ts";

/**
 * How long after its newest write a path stops counting as somebody's current work.
 *
 * TWENTY-FOUR HOURS, AND THE WINDOW IS DOING REAL WORK HERE rather than being a formality. `prune-
 * worktrees.mjs` can afford ten minutes because `heldByOwner` carries the fact its window cannot; this
 * file has no such second signal for a LIVE SESSION THAT HAPPENS TO HOLD NO SUBPROCESS AND NO OPEN
 * HANDLE. Measured 2026-09-23: of eight live workspaces, only three had a subprocess whose environment
 * named their current uuid, and only one of the remaining current scratchpads was held open by anything.
 * An org session is idle between wakes by design (#2020's finding, one layer out), so the window has to
 * span a wake gap or it calls a waiting session cold.
 *
 * NAMED FAILURE MODE: a session woken less often than this, that writes nothing to its scratchpad and
 * spawns nothing for a whole day, is invisible to all four authorities and could be pruned. Twenty-four
 * hours is three times the 7-9h coldness measured on the six live processes, which is the margin bought.
 *
 * WHAT MOVING IT COSTS, measured on the host population the same day, so the next reader can price a
 * change rather than argue it: older than 24h is 698 scratchpads / 6,449 MB of the 1,009 / 6,931 MB
 * present; older than 48h is 439 / 2,181 MB. The two largest dead scratchpads (3.5G and 1.1G together)
 * sit between those two marks, so DOUBLING THE WINDOW GIVES UP TWO THIRDS OF THE SPACE. That is the
 * trade, and it is why widening is a decision rather than a tidy-up.
 */
const MS_PER_HOUR = 60 * 60 * 1000;

/** What the removal log names as the asker. */
const CALLER = "prune-tmp.mjs";
export const ACTIVITY_WINDOW_MS = 24 * MS_PER_HOUR;

/** Where session scratchpads live, relative to the tmp root: `<tmp>/claude-1000/<project>/<uuid>`. */
export const SCRATCHPAD_ROOT = "claude-1000";

/** `<root>/<project>/<uuid>`: the depth at which a scratchpad belongs to ONE session. */
const SCRATCHPAD_DEPTH = 3;

/**
 * THE BUDGET OF ONE RUN, counted in filesystem removals (a file, or a directory once it is empty). Three hundred is "a few hundred"
 * (chairman, 2026-10-06): small enough that one run cannot hold a directory's dentry lock for the 26 s the lockup began with, and
 * large enough that a one-minute timer clears ~430k entries a day. A tree that does not fit in what is left of the budget is
 * stopped at a leaf and finished by the next run.
 */
export const MAX_REMOVALS_PER_RUN = 300;

/** The pause after EACH removal, so the kernel's dentry work is spread over the run instead of arriving as one burst. */
export const PAUSE_BETWEEN_REMOVALS_MS = 20;

/** The most paths one run will look at, so a `/tmp` of young fixtures costs a bounded number of `stat` calls, not 120,000. */
export const MAX_EXAMINED_PER_RUN = 10 * MAX_REMOVALS_PER_RUN;

/** How many refusals of the fixture family are printed one by one; the rest are tallied by reason (a run can refuse thousands). */
const FIXTURE_REFUSALS_PRINTED = 10;

/** How long a fixture directory must have been untouched. One hour: a test run is minutes, and the HELD check covers a slow one. */
export const FIXTURE_WINDOW_MS = MS_PER_HOUR;

/**
 * The directory-name prefixes the repository's own test fixtures make directly under `/tmp` (`mkdtemp(join(tmpdir(), "<prefix>"))`),
 * each read off the host's measured pile on 2026-10-06 AND found in a test file of this repository, so a name here is a fixture and
 * not a guess. The first seven are the ones #3848 names; the rest are the next largest on that day. A fixture family not listed is
 * UNRECOGNISED and left alone: the private TMPDIR of #3854 is what stops the long tail, this list is only what clears the pile.
 */
export const FIXTURE_PREFIXES = [
  "verify-stamp-test-", "pr-review-verdict-", "host-units-", "ingest-state-", "closes-check-", "trace-weekly-", "prune-tmp-fixture-",
  "org-retro-", "watch-cli-", "gh-wrapper-render-", "gh-calls-", "trace-publish-", "close-rows-full-form-", "removal-log-",
  "review-removal-log-", "dora-resumes-",
];

/**
 * The name a fixture directory is RENAMED to before its removal starts. A rename is one atomic call, and what it buys is a STATE:
 * a tree half-removed by a run that was killed, or that spent its budget, no longer looks young (removing its children refreshed its
 * mtime) and no longer carries a fixture name, so the next run finds it by this prefix alone and finishes it, whatever its age.
 */
export const DOOMED_PREFIX = ".prune-tmp-doomed-";

/** A session uuid, as the scratchpad directories spell it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The review-family prefixes, LONGEST-MATCH FIRST, because the order is load-bearing.
 *
 * `rv2-` is reviewer-2's prefix, so `rv2-1554-corpus.mjs.orig` is pull request 1554 and NOT pull request
 * 2 -- which is what a naive leading-digit read gives, and which would compare the leftovers of a live
 * reviewer against the state of an ancient pull request. `npm-cache-rv2-2184` is the same trap nested one
 * deeper. Every spelling here was read off the host rather than imagined; `prune-tmp.test.ts` pins the
 * ambiguous pair by name.
 */
export const REVIEW_PREFIXES = [
  "npm-cache-rv2-", "npm-cache-", "reviewer-source-", "review-base-", "rv2-", "rv-", "rv",
];

export type Family = { family: "review", pr: number } | { family: "scratchpad", session: string, project: string } | { family: "fixture", prefix: string } | { family: "doomed" } | { family: "unknown" };

/**
 * Which family a path BELONGS TO, read from its name alone -- pure, so the test can ask it about a
 * spelling without that spelling existing on any host.
 *
 * @param {string} relativePath a path relative to the tmp root, `/`-separated
 * @returns {Family}
 */
export function familyOf(relativePath: string): Family {
  const parts = relativePath.split("/").filter((part) => part !== "");
  if (parts[0] === SCRATCHPAD_ROOT) {
    // `<root>/<project>/<uuid>` and nothing shallower: the project directory itself is shared by every
    // session that ever ran there, and removing it takes the live ones with it.
    if (parts.length !== SCRATCHPAD_DEPTH || !UUID.test(parts[2])) return { family: "unknown" };
    return { family: "scratchpad", session: parts[2], project: parts[1] };
  }
  if (parts.length !== 1) return { family: "unknown" };
  if (parts[0].startsWith(DOOMED_PREFIX)) return { family: "doomed" };
  const pr = reviewPullRequest(parts[0]);
  if (pr !== null) return { family: "review", pr };
  const prefix = FIXTURE_PREFIXES.find((candidate) => parts[0].startsWith(candidate) && parts[0].length > candidate.length);
  return prefix === undefined ? { family: "unknown" } : { family: "fixture", prefix };
}

/**
 * The pull request number a review-family name carries, or `null` when the name is not one.
 * @param {string} name @returns {number | null}
 */
function reviewPullRequest(name: string): number | null {
  for (const prefix of REVIEW_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const digits = /^\d+/.exec(name.slice(prefix.length));
    // A prefix with no number behind it names no pull request, so nothing can say whether it is finished.
    if (digits !== null) return Number(digits[0]);
  }
  return null;
}

const defaultRun: (cmd: string, args: string[]) => string = (cmd, args): string => execFileSync(cmd, args, { encoding: "utf8" });

/**
 * How many pull requests `openPullRequests` will ask for. A listing that comes back AT the limit has been
 * truncated, and a truncated open list reads a still-open pull request as closed -- which is the one
 * mistake this authority exists to prevent. So the limit is far above any plausible open count and
 * reaching it is an error rather than an answer.
 */
const OPEN_PR_LIMIT = 300;

/**
 * The open pull request numbers, or `"unknown"` -- NEVER a partial set.
 *
 * ABSENCE FROM THIS SET IS WHAT AUTHORISES A REMOVAL, so every way of failing to read it has to answer
 * `"unknown"` rather than an empty or short list: `gh` missing, the pool exhausted, the JSON unparseable,
 * or the listing truncated at the limit. An empty set is a legitimate answer (no pull request is open) and
 * is returned as one; a set that CAME BACK SHORT is not.
 *
 * Spends the GRAPHQL pool, once per run -- `gh pr list` is a `gh` subcommand, not `gh api` (the two read
 * different pools, and a healthy `core` says nothing about `graphql`).
 *
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {Set<number> | "unknown"}
 */
export function openPullRequests({ run = defaultRun }: { run?: typeof defaultRun; } = {}): Set<number> | "unknown" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run("gh", ["pr", "list", "--state", "open", "--json", "number",
      "--limit", String(OPEN_PR_LIMIT)]));
  } catch {
    return "unknown";
  }
  if (!Array.isArray(parsed) || parsed.length >= OPEN_PR_LIMIT) return "unknown";
  const numbers = parsed.map((row) => (row as { number?: unknown })?.number);
  // `typeof`, not `Number(...)`: a coercion turns `"2049"` and `null` into plausible numbers, and a
  // listing shaped differently from the one this function asked for is a listing it did not understand.
  return numbers.every((n) => typeof n === "number" && Number.isInteger(n))
    ? new Set((numbers as number[])) : "unknown";
}

/**
 * Every string a running process could be naming a path in: its open fds, its cwd, its argv and its
 * environment. Returns `"unknown"` when `/proc` itself cannot be listed, because "no process holds
 * anything" and "I could not look" must not be the same answer.
 *
 * A process that disappears mid-read, or belongs to another user, contributes nothing and is not an
 * error -- that is the ordinary case on a shared host, not a failure to look.
 *
 * @param {string} procRoot @returns {string[] | "unknown"}
 */
export function processStrings(procRoot: string = "/proc"): string[] | "unknown" {
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return "unknown";
  }
  const strings: string[] = [];
  for (const pid of pids) {
    const dir = join(procRoot, pid);
    for (const name of ["cmdline", "environ"]) {
      try { strings.push(readFileSync(join(dir, name), "utf8").split("\0").join(" ")); } catch { /* gone or not ours */ }
    }
    try { strings.push(readlinkSync(join(dir, "cwd"))); } catch { /* gone or not ours */ }
    strings.push(...openFdTargets(join(dir, "fd")));
  }
  return strings;
}

/** Where every open fd of one process points. `[]` when the directory is gone or not ours.
 * @param {string} fdDir @returns {string[]} */
function openFdTargets(fdDir: string): string[] {
  const targets: string[] = [];
  let entries;
  try { entries = readdirSync(fdDir); } catch { return targets; }
  for (const entry of entries) {
    try { targets.push(readlinkSync(join(fdDir, entry))); } catch { /* fd closed between the two calls */ }
  }
  return targets;
}

/**
 * The classified entries any running process names, as ABSOLUTE paths of the entries themselves.
 *
 * SUBSTRING, NOT PREFIX, and deliberately the conservative direction. An fd or a cwd is a resolved path
 * and a prefix test would do; an argv or an environment is arbitrary text that may carry the path as
 * `--out=/tmp/rv-2087-x/a` or inside a whole shell script. A substring match therefore refuses MORE than
 * it must -- a process merely mentioning a path holds it, by this reading -- and every extra refusal is a
 * path left on disk, which is the side this file errs towards.
 *
 * The sweep's own process is included on purpose: its environment carries `CLAUDE_CODE_SESSION_ID`, and
 * refusing the scratchpad it is standing in is the point rather than an accident.
 *
 * @param {string[]} entryPaths absolute paths to test
 * @param {string[] | "unknown"} strings from `processStrings`
 * @returns {Set<string> | "unknown"}
 */
export function heldEntries(entryPaths: string[], strings: string[] | "unknown"): Set<string> | "unknown" {
  if (strings === "unknown") return "unknown";
  const held: Set<string> = new Set();
  for (const path of entryPaths) {
    // The boundary matters: `/tmp/rv-21` must not be held by a process naming `/tmp/rv-210`.
    if (strings.some((text) => text.includes(path) && boundedAt(text, path))) held.add(path);
  }
  return held;
}

/** Whether every occurrence of `path` in `text` ends at a path boundary rather than mid-name.
 * @param {string} text @param {string} path @returns {boolean} */
function boundedAt(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const next = text[at + path.length];
    if (next === undefined || next === "/" || !/[A-Za-z0-9._-]/.test(next)) return true;
  }
  return false;
}

/**
 * The newest mtime anywhere in the top two levels of `path`, or `"unknown"` when it cannot be read.
 *
 * TWO LEVELS RATHER THAN THE DIRECTORY ITSELF, because the directory's own mtime UNDERSTATES liveness and
 * was measured doing so: the live session `e624ede0…` had a top-level mtime of 13:00 while its own
 * `tasks/` directory inside it read 21:56 -- nearly nine hours of a session working, invisible to a
 * `stat` of the entry. Same shape as `recentGitActivity` taking the newest of `index`/`HEAD`/`logs/HEAD`
 * rather than one of them.
 *
 * Bounded at two levels rather than walked: the population is ~1,300 entries on a RAM-backed filesystem
 * every session shares, and every observed liveness marker (`tasks/`, `scratchpad/`) sits at that depth.
 *
 * @param {string} path @returns {number | "unknown"}
 */
export function newestMtimeMs(path: string): number | "unknown" {
  let top: import("node:fs").Stats;
  try { top = statSync(path); } catch { return "unknown"; }
  if (!top.isDirectory()) return top.mtimeMs;
  let newest = top.mtimeMs;
  for (const child of childPaths(path)) {
    try { newest = Math.max(newest, statSync(child).mtimeMs); } catch { /* removed under us */ }
    for (const grandchild of childPaths(child)) {
      try { newest = Math.max(newest, statSync(grandchild).mtimeMs); } catch { /* removed under us */ }
    }
  }
  return newest;
}

/** @param {string} dir @returns {string[]} */
function childPaths(dir: string): string[] {
  try { return readdirSync(dir).map((name) => join(dir, name)); } catch { return []; }
}

export type Authorities = { openPrs: Set<number> | "unknown", held: Set<string> | "unknown", selfSessions: Set<string>, now: number, windowMs?: number, fixtureWindowMs?: number, mtime?: (path: string) => number | "unknown" };

export type Verdict = { path: string, family: Family["family"], verdict: "remove" | "refuse", reason: string };

/**
 * THE CLASSIFIER: one path in, one verdict and one REASON out.
 *
 * Every branch that cannot answer says so and refuses. There is deliberately no default that reads
 * "could not tell" as "safe to remove" -- that collapse is the defect `prune-worktrees.mjs`'s
 * INCONCLUSIVE bucket exists for, and here it would be unrecoverable rather than merely wrong.
 *
 * The ORDER below decides which reason is printed and nothing else: every one of these refuses, so a path
 * that trips two is removed by neither. Self before held because "this is your own scratchpad" is the
 * more actionable sentence, and both before the pull request because they are true regardless of it.
 *
 * @param {string} absolutePath @param {string} tmpRoot @param {Authorities} authorities @returns {Verdict}
 */
export function classifyEntry(absolutePath: string, tmpRoot: string, authorities: Authorities): Verdict {
  const relative = relativeUnder(absolutePath, tmpRoot);
  if (relative === null) {
    return refuse(absolutePath, "unknown", `outside ${tmpRoot} -- this tool removes nothing it did not walk`);
  }
  const family = familyOf(relative);
  if (family.family === "unknown") {
    return refuse(absolutePath, "unknown",
      "unrecognised: no family owns this name, so nothing here can say whether it is finished");
  }
  return sessionVerdict(absolutePath, family, authorities) ?? reviewVerdict(absolutePath, family, authorities)
    ?? activityVerdict(absolutePath, family, authorities);
}

/** @param {string} path @param {Family["family"]} family @param {string} reason @returns {Verdict} */
const refuse = (path: string, family: Family["family"], reason: string): Verdict => ({ path, family, verdict: ("refuse" as const), reason });

/** `absolutePath` relative to `tmpRoot`, or `null` when it is not under it at all.
 * @param {string} absolutePath @param {string} tmpRoot @returns {string | null} */
function relativeUnder(absolutePath: string, tmpRoot: string): string | null {
  const root = tmpRoot.endsWith(sep) ? tmpRoot : tmpRoot + sep;
  if (!absolutePath.startsWith(root)) return null;
  const relative = absolutePath.slice(root.length);
  return relative.split("/").includes("..") ? null : relative;
}

/** The two refusals that are about the path being SOMEBODY'S, or `null` when neither fires.
 * @param {string} path @param {Family} family @param {Authorities} authorities @returns {Verdict | null} */
function sessionVerdict(path: string, family: Family, { held, selfSessions }: Authorities): Verdict | null {
  if (family.family === "scratchpad" && selfSessions.has(family.session)) {
    return refuse(path, family.family,
      `this is the sweeping session's OWN scratchpad (CLAUDE_CODE_SESSION_ID=${family.session})`);
  }
  if (held === "unknown") {
    return refuse(path, family.family, "/proc could not be listed, so no process could be asked whether it holds this");
  }
  return held.has(path)
    ? refuse(path, family.family, "a running process holds this open, names it in its argv, or is standing in it")
    : null;
}

/** The pull request refusal, or `null` when the path is not a review leftover or its pull request is closed.
 * @param {string} path @param {Family} family @param {Authorities} authorities @returns {Verdict | null} */
function reviewVerdict(path: string, family: Family, { openPrs }: Authorities): Verdict | null {
  if (family.family !== "review") return null;
  if (openPrs === "unknown") {
    return refuse(path, family.family,
      `the open pull request list could not be read, so #${family.pr} cannot be called closed`);
  }
  return openPrs.has(family.pr)
    ? refuse(path, family.family, `pull request #${family.pr} is OPEN -- this is somebody's current review`)
    : null;
}

/** The last authority, and the only one that can see a live session holding nothing open.
 * @param {string} path @param {Family} family @param {Authorities} authorities @returns {Verdict} */
function activityVerdict(path: string, family: Family, { now, windowMs = ACTIVITY_WINDOW_MS, fixtureWindowMs = FIXTURE_WINDOW_MS, mtime = newestMtimeMs }: Authorities): Verdict {
  // A tree this tool already began removing is finished at any age: the rename that marked it came AFTER the age check.
  if (family.family === "doomed") {
    return { path, family: family.family, verdict: "remove", reason: "a removal this tool began and did not finish" };
  }
  const newest = mtime(path);
  if (newest === "unknown") {
    return refuse(path, family.family, "its newest write time could not be read, so it is not known to be cold");
  }
  const ageMs = now - newest;
  const hours = (ms: number) => (ms / MS_PER_HOUR).toFixed(1);
  const window = family.family === "fixture" ? fixtureWindowMs : windowMs;
  if (ageMs < window) {
    // A fixed sentence for a fixture, so thousands of young ones tally as ONE reason in the report rather than thousands of lines.
    return refuse(path, family.family, family.family === "fixture"
      ? `a test fixture written less than ${hours(window)}h ago, so a test may still be using it`
      : `written ${hours(ageMs)}h ago, inside the ${hours(window)}h window -- a session may still be using it`);
  }
  return { path, family: family.family, verdict: "remove", reason: `${settledBecause(family)}, and nothing has written here for ${hours(ageMs)}h` };
}

/** @param {Family} family @returns {string} */
function settledBecause(family: Family): string {
  if (family.family === "review") return `pull request #${family.pr} is closed`;
  return family.family === "fixture" ? `a ${family.prefix}* test fixture no process holds` : "no live session claims it";
}

/**
 * Every path in the two families this tool classifies, absolute. Anything else under `/tmp` is not walked
 * -- see this file's header for why a tool that cannot say what `board.json` is for does not offer to
 * remove it.
 *
 * @param {string} tmpRoot @param {import("node:fs").Dirent[]} [top] `tmpRoot`'s own entries when the caller already read them @returns {string[]}
 */
export function sweepablePaths(tmpRoot: string, top: import("node:fs").Dirent[] = topEntries(tmpRoot) ?? []): string[] {
  const topNames = top.map((entry) => entry.name);
  const review = topNames.filter((name) => familyOf(name).family === "review").map((name) => join(tmpRoot, name));
  const scratchRoot = join(tmpRoot, SCRATCHPAD_ROOT);
  const scratchpads = childNames(scratchRoot).flatMap((project) =>
    childNames(join(scratchRoot, project))
      .filter((session) => UUID.test(session))
      .map((session) => join(scratchRoot, project, session)));
  return [...review, ...scratchpads].sort();
}

/**
 * The fixture directories directly under `tmpRoot`: a DIRECTORY (a file or a symlink with a fixture's name is not what the fixtures make)
 * whose name carries one of `FIXTURE_PREFIXES`. Names only, one `readdir` and no `stat`, because this is called over a `/tmp` of 120,000
 * entries every minute and the age is read lazily, for as many as the run can use.
 * @param {string} tmpRoot @param {import("node:fs").Dirent[]} [top] @returns {string[]}
 */
export function fixturePaths(tmpRoot: string, top: import("node:fs").Dirent[] = topEntries(tmpRoot) ?? []): string[] {
  return directChildren(tmpRoot, top, (name) => familyOf(name).family === "fixture");
}

/** The trees an earlier run began removing and did not finish, which are the first thing the next run does. @param {string} tmpRoot @param {import("node:fs").Dirent[]} [top] @returns {string[]} */
export function doomedPaths(tmpRoot: string, top: import("node:fs").Dirent[] = topEntries(tmpRoot) ?? []): string[] {
  return directChildren(tmpRoot, top, (name) => name.startsWith(DOOMED_PREFIX));
}

/** @param {string} tmpRoot @param {import("node:fs").Dirent[]} top @param {(name: string) => boolean} wanted @returns {string[]} */
function directChildren(tmpRoot: string, top: import("node:fs").Dirent[], wanted: (name: string) => boolean): string[] {
  return top.filter((entry) => entry.isDirectory() && wanted(entry.name)).map((entry) => join(tmpRoot, entry.name)).sort();
}

/**
 * The entries directly under `tmpRoot`, read ONCE per run: the three lists above and the `tmp-entries:` reading all come from this one
 * `readdir` of a directory that held 123,850 entries (#3846), so the count costs no second walk. `null` is a directory that could not be
 * read, which is not the same claim as an empty one.
 * @param {string} tmpRoot @returns {import("node:fs").Dirent[] | null}
 */
function topEntries(tmpRoot: string): import("node:fs").Dirent[] | null {
  try { return readdirSync(tmpRoot, { withFileTypes: true }); } catch { return null; }
}

/** @param {string} dir @returns {string[]} */
function childNames(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * The sessions this very process must never sweep. `CLAUDE_CODE_SESSION_ID` is set in the environment of
 * every process a session spawns and carries the CURRENT uuid -- the one the session is writing -- where
 * the live `claude` process's own argv carries only the stale uuid it was resumed with.
 *
 * @param {NodeJS.ProcessEnv} env @returns {Set<string>}
 */
export function selfSessions(env: NodeJS.ProcessEnv): Set<string> {
  const own = env.CLAUDE_CODE_SESSION_ID;
  return new Set(own !== undefined && UUID.test(own) ? [own] : []);
}

/**
 * `tmpEntries` is how many entries the root held when the run began, read before any removal. `candidates` is every path the walk found and `examined` the ones this run looked at, so the difference is what the run's budget left for the next one. `partial` is a tree whose removal began and was stopped at a leaf by the budget: it is neither removed nor failed.
 */
export type PruneReport = { tmpEntries: number | "unknown", examined: number, candidates: number, removable: Verdict[], refused: Verdict[], removed: string[], partial: string[], failed: { path: string, reason: string }[] };

/** @type {(ms: number) => void} A synchronous sleep: the whole tool is synchronous, and the pause is the point of the run's shape. */
const sleep: (ms: number) => void = (ms): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * The whole flow: walk the families, classify each path, and -- only under `--apply` -- remove the ones every authority called dead,
 * until the run's budget is spent.
 *
 * `dryRun` SKIPS THE REMOVAL AND NOTHING ELSE. Same walk, same classifier, same reasons, so the listing
 * is this tool's own answer rather than a second implementation of it -- the shape `prune-worktrees.mjs`
 * records a hand-rolled re-implementation getting wrong on 99 of 114 worktrees.
 *
 * THE ORDER IS THE STATE MACHINE: trees an earlier run began removing first (a killed run leaves exactly that), then the two
 * original families, then the fixtures. A dry run spends one unit of budget per path it would remove, so its listing is the size of one run.
 *
 * @param {string} tmpRoot
 * @param {{ dryRun?: boolean, now?: number, windowMs?: number, fixtureWindowMs?: number, env?: NodeJS.ProcessEnv,
 *   run?: typeof defaultRun, procRoot?: string, remove?: (path: string) => void | boolean,
 *   claim?: typeof claimRefusal, record?: typeof recordRemoval, pause?: (ms: number) => void,
 *   maxRemovals?: number, maxExamined?: number, families?: Family["family"][] }} [deps] `claim` and `record` are #2782's: the ROW's claim
 *   on any worktree inside a path, and the removal's log line. `families` narrows the walk (the timer passes the fixtures and the
 *   unfinished trees only); `remove` returns `false` for "stopped before the end", and anything else is "finished".
 * @returns {PruneReport}
 */
export function pruneTmp(tmpRoot: string, deps: {
    dryRun?: boolean; now?: number; windowMs?: number; fixtureWindowMs?: number; env?: NodeJS.ProcessEnv;
    run?: typeof defaultRun; procRoot?: string; remove?: (path: string) => void | boolean;
    claim?: typeof claimRefusal; record?: typeof recordRemoval; pause?: (ms: number) => void;
    maxRemovals?: number; maxExamined?: number; families?: Family["family"][];
} = {}): PruneReport {
  const { dryRun = true, now = Date.now(), windowMs, fixtureWindowMs, env = process.env, run, procRoot,
    maxRemovals = MAX_REMOVALS_PER_RUN, maxExamined = MAX_EXAMINED_PER_RUN, families } = deps;
  const wanted = (family: Family["family"]) => families === undefined || families.includes(family);
  const topRead = topEntries(tmpRoot);
  const top = topRead ?? [];
  const queue = [...(wanted("doomed") ? doomedPaths(tmpRoot, top) : []),
    ...sweepablePaths(tmpRoot, top).filter((path) => wanted(familyOf(relativeUnder(path, tmpRoot) ?? "").family)),
    ...(wanted("fixture") ? fixturePaths(tmpRoot, top) : [])];
  const strings = processStrings(procRoot);
  let openPrs: Set<number> | "unknown" | undefined;
  // The pull request list is read only when a review leftover is reached: a timer that sweeps fixtures must not spend the GraphQL pool every minute.
  const readOpenPrs = () => (openPrs ??= openPullRequests({ run }));
  const budget = { left: maxRemovals };
  const report: PruneReport = { tmpEntries: topRead === null ? "unknown" : topRead.length, examined: 0, candidates: queue.length, removable: [], refused: [], removed: [], partial: [], failed: [] };
  for (const path of queue) {
    if (budget.left <= 0 || report.examined >= maxExamined) break;
    report.examined += 1;
    const family = familyOf(relativeUnder(path, tmpRoot) ?? "").family;
    const authorities: Authorities = { openPrs: family === "review" ? readOpenPrs() : new Set(), held: heldEntries([path], strings),
      selfSessions: selfSessions(env), now, windowMs, fixtureWindowMs };
    sweepOne(path, { tmpRoot, authorities, budget, report, deps });
  }
  return report;
}

/**
 * One path's turn: classify it, then (under `--apply`) remove it, putting the outcome in `report`.
 * @param {string} path
 * @param {{ tmpRoot: string, authorities: Authorities, budget: { left: number }, report: PruneReport, deps: Parameters<typeof pruneTmp>[1] & {} }} context
 */
function sweepOne(path: string, { tmpRoot, authorities, budget, report, deps }: { tmpRoot: string; authorities: Authorities; budget: { left: number; }; report: PruneReport; deps: Parameters<typeof pruneTmp>[1] & {}; }) {
  const { dryRun = true, remove, claim = claimRefusal, record = recordRemoval, pause = sleep } = deps;
  const verdict = classifyEntry(path, tmpRoot, authorities);
  if (verdict.verdict === "refuse") { report.refused.push(verdict); return; }
  // #2782: a whole directory goes, and any worktree inside it goes too -- so the ROW of each is read first, in the dry run
  // as well, because the listing is this tool's own answer and a path it lists as removable must be one `--apply` removes.
  const claimed = claimOnTrees(path, claim);
  if (claimed.refused) { report.refused.push({ ...verdict, verdict: "refuse", reason: claimed.reason }); return; }
  report.removable.push(verdict);
  if (dryRun) { budget.left -= 1; return; }
  const remover = remove ?? ((target) => removeFromLeaves(target, budget, pause));
  const outcome = removeRecorded(path, tmpRoot, { remove: remover, record, family: verdict.family });
  if (outcome.failure !== null) report.failed.push({ path, reason: outcome.failure });
  else if (outcome.finished) report.removed.push(path);
  else report.partial.push(outcome.path);
  // A remover that was handed in does not spend the budget itself, so a run over one still stops after `maxRemovals` paths.
  if (remove !== undefined) budget.left -= 1;
}

/**
 * #2782: the first refusal among the worktrees a path holds, by the ROW's claim. A path holding none has no claim to read.
 * @param {string} path @param {typeof claimRefusal} claim
 * @returns {{ refused: false } | { refused: true, reason: string }}
 */
function claimOnTrees(path: string, claim: typeof claimRefusal): { refused: false; } | { refused: true; reason: string; } {
  for (const tree of nestedWorktrees(path)) {
    const refusal = claim({ path: tree, branch: worktreeBranch(tree) });
    if (refusal.refused) return refusal;
  }
  return { refused: false };
}

/**
 * #2782: {@link removePath} with its line -- `removing` BEFORE the delete, `removed` or `failed` after -- naming every worktree
 * inside the path and what its owner file read. A line that cannot be written is a removal that does not happen. A fixture is
 * RENAMED to `DOOMED_PREFIX` first (see there), and `path` in the answer is where the tree stands now.
 * @param {string} path @param {string} tmpRoot
 * @param {{ remove: (path: string) => void | boolean, record: typeof recordRemoval, family: Family["family"] }} deps
 * @returns {{ failure: string | null, finished: boolean, path: string }}
 */
function removeRecorded(path: string, tmpRoot: string, { remove, record, family }: { remove: (path: string) => void | boolean; record: typeof recordRemoval; family: Family["family"]; }): { failure: string | null; finished: boolean; path: string; } {
  const trees = nestedWorktrees(path);
  const line = { path, caller: CALLER, reason: "a classified leftover no live session claims",
    detail: trees.length > 0 ? `holds worktree(s): ${trees.join(", ")}` : undefined };
  try {
    record({ ...line, event: "removing", owner: trees.map((tree) => `${tree}=${worktreeOwner(tree)}`).join(" ") || null });
  } catch (cause) {
    return { failure: `the removal log could not be written, so nothing was removed (#2782): ${(cause as Error).message}`,
      finished: false, path };
  }
  const outcome = removeContained(path, tmpRoot, remove, family === "fixture");
  // `partial` is not a log event: the tree is still there, and the next run writes its own `removing` for it.
  if (outcome.failure !== null || outcome.finished) {
    record({ ...line, event: outcome.failure === null ? "removed" : "failed", detail: outcome.failure ?? line.detail });
  }
  return outcome;
}

/**
 * Removes one classified path, or names why it could not be. Re-checks containment at the point of the
 * DELETE rather than trusting that the walk produced it: this is the only line in the file that destroys
 * anything, and the check costs nothing beside it.
 *
 * EXPORTED FOR ITS OWN TEST, because it cannot be reached through `pruneTmp` -- `classifyEntry` already
 * refuses anything outside the root, so no walk can hand this function a path to refuse. A guard with no
 * reachable state is a guard nothing can prove bites: dropping it went UNNOTICED by the whole suite when
 * it was mutated away (2026-09-23, the one survivor of fifteen), and that is the fact that put this line
 * here rather than a belief that it is obviously correct.
 *
 * @param {string} path @param {string} tmpRoot @param {((path: string) => void | boolean) | undefined} [remove]
 * @returns {string | null} the failure, or `null` on success
 */
export function removePath(path: string, tmpRoot: string, remove?: ((path: string) => void | boolean) | undefined): string | null {
  return removeContained(path, tmpRoot, remove, false).failure;
}

/**
 * {@link removePath}'s body, answering whether the tree is gone and where it now stands as well.
 * @param {string} path @param {string} tmpRoot @param {((path: string) => void | boolean) | undefined} remove
 * @param {boolean} rename whether to rename the tree to `DOOMED_PREFIX` first
 * @returns {{ failure: string | null, finished: boolean, path: string }}
 */
function removeContained(path: string, tmpRoot: string, remove: ((path: string) => void | boolean) | undefined, rename: boolean): { failure: string | null; finished: boolean; path: string; } {
  if (relativeUnder(path, tmpRoot) === null) {
    return { failure: `refused at the delete: ${path} is not under ${tmpRoot}`, finished: false, path };
  }
  let target = path;
  try {
    if (rename) target = markDoomed(path);
    // `remove` walks a tree from its leaves and unlinks a symlink rather than following it, which matters here: a worktree's
    // `node_modules` is a SYMLINK into the primary checkout, and a recursive delete that followed one
    // would empty the primary (`prune-worktrees.mjs`, #2012, reproduced with content behind the link).
    const finished = (remove ?? ((entry) => removeFromLeaves(entry, { left: Infinity }, () => {})))(target) !== false;
    return { failure: null, finished, path: target };
  } catch (error) {
    return { failure: (error as Error).message, finished: false, path: target };
  }
}

/** One atomic rename, which is what makes a half-removed tree findable. @param {string} path @returns {string} where it now stands */
function markDoomed(path: string): string {
  const doomed = join(dirname(path), DOOMED_PREFIX + basename(path));
  renameSync(path, doomed);
  return doomed;
}

/**
 * Removes `path` from its leaves, ONE ENTRY PER CALL -- never a recursive delete of the whole tree, because the incident (#3846) was
 * a single `rmdir` over a very large tree that held a CPU for 26 s. Each removal takes one unit of `budget` and is followed by a pause;
 * when the budget is spent the walk stops at a leaf and answers `false`, and what is left is a smaller tree for the next run.
 *
 * @param {string} path @param {{ left: number }} budget @param {(ms: number) => void} pause
 * @returns {boolean} whether the tree is gone
 */
export function removeFromLeaves(path: string, budget: { left: number; }, pause: (ms: number) => void): boolean {
  if (!lstatSync(path).isDirectory()) return removeEntry(() => unlinkSync(path), budget, pause);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    // `isDirectory` on a Dirent is false for a symlink, so a link is unlinked and never walked.
    const done = entry.isDirectory() ? removeFromLeaves(child, budget, pause) : removeEntry(() => unlinkSync(child), budget, pause);
    if (!done) return false;
  }
  return removeEntry(() => rmdirSync(path), budget, pause);
}

/** One removal call, or `false` when the budget has none left. @param {() => void} call @param {{ left: number }} budget @param {(ms: number) => void} pause */
function removeEntry(call: () => void, budget: { left: number; }, pause: (ms: number) => void) {
  if (budget.left <= 0) return false;
  budget.left -= 1;
  call();
  pause(PAUSE_BETWEEN_REMOVALS_MS);
  return true;
}

/**
 * What `main()` prints: the `tmp-entries:` reading, then the examined count, then every removal and every refusal WITH ITS REASON.
 *
 * THE EXAMINED COUNT IS WHAT MAKES A ZERO MEAN SOMETHING (#933). "0 removable of 1,306 examined" and "0
 * removable" are different claims, and only the first can be seen to be wrong: a sweep that walked
 * nothing reports the cleanest possible output and is indistinguishable from a clean host.
 *
 * REFUSALS ARE PRINTED, NOT COUNTED. The row this closes asks for anything a process holds open to be
 * "said as a refusal with a reason rather than silently skipped", and a refusal folded into a total is
 * exactly a silent skip wearing a number.
 *
 * @param {PruneReport} report @param {boolean} dryRun @returns {string}
 */
export function formatReport(report: PruneReport, dryRun: boolean = true): string {
  return `tmp-entries: ${report.tmpEntries}\n${reportBody(report, dryRun)}`;
}

/**
 * The line `tmp-entries: <N>` comes first in EVERY report, nothing-to-remove included (#3868): a run that finds nothing is the one whose
 * count is read hardest, and the user journal of the janitor's unit is the only record of what `/tmp` held on a given day (#3849's
 * done-when 2). It is the count at the START of the run, so the next run reads what this one's removals left.
 * @param {PruneReport} report @param {boolean} dryRun @returns {string}
 */
function reportBody(report: PruneReport, dryRun: boolean): string {
  // WOULD REMOVE versus REMOVED, never the same word: a listing that says "removed" is indistinguishable
  // from a run that removed, and the dry run exists so a session can read the list one cycle before its
  // scratchpad disappears.
  if (report.candidates === 0) {
    return `nothing to remove: 0 classified path(s) found${dryRun ? " (a dry run)" : ""} -- nothing was removed`;
  }
  const lines = [dryRun
    ? `WOULD REMOVE ${report.removable.length} of ${report.examined} classified path(s) -- nothing has been `
      + "removed; pass --apply, and announce the list one cycle first so no session loses its scratchpad:"
    : `removed ${report.removed.length} of ${report.examined} classified path(s):`];
  for (const entry of report.removable) lines.push(`  ${entry.path}  [${entry.family}] -- ${entry.reason}`);
  if (report.partial.length > 0) {
    lines.push(`${report.partial.length} tree(s) stopped at the run's budget and are partly removed; the next run finishes them:`);
    for (const path of report.partial) lines.push(`  ${path}`);
  }
  if (report.failed.length > 0) {
    lines.push(`${report.failed.length} path(s) could NOT be removed and are still there:`);
    for (const entry of report.failed) lines.push(`  ${entry.path} -- ${entry.reason}`);
  }
  lines.push(`refused ${report.refused.length} path(s), each with its reason -- nothing here was removed:`);
  lines.push(...refusalLines(report.refused));
  const deferred = report.candidates - report.examined;
  if (deferred > 0) lines.push(`${deferred} more classified path(s) were not looked at: one run is bounded (${MAX_REMOVALS_PER_RUN} removals), and the next run takes them.`);
  return lines.join("\n");
}

/**
 * Every refusal with its reason, except that a fixture refusal past the first few is TALLIED BY REASON: a run over a busy `/tmp` refuses
 * thousands of young fixtures, and a thousand identical lines hide the one that is not. The tally still names the reason and the count.
 * @param {Verdict[]} refused @returns {string[]}
 */
function refusalLines(refused: Verdict[]): string[] {
  const lines = [];
  const tally: Map<string, number> = new Map();
  let printed = 0;
  for (const entry of refused) {
    if (entry.family === "fixture" && printed >= FIXTURE_REFUSALS_PRINTED) {
      tally.set(entry.reason, (tally.get(entry.reason) ?? 0) + 1);
      continue;
    }
    if (entry.family === "fixture") printed += 1;
    lines.push(`  ${entry.path}  [${entry.family}] -- ${entry.reason}`);
  }
  for (const [reason, count] of tally) lines.push(`  ...and ${count} more [fixture] -- ${reason}`);
  return lines;
}

async function main() {
  refuseUnknownFlags(["--apply", "--tmp", "--fixtures-only"],
    { entry: import.meta.url, command: "node packages/agent-org/src/prune-tmp.mjs" });
  // THE DEFAULT IS THE LISTING, for the reason `prune-worktrees.mjs` paid for: a command whose name reads
  // as a report, on a host with eight live sessions, is one somebody runs to LOOK. There is deliberately
  // no timer for the REVIEW and SCRATCHPAD families -- #2166 puts that decision one cycle after the named list, which is
  // the precedent #2012/#2146 set. The timer (#3849) passes `--fixtures-only`: a test fixture is made by this repository's own tests,
  // so nobody's current work lives in one, and that is the one family it may remove unannounced.
  const dryRun = !process.argv.includes("--apply");
  const tmpRoot = process.argv.find((a) => a.startsWith("--tmp="))?.slice("--tmp=".length) ?? "/tmp";
  if (!existsSync(tmpRoot)) throw new Error(`prune-tmp: ${tmpRoot} does not exist -- nothing was read or written`);
  const families = process.argv.includes("--fixtures-only") ? (["fixture", "doomed"] as Family["family"][]) : undefined;
  process.stdout.write(formatReport(pruneTmp(tmpRoot, { dryRun, families }), dryRun) + "\n");
}

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
