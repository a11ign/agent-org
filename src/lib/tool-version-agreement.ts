// #3533: IS THE ORG RUNNING THE LATEST `agent-org`? MEASURED, NOT ASSUMED. The host ran `v0.22.0` from 19:12Z (#3443) while a11ign's repository still pinned `^0.7.0`,
// locked at `0.7.8`: two versions of one tool and nothing reading it, until #3507's config read refused. #3443 scoped the repository pin out and the follower (#3450)
// could not cross a `0.x` minor, so the gap was invisible by construction: the only version anybody read was the tool checkout's own (`liveToolVersion`, for the
// board's line), and nothing compared it to anything.
//
// THREE READINGS, EACH AN INDEPENDENT FACT ABOUT A RUNNER, compared with ONE newest release tag read from the tool's REMOTE (the checkout may itself be behind):
//   tool       the release tag the host's `tool` checkout sits at (or "at no release" and its commit): what the tick, the units and `agent-org <cmd>` run.
//   worktree   for each worktree of each declared project, the `version` `node_modules/agent-org/package.json` resolves to through the symlink a worktree's
//              `node_modules` is, or none. Before the removal row (#3534) that reads `0.7.8` everywhere; after it, none, and a copy that RETURNS is the signal.
//   ci         the version the last completed `ci.yml` run on `main` ran: the lockfile's at that run's commit, else the line the resolver step printed.
//
// PURE FIRST: {@link agreement} takes every fact INJECTED (the tag list, the clock, each runner's version) so the test states the cases, and BOTH `host:check`
// (`host-units.mjs`) and the org-health tick (`org-health.mjs`) print {@link agreementReport} of ONE result, which is what keeps them from disagreeing.
//
// THE SIGNAL IS STATELESS: it fires when a reading differs from the newest tag AND the newest tag is older than one release cycle ({@link releaseCycleMs}), so a
// runner waiting for its next tick is never a signal, and a runner that was unreadable is NAMED as unread, never counted as agreeing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { sandboxGitEnv } from "./git-env.ts";
import { chooseReleaseTag, compareReleaseTags, isReleaseTag, LATEST } from "./release-tag.ts";
import { liveToolVersion, gitIn } from "./tool-version.ts";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MINUTES_PER_HOUR = 60;
const GIT_TIMEOUT_MS = 30_000;
/** A merge_group run's log is read whole: measured 2026-10-06, 5.0 MB (49,410 lines) for the host repository, where `execFileSync`'s default 1 MiB ended the read in `ENOBUFS` and the reading in UNREAD. Read once per run, then memoised. */
const GH_MAX_BUFFER = 64 * 1024 * 1024;
/** What a reader cannot say is printed before what it can: a cap must never push an unread runner off the page. */
const PRINT_ORDER = ["unread", "unknown", "returned", "behind"];
/** The report names this many runners and counts the rest: a hundred worktrees on one stale copy is one finding, not a hundred lines. */
const MAX_ROWS_PRINTED = 12;

/**
 * HOW LONG `release.yml` TAKES TO TAG A MERGE: NINE MINUTES (#3443: "a merge is live when `release.yml` tags it, about nine minutes later"). Measured 2026-10-04 on
 * the tool's own history: 66 tags, median gap between releases 10.9 minutes, shortest 25 seconds, longest 12.3 hours. THE GAP BETWEEN RELEASES IS NOT THE CYCLE: a cycle of
 * one median gap would fire on every tick; the cycle is how long a runner takes to FOLLOW a tag, which is the update path's own latency.
 */
export const TAG_LAG_MINUTES = 9;

/** The timer the tick runs on, beside the tool's sources: the cycle is read from it and never typed in. */
const WORK_TICK_TIMER = fileURLToPath(new URL("../../host/work-tick.timer.in", import.meta.url));

const DURATION_UNITS: Readonly<Record<string, number>> = { s: MS_PER_SECOND, sec: MS_PER_SECOND, m: MS_PER_MINUTE, min: MS_PER_MINUTE, h: MINUTES_PER_HOUR * MS_PER_MINUTE };

