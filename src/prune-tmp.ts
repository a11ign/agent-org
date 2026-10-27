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
// A FOURTH, THE AGED FAMILY, IS THE ONLY ONE NAMED BY WHAT IT IS RATHER THAN BY HOW IT IS CALLED (A11-348). On 2026-10-27 `/tmp` held 1,738 entries and the
// board asked a person, because the workers' logs, body files and `a11-<n>-*` scratch directories belong to none of the families above and "unrecognised" is not
// removable. A run that is handed the user it sweeps for (`uid`, the process's own) reads any other direct child of `/tmp` as aged: removable when that user owns it,
// nothing in its top two levels has been written for 24 hours, and no process holds it. `claude-1000` is excluded (see `agedFamilyOf`). Without a `uid` the
// stance above stands: a name from no family is unrecognised.
//
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
// it STARTED with: `prompt:session`/`wake.ts` clear before every order, and a clear mints a NEW uuid and a
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
// as no refusal at all -- that is the report's whole job.
//
// ## Nothing here can tell you a refusal did not happen, so read this back per PATH
//
// #2012 measured a would-remove COUNT reading 79 before a change and 79 after it, with different
// membership, because the population moves between runs minutes apart. Both populations here move faster
// than that: a scratchpad is minted on every clear. So `prune-tmp.test.ts` reads this back by calling
// `classifyEntry` on a NAMED path and quoting its reason, never by watching a total, and the CLI prints
// the reason beside every path for the same reason.
import { existsSync, readdirSync, readFileSync, lstatSync, readlinkSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
// RELATIVE rather than `@a11ign/screenreader-fleet/cli-flags` for the reason `prune-worktrees.ts` records:
// files in this package run before `pnpm install`, where a package specifier dies.
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import type { RowsRun } from "./plugins/contracts/code-host-rows.ts";
import { rows } from "./plugins/rows.ts";
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
const CALLER = "prune-tmp.ts";
export const ACTIVITY_WINDOW_MS = 24 * MS_PER_HOUR;

/** Where session scratchpads live, relative to the tmp root: `<tmp>/claude-1000/<project>/<uuid>`. */
export const SCRATCHPAD_ROOT = "claude-1000";

/** The scratchpad root under any uid (`claude-1000`, `claude-1001`): the aged family leaves every one of them alone. */
const SCRATCHPAD_ROOT_NAME = /^claude-\d+$/;

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

/** The most wall-clock time one run spends walking and removing before it stops and leaves the rest to the next: the unit's `TimeoutStartSec` is 50 s, and a run killed mid-way is a state the next run must finish. */
export const MAX_RUN_MS = 30_000;

/** How many refusals of the fixture family are printed one by one; the rest are tallied by reason (a run can refuse thousands). */
const FIXTURE_REFUSALS_PRINTED = 10;

/** How long a fixture directory must have been untouched. One hour: a test run is minutes, and the HELD check covers a slow one. */
export const FIXTURE_WINDOW_MS = MS_PER_HOUR;

/**
 * The directory-name prefixes the test fixtures on this host make directly under `/tmp` (`mkdtemp(join(tmpdir(), "<prefix>"))`),
 * each read off the host's measured pile AND found in the file that makes it (a test, or the source it calls), of a repository on this host, so a name here is a fixture and
 * not a guess. The first seven are the ones #3848 names; the rest of the first group are the next largest on 2026-10-06. The groups
 * after it were read off the pile of 2026-10-17 (A11-60), one group per repository that makes them, each naming the file that makes it.
 * A fixture family not listed is UNRECOGNISED and left alone: the private TMPDIR of #3854 is what stops the long tail, this list is
 * only what clears the pile.
 */
export const FIXTURE_PREFIXES = [
  "verify-stamp-test-", "pr-review-verdict-", "host-units-", "ingest-state-", "closes-check-", "trace-weekly-", "prune-tmp-fixture-",
  "org-retro-", "watch-cli-", "gh-wrapper-render-", "gh-calls-", "trace-publish-", "close-rows-full-form-", "removal-log-",
  "review-removal-log-", "dora-resumes-",
  // agent-org: `src/packaging/installed-layout.test.ts`, `src/engineer-route.test.ts`, `src/triage-route.test.ts`, `src/outside-nightly.test.ts`
  // (which makes `outside-nightly-${name}-`, and the two names on this host are `project` and `stub`)
  "installed-layout-", "engineer-route-", "triage-route-", "outside-nightly-project-", "outside-nightly-stub-",
  // control: `src/control-owned/patch-playbook.test.ts`, `src/control-host-install-checkout.test.ts`
  "patch-target-", "patch-verdict-", "patch-vars-", "patch-stage-", "patch-naming-", "control-host-run-",
  // the `packages/` monorepo: `packages/control/src/layer-checkouts.ts`, `packages/guards/src/ci-agreement-step-cancelled.test.ts`,
  // `packages/guards/src/ci-poll-retries-5xx.test.ts`, `scripts/refusal-owners-are-open.test.ts`,
  // `packages/guards/src/verify-present-agent-org.test.ts`, `packages/cli/src/action/urls-input.test.ts`,
  // `packages/guards/src/consumer-gate-pin-needed.test.ts`
  "provision-role-", "agreement-", "poll-5xx-", "refusal-owners-step-", "verify-present-agent-org-",
  "urls-input-", "consumer-gate-pin-remote-",
  // lab: `scripts/corpus-release.ts`, `src/packaging/auto-arm-cross-repo-red.test.ts`. Its `src/packaging/refusal-owners-are-open.test.ts` makes
  // the refusal-owners-step prefix above too, with the `packages/` monorepo.
  "corpus-verify-", "auto-arm-cross-repo-",
  // screenreader-worker: `src/screenreader-defaults.test.ts`. `nvda-zip-` also takes the `nvda-zip-empty-` directories, whose name is `nvda-zip-` then `empty-`.
  "nvda-spec-", "nvda-zip-", "nvda-nospec-",
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

export type Family = { family: "review", pr: number } | { family: "scratchpad", session: string, project: string } | { family: "fixture", prefix: string } | { family: "doomed" } | { family: "aged" } | { family: "unknown" };

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
 * Whether a name is in the AGED family (A11-348): a direct child of the tmp root that no other family owns and that is not the scratchpad root.
 *
 * `familyOf` stays what it was -- a name from nobody's family is `unknown` -- so the aged family is a SECOND, opt-in reading that
 * {@link classifyEntry} makes only when it is handed the user whose entries it may sweep. It is what the ticket asks of `/tmp`: an entry the agent user
 * owns that nobody has written for a day is gone, whatever its name, because the board's count of `/tmp` includes the reviewers' and the
 * workers' scratch files and logs (`a11-290-accept.*`, `body3.md`, `agr.log`), which no list of prefixes will ever finish naming.
 *
 * THE SCRATCHPAD ROOT IS EXCLUDED, and so is everything below the top level: `claude-1000` is the one entry whose age says nothing (its mtime moves only when a
 * project directory is made, while a session writes ten levels down), and what is in it is the scratchpad family's, which waits for #2166's announced cycle.
 *
 * @param {string} relativePath a path relative to the tmp root, `/`-separated
 * @returns {Family}
 */
export function agedFamilyOf(relativePath: string): Family {
  const parts = relativePath.split("/").filter((part) => part !== "");
  if (parts.length !== 1 || SCRATCHPAD_ROOT_NAME.test(parts[0]) || familyOf(parts[0]).family !== "unknown") return { family: "unknown" };
  return { family: "aged" };
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

/** The code host's own runner (A11-160, step 8): the one read of this file that reaches it is the list of open pull requests below. */
const defaultRun: RowsRun = (args) => rows().runnerWith({})(args);

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
    parsed = JSON.parse(run(rows().openPullListArgs(OPEN_PR_LIMIT, "number")));
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
    // `cwd` and `exe`: a daemon started as `./server` from /tmp/x that then moved away is still running that file.
    for (const link of ["cwd", "exe"]) {
      try { strings.push(readlinkSync(join(dir, link))); } catch { /* gone or not ours */ }
    }
    strings.push(...openFdTargets(join(dir, "fd")));
  }
  strings.push(...boundSocketPaths(join(procRoot, "net", "unix")));
  return strings;
}

/**
 * The filesystem paths a unix socket is bound to, from `/proc/net/unix` (its last column, after the seven the kernel always prints). A LISTENING SOCKET IS NOT
 * A PATH IN ANY PROCESS'S FD LIST (`readlink` of its fd reads `socket:[inode]`), so a server whose socket sits in `/tmp/qs-AbC123/s` or `/tmp/codex-daemon-1000/<hash>`
 * names that directory nowhere the other four reads look, and an age check alone would remove the directory from under it and leave a live server nobody can reach.
 * `[]` when the table cannot be read (a fixture `/proc` has none), which says nothing the fd reads did not.
 * @param {string} table @returns {string[]}
 */
function boundSocketPaths(table: string): string[] {
  try {
    return readFileSync(table, "utf8").split("\n").slice(1).map((line) => line.trim().split(/\s+/)[7]).filter((path): path is string => path !== undefined && path.startsWith("/"));
  } catch {
    return [];
  }
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
  // `lstat`, so a symlink directly under the root is aged by the link itself: following it reads the target's time (a young target hides an old link) and a dangling one is unreadable for ever.
  try { top = lstatSync(path); } catch { return "unknown"; }
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

/** `agedOwner`: the user whose entries the aged family may sweep (A11-348); without it a name from no family is unrecognised. `owner`: whose a path is. */
export type Authorities = { openPrs: Set<number> | "unknown", held: Set<string> | "unknown", selfSessions: Set<string>, now: number, windowMs?: number, fixtureWindowMs?: number, mtime?: (path: string) => number | "unknown", agedOwner?: number, owner?: (path: string) => PathStatus };

export type Verdict = { path: string, family: Family["family"], verdict: "remove" | "refuse", reason: string };

/**
 * THE CLASSIFIER: one path in, one verdict and one REASON out.
 *
 * Every branch that cannot answer says so and refuses. There is deliberately no default that reads
 * "could not tell" as "safe to remove" -- that collapse is the defect `prune-worktrees.ts`'s
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
  const named = familyOf(relative);
  const family = named.family === "unknown" && authorities.agedOwner !== undefined ? agedFamilyOf(relative) : named;
  if (family.family === "unknown") {
    return refuse(absolutePath, "unknown",
      "unrecognised: no family owns this name, so nothing here can say whether it is finished");
  }
  return sessionVerdict(absolutePath, family, authorities) ?? reviewVerdict(absolutePath, family, authorities)
    ?? ownerVerdict(absolutePath, tmpRoot, family, authorities) ?? activityVerdict(absolutePath, family, authorities);
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

/** Whose a path is and which filesystem it is on, or `"unknown"`. */
export type PathStatus = { uid: number, dev: number } | "unknown";

/** The aged family's refusals for an entry that is not the sweeping user's, or sits on another filesystem than the root (a mount point: removing "its" files would delete the mounted filesystem's), or `null` when neither, or the path is not an aged one. An entry that cannot be read is refused, not assumed ours.
 * @param {string} path @param {string} tmpRoot @param {Family} family @param {Authorities} authorities @returns {Verdict | null} */
function ownerVerdict(path: string, tmpRoot: string, family: Family, { agedOwner, owner = statusOf }: Authorities): Verdict | null {
  if (family.family !== "aged") return null;
  const here = owner(path);
  const root = owner(tmpRoot);
  if (here === "unknown" || root === "unknown") return refuse(path, family.family, "its owner and filesystem could not be read, so it is not known to be the agent user's");
  if (here.uid !== agedOwner) return refuse(path, family.family, `owned by uid ${here.uid}, not the agent user's ${agedOwner}: not this host's work to remove`);
  return here.dev === root.dev ? null : refuse(path, family.family, "a mount point: it is on another filesystem than the tmp root, and removing it would empty that filesystem");
}

/** @param {string} path @returns {PathStatus} */
function statusOf(path: string): PathStatus {
  try {
    const { uid, dev } = lstatSync(path);
    return { uid, dev };
  } catch { return "unknown"; }
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
    // A fixed sentence for a fixture or an aged entry, so thousands of young ones tally as ONE reason in the report rather than thousands of lines.
    if (family.family === "fixture") return refuse(path, family.family, `a test fixture written less than ${hours(window)}h ago, so a test may still be using it`);
    if (family.family === "aged") return refuse(path, family.family, youngAgedReason(window));
    return refuse(path, family.family, `written ${hours(ageMs)}h ago, inside the ${hours(window)}h window -- a session may still be using it`);
  }
  return { path, family: family.family, verdict: "remove", reason: `${settledBecause(family)}, and nothing has written here for ${hours(ageMs)}h` };
}

/** The one sentence every young aged entry is refused with, so thousands of them tally as one line. @param {number} windowMs @returns {string} */
function youngAgedReason(windowMs: number): string {
  return `written less than ${(windowMs / MS_PER_HOUR).toFixed(1)}h ago, so a run may still be using it`;
}

/** @param {Family} family @returns {string} */
function settledBecause(family: Family): string {
  if (family.family === "review") return `pull request #${family.pr} is closed`;
  if (family.family === "aged") return "the agent user's own, and no process holds it";
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

/**
 * The entries directly under `tmpRoot` in the aged family (A11-348), names only: whether one is the agent's, and how old, is read lazily by {@link classifyEntry},
 * for as many as the run can use. Entries of any type, because a log or a body file is as much a leftover as a directory.
 * @param {string} tmpRoot @param {import("node:fs").Dirent[]} [top] @returns {string[]}
 */
export function agedPaths(tmpRoot: string, top: import("node:fs").Dirent[] = topEntries(tmpRoot) ?? []): string[] {
  return top.filter((entry) => agedFamilyOf(entry.name).family === "aged").map((entry) => join(tmpRoot, entry.name)).sort();
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
 * is this tool's own answer rather than a second implementation of it -- the shape `prune-worktrees.ts`
 * records a hand-rolled re-implementation getting wrong on 99 of 114 worktrees.
 *
 * THE ORDER IS THE STATE MACHINE: trees an earlier run began removing first (a killed run leaves exactly that), then the two
 * original families, then the fixtures. A dry run spends one unit of budget per path it would remove, so its listing is the size of one run.
 *
 * @param {string} tmpRoot
 * @param {{ dryRun?: boolean, now?: number, windowMs?: number, fixtureWindowMs?: number, env?: NodeJS.ProcessEnv,
 *   run?: typeof defaultRun, procRoot?: string, remove?: (path: string) => void | boolean,
 *   claim?: typeof claimRefusal, record?: typeof recordRemoval, pause?: (ms: number) => void,
 *   maxRemovals?: number, maxExamined?: number, maxMs?: number, families?: Family["family"][], uid?: number, owner?: (path: string) => PathStatus }} [deps] `claim` and `record` are #2782's: the ROW's claim
 *   on any worktree inside a path, and the removal's log line. `families` narrows the walk (the timer passes the fixtures, the unfinished trees and the
 *   aged entries); `remove` returns `false` for "stopped before the end", and anything else is "finished". `uid` is the user whose entries the aged
 *   family may remove (the process's own), and the aged family is walked only when `families` names it; `owner` says whose a path is and on which device (lstat's, unless a test hands one in). `maxMs` bounds the run's wall clock.
 * @returns {PruneReport}
 */
export function pruneTmp(tmpRoot: string, deps: {
    dryRun?: boolean; now?: number; windowMs?: number; fixtureWindowMs?: number; env?: NodeJS.ProcessEnv;
    run?: typeof defaultRun; procRoot?: string; remove?: (path: string) => void | boolean;
    claim?: typeof claimRefusal; record?: typeof recordRemoval; pause?: (ms: number) => void;
    maxRemovals?: number; maxExamined?: number; maxMs?: number; families?: Family["family"][]; uid?: number; owner?: (path: string) => PathStatus;
} = {}): PruneReport {
  const { dryRun = true, now = Date.now(), windowMs, fixtureWindowMs, env = process.env, run, procRoot, owner,
    maxRemovals = MAX_REMOVALS_PER_RUN, maxExamined = MAX_EXAMINED_PER_RUN, maxMs = MAX_RUN_MS, families, uid = process.getuid?.() } = deps;
  const wanted = (family: Family["family"]) => families === undefined || families.includes(family);
  // THE AGED FAMILY IS NEVER IN A RUN THAT NAMED NO FAMILIES: `--tmp=<dir>` can point this tool anywhere, and "every direct child that user owns and nobody has written for a day" is a sweep of whatever that is. It is asked for by name (`--timer`).
  const wantsAged = families?.includes("aged") === true && uid !== undefined;
  const topRead = topEntries(tmpRoot);
  const top = topRead ?? [];
  const queue = [...(wanted("doomed") ? doomedPaths(tmpRoot, top) : []),
    ...sweepablePaths(tmpRoot, top).filter((path) => wanted(familyOf(relativeUnder(path, tmpRoot) ?? "").family)),
    ...(wanted("fixture") ? fixturePaths(tmpRoot, top) : []),
    ...(wantsAged ? agedPaths(tmpRoot, top) : [])];
  const strings = processStrings(procRoot);
  let openPrs: Set<number> | "unknown" | undefined;
  // The pull request list is read only when a review leftover is reached: a timer that sweeps fixtures must not spend the GraphQL pool every minute.
  const readOpenPrs = () => (openPrs ??= openPullRequests({ run }));
  const budget = { left: maxRemovals };
  const report: PruneReport = { tmpEntries: topRead === null ? "unknown" : topRead.length, examined: 0, candidates: queue.length, removable: [], refused: [], removed: [], partial: [], failed: [] };
  const stopAt = Date.now() + maxMs;
  const read = { other: 0, aged: 0 };
  for (const path of queue) {
    if (budget.left <= 0 || Date.now() >= stopAt) break;
    const aged = agedFamilyOf(relativeUnder(path, tmpRoot) ?? "").family === "aged";
    // An entry's own mtime is a LOWER bound on its newest write, so one inside the window is young without reading below it. Those cost one `lstat` and no part of the read cap: with the cap spent on young entries sorted ahead of an old one, the old one would never be reached.
    if (aged && youngByItself(path, now, windowMs ?? ACTIVITY_WINDOW_MS)) {
      report.examined += 1;
      report.refused.push(refuse(path, "aged", youngAgedReason(windowMs ?? ACTIVITY_WINDOW_MS)));
      continue;
    }
    const family = aged ? "aged" : "other";
    if (read[family] >= maxExamined) continue;
    read[family] += 1;
    report.examined += 1;
    const authorities: Authorities = { openPrs: familyOf(relativeUnder(path, tmpRoot) ?? "").family === "review" ? readOpenPrs() : new Set(), held: heldEntries([path], strings),
      selfSessions: selfSessions(env), now, windowMs, fixtureWindowMs, agedOwner: uid, owner };
    sweepOne(path, { tmpRoot, authorities, budget, report, deps });
  }
  return report;
}

/** Whether the path's own modification time is inside `windowMs` of `now`. `false` when it cannot be read: that case is the classifier's to refuse, with its reason.
 * @param {string} path @param {number} now @param {number} windowMs @returns {boolean} */
function youngByItself(path: string, now: number, windowMs: number): boolean {
  try { return now - lstatSync(path).mtimeMs < windowMs; } catch { return false; }
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
  const outcome = renamedFirst(path, family) ? removeDoomedContained(path, tmpRoot, remove) : removeContained(path, tmpRoot, remove);
  // `partial` is not a log event: the tree is still there, and the next run writes its own `removing` for it.
  if (outcome.failure !== null || outcome.finished) {
    record({ ...line, event: outcome.failure === null ? "removed" : "failed", detail: outcome.failure ?? line.detail });
  }
  return outcome;
}

/** Whether a tree is marked with {@link DOOMED_PREFIX} before its removal: a fixture, and an aged DIRECTORY (a file goes in the one call, so there is no half-removed state to find). */
function renamedFirst(path: string, family: Family["family"]): boolean {
  if (family === "fixture") return true;
  try { return family === "aged" && lstatSync(path).isDirectory(); } catch { return false; }
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
  return removeContained(path, tmpRoot, remove).failure;
}

/**
 * {@link removePath}'s body, answering whether the tree is gone and where it now stands as well.
 * @param {string} path @param {string} tmpRoot @param {((path: string) => void | boolean) | undefined} remove
 * @returns {{ failure: string | null, finished: boolean, path: string }}
 */
function removeContained(path: string, tmpRoot: string, remove: ((path: string) => void | boolean) | undefined): { failure: string | null; finished: boolean; path: string; } {
  return removeTree(path, tmpRoot, remove, () => path);
}

/** {@link removeContained} for a fixture: the tree is renamed to `DOOMED_PREFIX` first, so a half-removed one is findable. */
function removeDoomedContained(path: string, tmpRoot: string, remove: ((path: string) => void | boolean) | undefined): { failure: string | null; finished: boolean; path: string; } {
  return removeTree(path, tmpRoot, remove, () => markDoomed(path));
}

/** The body both removals share. `takeTarget` says where the tree is removed from, which is the path itself or the renamed one. */
function removeTree(path: string, tmpRoot: string, remove: ((path: string) => void | boolean) | undefined, takeTarget: () => string): { failure: string | null; finished: boolean; path: string; } {
  if (relativeUnder(path, tmpRoot) === null) {
    return { failure: `refused at the delete: ${path} is not under ${tmpRoot}`, finished: false, path };
  }
  let target = path;
  try {
    target = takeTarget();
    // `remove` walks a tree from its leaves and unlinks a symlink rather than following it, which matters here: a worktree's
    // `node_modules` is a SYMLINK into the primary checkout, and a recursive delete that followed one
    // would empty the primary (`prune-worktrees.ts`, #2012, reproduced with content behind the link).
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
 * @param {PruneReport} report @returns {string}
 *
 * The line `tmp-entries: <N>` comes first in EVERY report, nothing-to-remove included (#3868): a run that finds nothing is the one whose count is read hardest,
 * and the user journal of the janitor's unit is the only record of what `/tmp` held on a given day (#3849's done-when 2). It is the count at the START of
 * the run, so the next run reads what this one's removals left.
 */
export function formatDryRunReport(report: PruneReport): string {
  return `tmp-entries: ${report.tmpEntries}\n${dryRunBody(report)}`;
}

/** The report an applied run prints: what it removed, and what it did not. */
export function formatAppliedReport(report: PruneReport): string {
  return `tmp-entries: ${report.tmpEntries}\n${appliedBody(report)}`;
}

/**
 * The dry run's body. WOULD REMOVE versus REMOVED, never the same word: a listing that says "removed" is indistinguishable
 * from a run that removed, and the dry run exists so a session can read the list one cycle before its scratchpad disappears.
 */
function dryRunBody(report: PruneReport): string {
  if (report.candidates === 0) {
    return "nothing to remove: 0 classified path(s) found (a dry run) -- nothing was removed";
  }
  return reportLines(report, `WOULD REMOVE ${report.removable.length} of ${report.examined} classified path(s) -- nothing has been `
    + "removed; pass --apply, and announce the list one cycle first so no session loses its scratchpad:").join("\n");
}

/** The applied run's body, which says what was removed and never that a dry run would remove it. */
function appliedBody(report: PruneReport): string {
  if (report.candidates === 0) {
    return "nothing to remove: 0 classified path(s) found -- nothing was removed";
  }
  return reportLines(report, `removed ${report.removed.length} of ${report.examined} classified path(s):`).join("\n");
}

/**
 * The lines both bodies share after their header, in the order every report prints them.
 */
function reportLines(report: PruneReport, header: string): string[] {
  const lines = [header];
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
  if (deferred > 0) lines.push(`${deferred} more classified path(s) were not looked at: one run is bounded (${MAX_REMOVALS_PER_RUN} removals, ${MAX_EXAMINED_PER_RUN} entries read, ${MAX_RUN_MS / 1000} s), and the next run takes them.`);
  return lines;
}

/**
 * Every refusal with its reason, except that a fixture or aged refusal past the first few of its family is TALLIED BY REASON: a run over a busy `/tmp` refuses
 * thousands of young entries, and a thousand identical lines hide the one that is not. The tally still names the family, the reason and the count.
 * @param {Verdict[]} refused @returns {string[]}
 */
function refusalLines(refused: Verdict[]): string[] {
  const lines = [];
  const tally: Map<string, number> = new Map();
  const printed: Map<string, number> = new Map();
  for (const entry of refused) {
    if (entry.family === "fixture" || entry.family === "aged") {
      const seen = printed.get(entry.family) ?? 0;
      if (seen >= FIXTURE_REFUSALS_PRINTED) {
        const key = `${entry.family}\0${entry.reason}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
        continue;
      }
      printed.set(entry.family, seen + 1);
    }
    lines.push(`  ${entry.path}  [${entry.family}] -- ${entry.reason}`);
  }
  for (const [key, count] of tally) {
    const [family, reason] = key.split("\0");
    lines.push(`  ...and ${count} more [${family}] -- ${reason}`);
  }
  return lines;
}

/**
 * The families a run walks. `--timer` is the minute timer's set (A11-348): the fixtures, the trees a killed run left, and the aged entries -- every one a thing
 * nobody's current work can be in once it is a day cold and no process holds it. `--fixtures-only` is the narrower set the timer ran before. Neither flag: every family.
 * @param {string[]} argv @returns {Family["family"][] | undefined}
 */
export function cliFamilies(argv: string[]): Family["family"][] | undefined {
  if (argv.includes("--timer")) return ["fixture", "doomed", "aged"];
  return argv.includes("--fixtures-only") ? ["fixture", "doomed"] : undefined;
}

async function main() {
  refuseUnknownFlags(["--apply", "--tmp", "--fixtures-only", "--timer"],
    { entry: import.meta.url, command: "node packages/agent-org/src/prune-tmp.ts" });
  // THE DEFAULT IS THE LISTING, for the reason `prune-worktrees.ts` paid for: a command whose name reads
  // as a report, on a host with eight live sessions, is one somebody runs to LOOK. There is deliberately
  // no timer for the REVIEW and SCRATCHPAD families -- #2166 puts that decision one cycle after the named list, which is
  // the precedent #2012/#2146 set. The timer (#3849) passes `--timer`: a test fixture is made by this repository's own tests,
  // so nobody's current work lives in one, and an entry the agent user owns that nothing has written for a day and no process holds (A11-348) is cold by the same
  // reading. Those, with the unfinished trees, are the families it may remove unannounced.
  const dryRun = !process.argv.includes("--apply");
  const tmpRoot = process.argv.find((a) => a.startsWith("--tmp="))?.slice("--tmp=".length) ?? "/tmp";
  if (!existsSync(tmpRoot)) throw new Error(`prune-tmp: ${tmpRoot} does not exist -- nothing was read or written`);
  const families = cliFamilies(process.argv);
  const report = pruneTmp(tmpRoot, { dryRun, families });
  process.stdout.write((dryRun ? formatDryRunReport(report) : formatAppliedReport(report)) + "\n");
}

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