/**
 * THE INTERVAL A `work-tick.timer` FIRES AT, read from its `OnUnitActiveSec=` (`2min` is 120000 ms). Refuses a unit with none: the cycle derives from it, so a guess would be a
 * constant typed in again.
 * @returns milliseconds
 */
export function tickIntervalMs(timerText: string): number {
  const match = /^OnUnitActiveSec=\s*(\d+)\s*(s|sec|m|min|h)\s*$/m.exec(timerText);
  if (match === null) throw new Error("the work-tick timer carries no `OnUnitActiveSec=` in a unit this reads (s, sec, m, min, h), so the release cycle cannot be derived from it");
  return Number(match[1]) * DURATION_UNITS[match[2]];
}

/**
 * THE RELEASE CYCLE: THE TICK'S INTERVAL, PLUS THE TAG LAG, PLUS ONE MORE TICK. A tag is cut {@link TAG_LAG_MINUTES} after its merge; the work-tick runs `update-tool` first on its
 * NEXT firing (one interval); and one more tick is the grid's own slack (the timer's `AccuracySec`, a tick that ran long). With `OnUnitActiveSec=2min` that is 2 + 9 + 2 = 13
 * minutes. It must EXCEED the update path's latency, and it does by construction: nothing here is shorter than the path it measures.
 * @param timerText the text of `host/work-tick.timer.in` @returns milliseconds
 */
export function releaseCycleMs(timerText: string): number {
  const tick = tickIntervalMs(timerText);
  return tick + TAG_LAG_MINUTES * MS_PER_MINUTE + tick;
}

/** The cycle from the timer unit that ships with this tool. */
export const shippedReleaseCycleMs = (read: (path: string) => string = (path) => readFileSync(path, "utf8")): number => releaseCycleMs(read(WORK_TICK_TIMER));

/**
 * A RUNNER'S FACTS, one of:
 *  - `{ kind: "tool", runner, version, commit? }` -- `version` is the release tag the checkout sits at, or `null` for "at no release" (then `commit` says where)
 *  - `{ kind: "worktree", runner, resolved, declared }` -- `resolved` is the `agent-org` version `node_modules` resolves to, or `null` for none; `declared` is whether the project's `main`
 *    still depends on it (after the removal row it does not, and a resolved copy is then a copy that RETURNED)
 *  - `{ kind: "ci", runner, version, resolvesNewest? }` -- `null` is a run that names no version; `resolvesNewest` is a run whose resolver cloned the newest stable tag at run time (#3746)
 *  - any of them with `unreadable: <why>` instead, which is NAMED and never counted as agreeing
 */
export type RunnerFact = { kind: "tool" | "worktree" | "ci"; runner: string; version?: string | null; commit?: string; resolved?: string | null; declared?: boolean; resolvesNewest?: boolean; unreadable?: string };

/**
 * `behind` is any difference from the newest tag AFTER one cycle (an older version is the normal case; a newer one means the remote's list is the stale one, and is as much a disagreement).
 * `returned` is a copy resolved where the worktree declares none. Both are signals; `unknown` and `unread` are not signals and not agreement either.
 */
export type RunnerReading = { kind: RunnerFact["kind"]; runner: string; version: string | null; verdict: "current" | "behind" | "returned" | "none" | "unknown" | "unread"; detail: string };

export type Agreement = {
  newest: string | null; newestCutAt: number | null; cycleMs: number; unreadable: string | null; readings: RunnerReading[];
  signals: { runner: string; kind: string; version: string | null; newest: string; detail: string }[];
};

/** `0.7.8` and `v0.7.8` are the same release: a package.json says the first, a tag the second. */
const asTag = (version: string): string => (version.startsWith("v") ? version : `v${version}`);

const minutesText = (ms: number): string => {
  const minutes = Math.round(ms / MS_PER_MINUTE);
  return minutes >= MINUTES_PER_HOUR * 2 ? `${Math.round(minutes / MINUTES_PER_HOUR)} h` : `${minutes} min`;
};

/** @returns what the runner is said to run, in the words it would print */
const versionWords = (fact: RunnerFact): string => {
  if (fact.kind === "worktree") return fact.resolved ?? "none";
  if (fact.version === undefined || fact.version === null) return fact.kind === "tool" ? `at no release${fact.commit ? ` (${fact.commit})` : ""}` : "no version";
  return fact.version;
};

/**
 * ONE RUNNER, against the newest tag. `stale` is whether the newest tag is older than one cycle: only then does a difference become a signal, and when its age could not be read a
 * difference is `unknown` (never a signal on a guess, never agreement).
 */
function readingOf(fact: RunnerFact, { newest, stale }: { newest: string; stale: boolean | null; }): RunnerReading {
  const base = { kind: fact.kind, runner: fact.runner };
  if (fact.unreadable !== undefined) return { ...base, version: null, verdict: "unread", detail: `UNREAD -- ${fact.unreadable}` };
  if (fact.kind === "worktree" && fact.resolved === null) return { ...base, version: null, verdict: "none", detail: "none resolved" };
  if (fact.kind === "worktree" && fact.declared === false) {
    return { ...base, version: fact.resolved ?? null, verdict: "returned", detail: `a copy (${fact.resolved}) is resolved although the project no longer declares the dependency` };
  }
  const version = fact.kind === "worktree" ? fact.resolved ?? null : fact.version ?? null;
  if (version === null && fact.kind !== "tool") return { ...base, version, verdict: "unknown", detail: "UNKNOWN -- the run names no version" };
  if (fact.resolvesNewest === true) return { ...base, version, verdict: "current", detail: `${version} was the newest stable tag when the run took it, and every run takes the newest` };
  if (version !== null && !isReleaseTag(asTag(version))) return { ...base, version, verdict: "unknown", detail: `UNKNOWN -- \`${version}\` is not a release version` };
  if (version !== null && compareReleaseTags(asTag(version), newest) === 0) return { ...base, version, verdict: "current", detail: `${version} is the newest` };
  if (stale === null) return { ...base, version, verdict: "unknown", detail: `UNKNOWN -- differs from ${newest}, but when ${newest} was cut could not be read` };
  if (!stale) return { ...base, version, verdict: "current", detail: `${versionWords(fact)}, ${newest} is not yet a cycle old` };
  return { ...base, version, verdict: "behind", detail: `BEHIND -- runs ${versionWords(fact)}, the newest release is ${newest}` };
}

/**
 * THE COMPARISON, pure: every fact is handed in. `tags` is the tool's REMOTE tag list (`null` or no stable tag in it is UNREADABLE, reported and never read as agreement);
 * `newestCutAt` is when the newest stable tag was cut, epoch ms (`null` when unread).
 */
export function agreement({ now, tags, newestCutAt, runners, cycleMs }: { now: number; tags: string[] | null; newestCutAt: number | null; runners: RunnerFact[]; cycleMs: number; }): Agreement {
  const newest = tags === null ? null : chooseReleaseTag(tags, LATEST);
  if (newest === null) {
    const why = tags === null ? "the tool's remote tag list could not be read" : "the tool's remote holds no stable release tag (`vX.Y.Z`)";
    const readings = runners.map((fact) => ({ kind: fact.kind, runner: fact.runner, version: null, verdict: "unread", detail: `UNREAD -- ${why}, so there is nothing to compare it to` }) as RunnerReading);
    return { newest: null, newestCutAt: null, cycleMs, unreadable: why, readings, signals: [] };
  }
  const stale = newestCutAt === null ? null : now - newestCutAt > cycleMs;
  const readings = runners.map((fact) => readingOf(fact, { newest, stale }));
  const signals = readings.filter((r) => r.verdict === "behind" || r.verdict === "returned")
    .map((r) => ({ runner: r.runner, kind: r.kind, version: r.version, newest, detail: r.detail }));
  return { newest, newestCutAt, cycleMs, unreadable: null, readings, signals };
}

/** The one-line account of the newest tag. */
function newestLine(result: Agreement, now: number): string {
  if (result.newest === null) return `agent-org versions: UNREADABLE -- ${result.unreadable}.`;
  const cut = result.newestCutAt === null ? "cut at an unread time" : `cut ${new Date(result.newestCutAt).toISOString().replace(/\.\d+Z$/, "Z")}, ${minutesText(now - result.newestCutAt)} ago`;
  return `agent-org versions: the newest release is ${result.newest} (${cut}; one release cycle is ${minutesText(result.cycleMs)}).`;
}

/** THE REPORT BOTH `host:check` AND THE ORG-HEALTH TICK PRINT: one result, one text, so the two cannot say different things about the same facts. */
export function agreementReport(result: Agreement, now: number): string {
  const quiet = (r: RunnerReading) => r.verdict === "current" || r.verdict === "none";
  const named = result.readings.filter((r) => !quiet(r)).toSorted((a, b) => PRINT_ORDER.indexOf(a.verdict) - PRINT_ORDER.indexOf(b.verdict));
  const shown = named.slice(0, MAX_ROWS_PRINTED);
  const rows = shown.map((r) => `  ${r.kind.padEnd("worktree".length)}  ${r.runner}: ${r.detail}\n`).join("");
  const counted = result.readings.length - named.length;
  const elided = named.length - shown.length;
  const rest = (elided === 0 ? "" : `  ... and ${elided} more named runner(s) in the same state (all of them are in \`--json\`).\n`)
    + (counted === 0 ? "" : `  ${counted} more read as current or as none resolved.\n`);
  const verdict = result.signals.length === 0 ? "no runner is behind." : `${result.signals.length} runner(s) NOT on the newest release for longer than one cycle.`;
  return `${newestLine(result, now)}\n${rows}${rest}  ${verdict}\n`;
}

const why = (err: unknown): string => String((err as { message?: unknown } | null | undefined)?.message ?? err).split("\n")[0];

/**
 * git for a reader whose failure is an ANSWER (a commit with no lockfile, a ref this clone does not hold): stderr is captured with the failure and not left on the terminal, which a
 * `host:check` run and a tick's journal would otherwise carry as a line that is not a fault.
 */
const quietGit = (cwd: string): (args: string[]) => string => (args) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });

// ---- THE READERS: each fact above, from the machine. Every one takes its IO so a test hands it a fixture, and every failure is a NAMED unread fact, never a throw. ----

/**
 * The tool's REMOTE tag names and when the newest was cut. The list is `git ls-remote --tags --refs origin` in the tool's checkout; the time is the tag's own date when the
 * checkout holds it (release tags are lightweight tags on the release commit, so its commit date IS the cut: measured on v0.23.0, commit 20:15:26Z, GitHub Release 20:15:29Z), else
 * the GitHub Release's `published_at`.
 */
export function readRemoteTags({ tool }: { tool: string; }, { git = quietGit(tool), gh = defaultGh, repo = "a11ign/agent-org" }: { git?: (args: string[]) => string; gh?: (args: string[]) => string; repo?: string; } = {}): { tags: string[] | null; newestCutAt: number | null; } {
  let tags: string[];
  try {
    tags = git(["ls-remote", "--tags", "--refs", "origin"]).split("\n").map((line) => line.split("\trefs/tags/")[1]).filter(Boolean);
  } catch {
    return { tags: null, newestCutAt: null };
  }
  const newest = chooseReleaseTag(tags, LATEST);
  return { tags, newestCutAt: newest === null ? null : tagCutAt(newest, { git, gh, repo }) };
}

/** When a tag was cut, epoch ms, or `null` when neither source could say. */
function tagCutAt(tag: string, { git, gh, repo }: { git: (args: string[]) => string; gh: (args: string[]) => string; repo: string; }): number | null {
  try {
    const local = git(["for-each-ref", "--format=%(creatordate:unix)", `refs/tags/${tag}`]).trim();
    if (local !== "") return Number(local) * MS_PER_SECOND;
  } catch {
    // the checkout cannot say: the release below is the second source, and its own refusal is the `null`
  }
  try {
    const published = Date.parse(JSON.parse(gh(["api", `repos/${repo}/releases/tags/${tag}`])).published_at);
    return Number.isNaN(published) ? null : published;
  } catch {
    return null;
  }
}

const defaultGh = (args: string[]): string => execFileSync("gh", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });

/** READING 1, THE TOOL CHECKOUT: the release tag it sits at (`liveToolVersion`, which is the board line's reader and is CALLED, not rewritten), else "at no release" and its commit. */
export function readToolCheckout({ tool }: { tool: string; }, { git = gitIn(tool) }: { git?: (args: string[]) => string; } = {}): RunnerFact {
  const runner = `tool checkout ${tool}`;
  try {
    const version = liveToolVersion(git);
    return version !== null ? { kind: "tool", runner, version } : { kind: "tool", runner, version: null, commit: git(["rev-parse", "--short", "HEAD"]).trim() };
  } catch (err) {
    return { kind: "tool", runner, unreadable: why(err) };
  }
}

/** The worktrees of one checkout, from `git worktree list --porcelain`, those whose directory is gone (`prunable`) left out: they run nothing. */
export function worktreePaths(checkout: string, git: (args: string[]) => string = quietGit(checkout)): string[] {
  return git(["worktree", "list", "--porcelain"]).split("\n\n").filter((block) => block.trim() !== "" && !/^prunable\b/m.test(block))
    .map((block) => (/^worktree (.+)$/m.exec(block) as RegExpExecArray)[1]);
}

/**
 * WHETHER THE PROJECT'S `main` STILL DEPENDS ON `agent-org`, in any group of its `package.json`, as `origin/main` holds it: that is what says "the removal row (#3534) has merged", and it is read
 * ONCE for the project because a worktree's own `package.json` is whatever branch it is on (a worktree cut before the pin existed declares none and still resolves the shared copy). An unreadable
 * `main` is `true`: the answer then is the version comparison, which signals on any copy that is not the newest, and not a silence.
 */
export function mainDeclaresAgentOrg(checkout: string, git: (args: string[]) => string = quietGit(checkout)): boolean {
  try {
    const manifest = JSON.parse(git(["show", "origin/main:package.json"]));
    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((group) => manifest[group]?.["agent-org"] !== undefined);
  } catch {
    return true;
  }
}

/**
 * READING 2, ONE WORKTREE: the `version` of `node_modules/agent-org/package.json` (read THROUGH the symlink a worktree's `node_modules` is), `null` when it resolves to nothing. `declared` is
 * the PROJECT's ({@link mainDeclaresAgentOrg}) and rides on the fact.
 */
export function readWorktree(path: string, { declared = true, read = (file) => readFileSync(file, "utf8") }: { declared?: boolean; read?: (file: string) => string; } = {}): RunnerFact {
  try {
    return { kind: "worktree", runner: path, resolved: JSON.parse(read(join(path, "node_modules", "agent-org", "package.json"))).version ?? null, declared };
  } catch (err) {
    if ((err as { code?: unknown } | null | undefined)?.code === "ENOENT") return { kind: "worktree", runner: path, resolved: null, declared };
    return { kind: "worktree", runner: path, unreadable: why(err) };
  }
}

/**
 * What a CI resolver step prints, which the detector reads. Two forms: `agent-org resolved vX.Y.Z` (a tag the project named) and, since #3534, the notice `scripts/agent-org-newest-tag.mjs`
 * emits, which a log shows as `##[notice]resolved vX.Y.Z, the newest stable of N tags, into <dir>` (the `title=agent-org` is dropped from the log). THE SECOND GROUP IS WHAT THE NOTICE MEANS:
 * the tag was the newest at the run's own time, so a release cut after the run does not make that CI "behind" (the next run takes it).
 */
export const RESOLVER_LINE = /^.*(?:\bagent-org resolved|##\[notice\]resolved) (v\d+\.\d+\.\d+)(, the newest stable of \d+ tags)?\b/m;
/** A memo value for a run whose resolver took the newest tag at run time: the tag, then this. A bare tag (every memo written before #3746) is a pinned one. */
const NEWEST_AT_RUN = " newest";

/** The `agent-org` entry of a pnpm lockfile, as the commit its tarball names, or `null` when it has none. */
export const lockedCommit = (lockfile: string): string | null => /agent-org\/tar\.gz\/([0-9a-f]{40})/.exec(lockfile)?.[1] ?? null;

export type RunMemo = { get: (runId: number) => string | null | undefined; set: (runId: number, version: string | null) => void };

/**
 * A MEMO OF WHAT A FINISHED RUN'S LOG SAID, by run id: a completed run's log never changes, and reading one is a download the tick would repeat every two minutes. It is not state of the
 * signal (the signal is recomputed from the readings every time); deleting the file costs one download.
 */
export function memoFile(path: string): RunMemo {
  const load = () => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, string | null>;
    } catch {
      return {};
    }
  };
  return {
    get: (runId: number) => load()[runId],
    set: (runId: number, version: string | null) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ ...load(), [runId]: version }));
    },
  };
}

/**
 * READING 3, THE LAST COMPLETED `ci.yml` RUN THAT GATES `main`: the newest completed `merge_group` run (a merge queue's run is the one that decides a merge, and it lives on a
 * `gh-readonly-queue/...` branch, so `branch=main` never returns it), else the newest completed run on `main` for a repository with no queue. #3746, measured 2026-10-06: the host repository's
 * `ci.yml` last ran on a `push` to `main` on 2026-09-18 and on `merge_group` since, so the `branch=main` question answered that one failed run for ever and no event could change it.
 * Its version is what its commit's LOCKFILE names while the project pins the tool (the tarball's commit, read as the `version` in the tool's own `package.json` at that commit); once it
 * holds no entry, the tag the resolver step printed in the run's log ({@link RESOLVER_LINE}). A run that names no version is `version: null`, which the comparison reports UNKNOWN.
 */
export function readLastCiRun({ checkout, tool, repo }: { checkout: string; tool: string; repo: string; }, { gh = defaultGh, git = quietGit(checkout), toolGit = quietGit(tool), memo }: { gh?: (args: string[]) => string; git?: (args: string[]) => string; toolGit?: (args: string[]) => string; memo?: RunMemo; } = {}): RunnerFact {
  try {
    const run = gatingRun({ gh, repo });
    if (run === undefined) return { kind: "ci", runner: `last completed ci.yml run on ${repo} main`, unreadable: "no completed run was returned" };
    const runner = `last completed ci.yml ${run.event} run (#${run.id}, ${String(run.head_sha).slice(0, 7)}, ${String(run.created_at).slice(0, 10)})`;
    try {
      return { kind: "ci", runner, ...ciVersion({ run, repo }, { gh, git, toolGit, memo }) };
    } catch (err) {
      return { kind: "ci", runner, unreadable: why(err) };
    }
  } catch (err) {
    return { kind: "ci", runner: `last completed ci.yml run on ${repo} main`, unreadable: why(err) };
  }
}

/** The newest completed `ci.yml` run that gates `main`, or `undefined` when neither question returns one. */
function gatingRun({ gh, repo }: { gh: (args: string[]) => string; repo: string; }): { id: number; head_sha: string; created_at: string; event: string; } | undefined {
  const newest = (filter: string) => JSON.parse(gh(["api", `repos/${repo}/actions/workflows/ci.yml/runs?${filter}&status=completed&per_page=1`])).workflow_runs?.[0];
  return newest("event=merge_group") ?? newest("branch=main");
}

/**
 * The version a run ran, or `null`. The lockfile at the run's commit answers while the project still pins the tool (a commit with none, or one this checkout does not hold, simply has no entry);
 * when it holds no entry the log's resolver line does, and says whether it took the newest tag at run time.
 */
function ciVersion({ run, repo }: { run: { id: number; head_sha: string; }; repo: string; }, { gh, git, toolGit, memo }: { gh: (args: string[]) => string; git: (args: string[]) => string; toolGit: (args: string[]) => string; memo?: RunMemo; }): { version: string | null; resolvesNewest?: boolean; } {
  const commit = lockedCommit(lockfileAt(run.head_sha, git));
  if (commit !== null) return { version: JSON.parse(toolGit(["show", `${commit}:package.json`])).version ?? null };
  const memoized = memo?.get(run.id);
  if (memoized !== undefined) return fromMemo(memoized);
  const found = RESOLVER_LINE.exec(logOf(run.id, { gh, repo }));
  const resolved = { version: found?.[1] ?? null, resolvesNewest: found?.[2] !== undefined };
  memo?.set(run.id, resolved.version !== null && resolved.resolvesNewest ? `${resolved.version}${NEWEST_AT_RUN}` : resolved.version);
  return resolved;
}

function fromMemo(memoized: string | null): { version: string | null; resolvesNewest?: boolean; } {
  if (memoized !== null && memoized.endsWith(NEWEST_AT_RUN)) return { version: memoized.slice(0, -NEWEST_AT_RUN.length), resolvesNewest: true };
  return { version: memoized };
}

/** A run's log, or "" when GitHub says it has none (expired, or never kept): that is an ANSWER about the run, where any other refusal is rethrown. */
function logOf(id: number, { gh, repo }: { gh: (args: string[]) => string; repo: string; }): string {
  try {
    return gh(["run", "view", String(id), "--repo", repo, "--log"]);
  } catch (err) {
    if (/log not found/.test(`${(err as { stderr?: unknown } | null | undefined)?.stderr ?? ""}${(err as { message?: unknown } | null | undefined)?.message ?? ""}`)) return "";
    throw err;
  }
}

/** @returns the lockfile at a commit, empty when there is none */
function lockfileAt(sha: string, git: (args: string[]) => string): string {
  try {
    return git(["show", `${sha}:pnpm-lock.yaml`]);
  } catch {
    return "";
  }
}

/** The `owner/name` an origin URL names. */
export const repoOfOrigin = (url: string): string | null => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(url.trim())?.[1] ?? null;

/**
 * EVERY FACT, FROM THE MACHINE: the host's tool, each worktree of each declared project, and the last CI run of the PRIMARY project. A project's repository that cannot be named is
 * an unread CI reading, never an omitted one.
 */
export function readFacts(host: { tool: string; primary?: string; projects: { id: string; checkout: string; }[]; }, { now = Date.now(), cycle = shippedReleaseCycleMs, memo }: { now?: number; cycle?: () => number; memo?: RunMemo; } = {}): { now: number; tags: string[] | null; newestCutAt: number | null; runners: RunnerFact[]; cycleMs: number; } {
  const { tags, newestCutAt } = readRemoteTags(host);
  const runners = [readToolCheckout(host), ...host.projects.flatMap((project) => worktreeFacts(project.checkout))];
  const primary = host.projects.find((project) => project.id === host.primary) ?? host.projects[0];
  if (primary !== undefined) runners.push(ciFact(primary.checkout, host.tool, memo));
  return { now, tags, newestCutAt, runners, cycleMs: cycle() };
}

function worktreeFacts(checkout: string): RunnerFact[] {
  try {
    const declared = mainDeclaresAgentOrg(checkout);
    return worktreePaths(checkout).filter((path) => existsSync(path)).map((path) => readWorktree(path, { declared }));
  } catch (err) {
    return [{ kind: "worktree", runner: checkout, unreadable: why(err) }];
  }
}

function ciFact(checkout: string, tool: string, memo: RunMemo | undefined): RunnerFact {
  try {
    const repo = repoOfOrigin(quietGit(checkout)(["remote", "get-url", "origin"]));
    if (repo !== null) return readLastCiRun({ checkout, tool, repo }, { memo });
    return { kind: "ci", runner: `last completed ci.yml run on ${checkout}`, unreadable: "the checkout's origin names no GitHub repository" };
  } catch (err) {
    return { kind: "ci", runner: `last completed ci.yml run on ${checkout}`, unreadable: why(err) };
  }
}

/**
 * THE CLI, `node src/lib/tool-version-agreement.ts [--json]`: the whole reading for the host this runs on. `--json` is what the gate's org-health read calls in a CHILD, so the
 * history readers stay out of the gate's import closure (`host-units.mjs`'s `jsonReport` is the precedent), and it prints the RESULT, not the text, so the tick formats it with the
 * same {@link agreementReport}.
 */
async function main() {
  const { homeHostConfig, stateEntryPath } = await import("../host-config.ts");
  const host = homeHostConfig();
  if (host.tool === undefined) {
    // a host that declares no tool has no tool checkout to compare: not asked, which `--json` says so the tick does not read it as a clear
    process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify({ asked: false })}\n` : "agent-org versions: NOT CHECKED -- this host declares no `tool`.\n");
    return;
  }
  const now = Date.now();
  const memo = memoFile(stateEntryPath("tool-version-ci-logs.json", { host }));
  const result = agreement(readFacts({ tool: host.tool, primary: host.primary, projects: host.projects }, { now, memo }));
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify({ now, result })}\n` : agreementReport(result, now));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
