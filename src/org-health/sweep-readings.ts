import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { openIncidentsOf } from "../ticket-port/open-incidents.ts";
import { closeIncident, closedIncidentsOf, createIncident, jobLogOf } from "../ticket-port/release-incidents.ts";
import { COPY_COMPARED_IN, TEAM_LEVELS, TEAM_LISTING_JQ, TEAM_PAGE_SIZE, isInstalledOriginal, type CopyPair, type SweepRead, type TeamAccessFact, type TeamRepository } from "./board-truth-readings.ts";
import { COPIES_DIR, COPY_HEADER_CHANGES, COPY_HEADER_END, COPY_HEADER_START, DEFAULT_ROOT, MAX_NAMED, MAX_REASON_CHARS, MERGED_WINDOW, MINUTES_PER_TICK, MS_PER_MINUTE, SIGNALS, TOOL_ROOT, ageText, clear, type Reading, unknown } from "./thresholds.ts";
import { openFor, readOrNull } from "./overdue-readings.ts";

/** agent-org#1418: `sweepMinutes` is `GRAPHQL_SWEEP_MINUTES`, the longest a repository may go unread on a webhook tick. */
export type SweepFact = { sweepMinutes: number, repos: SweepRead[] };

/**
 * SIGNAL 15 (agent-org#1418): A DECLARED REPOSITORY HAS GONE UNREAD LONGER THAN THE SWEEP PROMISES (a11ign/a11ign#5408: nine partial ticks, and three
 * agent pull requests waited about 20 minutes with no alert). A webhook tick reads a repository only where its events named it or it is due a sweep, and
 * a paced tick can refuse a whole read, which leaves the stamp old. The limit is the sweep plus one tick (`MINUTES_PER_TICK`), and "older than" is strict,
 * so a repository read on the tick's edge is not a trip. A trip names each repository and its age.
 *
 * A MISSING STAMP IS UNKNOWN, NEVER CLEAR: nothing is remembered as read, so the memory says nothing about that repository at all. A trip stands over
 * an unstamped repository, as a trip stands over an unread team in `teamAccessReading`.
 */
export function sweepOverdueReading({ now, sweeps }: { now: number; sweeps: SweepFact; }): Reading {
  const limit = (sweeps.sweepMinutes + MINUTES_PER_TICK) * MS_PER_MINUTE;
  const late = sweeps.repos.flatMap((r) => (r.readAtMs !== undefined && now - r.readAtMs > limit
    ? [{ name: r.name, text: `${r.name} (last whole read ${ageText(r.readAtMs, now)} ago)` }] : []));
  if (late.length > 0) {
    const named = late.slice(0, MAX_NAMED).map((l) => l.text).join("; ");
    const more = late.length > MAX_NAMED ? `, and ${late.length - MAX_NAMED} more` : "";
    return { signal: SIGNALS.SWEEP_OVERDUE, status: "tripped", firstTrippedAt: null,
      discriminator: `${SIGNALS.SWEEP_OVERDUE}@${late.map((l) => l.name).sort().join(",")}`,
      detail: `${late.length} repositor${late.length === 1 ? "y" : "ies"} unread for longer than the sweep plus one tick: ${named}${more}` };
  }
  const unstamped = sweeps.repos.filter((r) => r.readAtMs === undefined).map((r) => r.name);
  if (unstamped.length > 0) {
    return unknown(SIGNALS.SWEEP_OVERDUE, `CANNOT_TELL: no whole read is stamped for ${unstamped.slice(0, MAX_NAMED).join(", ")}, so its age is not known`);
  }
  return clear(SIGNALS.SWEEP_OVERDUE);
}

/** @returns `null` for a line that is not six fields: a partial listing is not a reading */
export function parseTeamListing(text: string): TeamRepository[] | null {
  const rows = [];
  for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
    const [repo, ...flags] = line.split("\t");
    if (!repo || flags.length !== TEAM_LEVELS.length) return null;
    rows.push({ repo, level: TEAM_LEVELS.find((_, i) => flags[i] === "true") ?? "none" });
  }
  return rows;
}

/**
 * THE DECLARATION THE PROJECT NAMES, as `{ org, declared, teams }`, or `{ unreadable }`. The route is `teamAccess.declaration` in `.agent-org/project.json`
 * (a path relative to the project root, which may not climb out of it): `agent-org` names no project's file. The file's own shape is the contract: `teams`
 * maps a team's slug to `{ layer }`, and `repositories` is keyed by the `owner/name` of each declared repository, whose common owner is the org. A
 * malformed key is a named reason and never a silent off, so a project that mistyped it is told on the next tick rather than believing it is watched.
 * A team may carry `exceptions`, `{ "<owner>/<name>": "<level>" }`: the level it is DELIBERATELY kept at on that one repository instead of `layer`
 * (a11ign/a11ign#4467: `bots` stays off `a11ign/.github`, which would otherwise be a permanent trip). See `teamExceptionsOf` for what is refused.
 */
function readTeamDeclaration(root: string, read: (path: string) => string): { declaration: undefined; } | { unreadable: string; } | { org: string; declared: string[]; teams: { team: string; layer: string; exceptions: Record<string, string>; }[]; } {
  const project = `${root}/.agent-org/project.json`;
  try {
    const key = JSON.parse(read(project)).teamAccess;
    if (key === undefined) return { declaration: undefined };
    if (typeof key?.declaration !== "string" || key.declaration === "" || resolve(root, key.declaration).startsWith(`${resolve(root)}/`) === false) {
      return { unreadable: `${project}: teamAccess.declaration must be a path inside the project (CANNOT_TELL)` };
    }
    return teamDeclarationOf(JSON.parse(read(resolve(root, key.declaration))), key.declaration);
  } catch (err) {
    return { unreadable: `the team declaration could not be read: ${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)} (CANNOT_TELL)` };
  }
}

function teamDeclarationOf(file: any, where: string): ReturnType<typeof readTeamDeclaration> {
  const declared = Object.keys(file?.repositories ?? {}).filter((k) => !k.startsWith("_"));
  const orgs = new Set(declared.map((repo) => repo.split("/")[0]));
  const teams = Object.entries(file?.teams ?? {}).filter(([k]) => !k.startsWith("_"))
    .map(([team, level]) => ({ team, layer: (level as any)?.layer, exceptions: (level as any)?.exceptions }));
  if (orgs.size !== 1 || teams.some((t) => typeof t.layer !== "string")) {
    return { unreadable: `${where}: it must declare \`repositories\` of one org and each \`teams.<slug>.layer\` as a string (CANNOT_TELL)` };
  }
  const refused = teams.map((t) => teamExceptionsOf(t, declared)).find((r) => typeof r === "string");
  if (refused !== undefined) return { unreadable: `${where}: ${refused} (CANNOT_TELL)` };
  return { org: [...orgs][0], declared, teams: teams.map((t) => ({ ...t, exceptions: t.exceptions ?? {} })) };
}

/** The levels an exception may name: `admin` is a trip anywhere (`teamDifferences`), so declaring it as the expected level would bless the thing the signal exists to catch. */
const EXCEPTION_LEVELS = Object.freeze(["none", ...TEAM_LEVELS.filter((level) => level !== "admin")]);

/**
 * @returns why the team's `exceptions` cannot be believed, or `undefined` when it is absent or sound. An exception naming a repository the declaration
 * does not list is refused rather than ignored: it would expect nothing of anything, and a mistyped name must be told on the next tick, not believed to be watching.
 */
function teamExceptionsOf({ team, exceptions }: { team: string; exceptions?: any; }, declared: string[]): string | undefined {
  if (exceptions === undefined) return undefined;
  if (exceptions === null || typeof exceptions !== "object" || Array.isArray(exceptions)) return `teams.${team}.exceptions must map an owner/name to a level`;
  const entries = Object.entries(exceptions).filter(([repo]) => !repo.startsWith("_"));
  const strange = entries.find(([repo]) => !declared.includes(repo));
  if (strange) return `teams.${team}.exceptions names ${strange[0]}, which \`repositories\` does not list`;
  const level = entries.find(([, l]) => typeof l !== "string" || !EXCEPTION_LEVELS.includes(l));
  if (level) return `teams.${team}.exceptions.${level[0]} must be one of ${EXCEPTION_LEVELS.join(", ")} (admin is a trip anywhere and is not an exception)`;
  return undefined;
}

/**
 * THE FACT FOR `teamAccessReading`: the declaration, then ONE paginated REST call per declared team on the core pool (`gh api` spends core, never GraphQL, `gh-api-budget.md`).
 * `undefined` is "not asked" (the project declares no `teamAccess`), `{ unreadable }` a read that failed, and a team GitHub refused is `reached: null` with its own reason.
 * NEVER THROWS.
 */
export function readTeamAccess(run: (args: string[]) => string, { root = HOME_CHECKOUT, read = (path) => readFileSync(path, "utf8") }: { root?: string; read?: (path: string) => string; } = {}): TeamAccessFact | undefined {
  const found = readTeamDeclaration(root, read);
  if ("declaration" in found) return undefined;
  if ("unreadable" in found) return found;
  return { teams: found.teams.map(({ team, layer, exceptions }) => ({ team, layer, exceptions, declared: found.declared, ...readTeamRepositories(run, found.org, team) })) };
}

function readTeamRepositories(run: (args: string[]) => string, org: string, team: string): { reached: TeamRepository[] | null; why: string; } {
  try {
    const reached = parseTeamListing(run(["api", `orgs/${org}/teams/${team}/repos?per_page=${TEAM_PAGE_SIZE}`, "--paginate", "--jq", TEAM_LISTING_JQ]));
    return reached === null ? { reached, why: "GitHub answered a line that is not a repository's permissions" } : { reached, why: "" };
  } catch (err) {
    return { reached: null, why: String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS) };
  }
}

/** @returns the text with the copy header block removed, wherever it sits */
function withoutCopyHeader(text: string): { body: string; complete: boolean; } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => COPY_HEADER_START.test(line));
  const end = lines.indexOf(COPY_HEADER_END);
  if (start < 0 || end < start) return { body: text, complete: false };
  return { body: [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n"), complete: true };
}

/**
 * How many lines of `lines` have no counterpart left in `against`, counted as a MULTISET so a moved or duplicated line is not
 * mistaken for an edit and an edit is one line on each side.
 */
function linesWithoutCounterpart(lines: string[], against: string[]): number {
  const left = new Map();
  for (const line of against) left.set(line, (left.get(line) ?? 0) + 1);
  let without = 0;
  for (const line of lines) {
    const available = left.get(line) ?? 0;
    if (available > 0) left.set(line, available - 1);
    else without += 1;
  }
  return without;
}

/**
 * A copy drifts when more of the ORIGINAL'S lines are changed or gone than its OWN HEADER names, or when a header that names NOTHING
 * sits above a copy with lines the original lacks. THE HEADER'S COUNT IS THE ALLOWANCE, which is what lets the pair list be discovered
 * rather than declared a second time -- and its price is stated here: a one-byte change ON a line the header already names is inside
 * the allowance, and so are the copy's own extra lines once the header names any change, because the header counts the original's
 * lines it changed and ONE of them can become several (`changed-packages.ts`'s `REPO` became four lines under "3 NAMED LINES", #2884). `agent-org-outward-edges.test.ts` applies each sanctioned edit exactly and
 * is the exact check; this is the cheap one that runs on every tick.
 */
function judgePair(pair: CopyPair): { verdict: "same" | "drifted" | "unknown"; why: string; } {
  if (pair.originalText === null) return { verdict: "unknown", why: `${pair.original} could not be read` };
  if (isInstalledOriginal(pair.original)) {
    return pair.comparedIn ? { verdict: "same", why: "" }
      : { verdict: "unknown", why: `${pair.original} is installed compiled and no test that is still reading this stem is named by its header, so nothing compares it` };
  }
  const { body, complete } = withoutCopyHeader(pair.copyText);
  if (!complete) return { verdict: "drifted", why: "the copy has no complete header" };
  if (pair.allowedLines === null) return { verdict: "unknown", why: "its header does not say how many lines it changed" };
  const copyLines = body.split("\n");
  const originalLines = pair.originalText.split("\n");
  const extra = linesWithoutCounterpart(copyLines, originalLines);
  const missing = linesWithoutCounterpart(originalLines, copyLines);
  if (missing <= pair.allowedLines && (extra === 0 || pair.allowedLines > 0)) return { verdict: "same", why: "" };
  return { verdict: "drifted", why: `${extra} line(s) only in the copy, ${missing} only in the original, and its header names ${pair.allowedLines}` };
}

/**
 * SIGNAL 6: A DECLARED COPY NO LONGER MATCHES ITS ORIGINAL (#2937). `packages/guards/src/isolation-gate.ts` and
 * `packages/agent-org/src/lib/isolation-gate.ts` were edited identically BY HAND in #2921: a drift waiting to happen unless a question
 * reads it. `pairs` is `null` for a read that could not run; an EMPTY list is stated as unknown too, because a discovery that finds
 * no copy in a tree that holds nineteen has not found a clean tree.
 */
export function copyDriftReading({ pairs }: { pairs: CopyPair[] | null; }): Reading {
  if (pairs === null) return unknown(SIGNALS.COPIES, "the declared copies could not be read");
  if (pairs.length === 0) return unknown(SIGNALS.COPIES, "no declared copy was found, so none was compared");
  const judged = pairs.map((pair) => ({ pair, ...judgePair(pair) }));
  const drifted = judged.filter((j) => j.verdict === "drifted");
  if (drifted.length === 0) {
    const unread = judged.filter((j) => j.verdict === "unknown");
    return unread.length === 0 ? clear(SIGNALS.COPIES)
      : unknown(SIGNALS.COPIES, `${unread.length} declared copy(ies) could not be compared: ${unread[0].pair.copy} (${unread[0].why})`);
  }
  const named = drifted.slice(0, MAX_NAMED).map(({ pair, why }) => `${pair.copy} against ${pair.original}: ${why}`);
  const more = drifted.length > MAX_NAMED ? `, and ${drifted.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.COPIES, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.COPIES}@${drifted.map(({ pair }) => pair.copy).sort().join(",")}`,
    detail: `${drifted.length} declared cop${drifted.length === 1 ? "y" : "ies"} drifted from the original: ${named.join("; ")}${more}` };
}

/**
 * WHERE AN INSTALLED ORIGINAL IS: `<root>/node_modules/<package>/` plus what the package's own `exports` map gives for the subpath, so the
 * module counts as present only where the package says it ships it. `null` for anything that cannot be read, a package that is not
 * installed and a subpath it no longer exports alike.
 */
function readInstalledOriginal(read: (path: string) => string, root: string, specifier: string): string | null {
  const [scope, name, ...subpath] = specifier.split("/");
  if (name === undefined) return null;
  const dir = `${root}/node_modules/${scope}/${name}`;
  const manifest = readOrNull(read, `${dir}/package.json`);
  if (manifest === null) return null;
  try {
    const entry = JSON.parse(manifest).exports?.[`./${subpath.join("/")}`];
    const target = typeof entry === "string" ? entry : entry?.default;
    return typeof target === "string" ? readOrNull(read, `${dir}/${target.replace(/^\.\//, "")}`) : null;
  } catch {
    return null;
  }
}

/**
 * THE TEST A COPY SAYS COMPARES IT, or `null`: the header names it (`COMPARED IN`), the file must be readable in the tool, and it must still
 * name the copy's stem as a key (`"<stem>":`), so a test that stopped probing this copy, or a header naming a file that is gone, is not "compared".
 */
function comparerOf(read: (path: string) => string, toolRoot: string, copy: string, copyText: string): string | null {
  const lines = copyText.split("\n");
  const named = lines.slice(0, Math.max(lines.indexOf(COPY_HEADER_END), 0)).map((line) => COPY_COMPARED_IN.exec(line)?.[1]).find(Boolean);
  if (named === undefined) return null;
  const stem = copy.split("/").pop()?.replace(/\.[^.]+$/, "");
  const text = readOrNull(read, `${toolRoot}/${named}`);
  return text !== null && text.includes(`"${stem}":`) ? named : null;
}

/**
 * THE DECLARED COPIES OF A CHECKOUT, discovered from the headers: every file in `COPIES_DIR` whose header names its original. `null`
 * when the directory cannot be listed. Each pair's original is read here and is `null` in the pair when it cannot be.
 * `root` is the PROJECT, where each copy's original is read (an original named by package specifier is read from the package installed
 * under it); `toolRoot` is where the copies themselves are.
 */
export function readDeclaredCopies({ root = DEFAULT_ROOT, toolRoot = TOOL_ROOT, list = (dir) => readdirSync(dir), read = (path) => readFileSync(path, "utf8") }: { root?: string; toolRoot?: string; list?: (dir: string) => string[]; read?: (path: string) => string; } = {}): CopyPair[] | null {
  let names;
  try {
    names = list(`${toolRoot}/${COPIES_DIR}`).sort();
  } catch {
    return null; // an unlistable directory is not an empty one
  }
  const pairs: CopyPair[] = [];
  for (const name of names) {
    const copy = `${COPIES_DIR}/${name}`;
    let copyText;
    try {
      copyText = read(`${toolRoot}/${copy}`);
    } catch {
      continue; // a directory or a file that vanished between the list and the read is not a copy
    }
    const original = copyText.split("\n").map((line) => COPY_HEADER_START.exec(line)?.[1]).find(Boolean);
    if (original === undefined) continue;
    const changed = COPY_HEADER_CHANGES.exec(copyText);
    const installed = isInstalledOriginal(original);
    pairs.push({ original, copy, originalText: installed ? readInstalledOriginal(read, root, original) : readOrNull(read, `${root}/${original}`), copyText,
      ...(installed ? { comparedIn: comparerOf(read, toolRoot, copy, copyText) } : {}), allowedLines: changed === null ? null : Number(changed[1] ?? (/ONE LINE/.test(changed[0]) ? 1 : 0)) });
  }
  return pairs;
}

/**
 * WHEN THE PRIMARY STOPPED BEING CURRENT: the committer date of the oldest commit `origin/main` has that HEAD lacks, else the
 * oldest modified time among its dirty tracked files. INFERRED from git and the filesystem, not logged: nothing records the moment
 * `primary:update` first failed. `null` when neither can be read.
 */
export function primaryStandingSince(drift: { behind: number; dirty: string[]; } | null, { root, run = (args) => execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  mtimeOf = (path) => statSync(`${root}/${path}`).mtimeMs }: { root: string; run?: (args: string[]) => string; mtimeOf?: (path: string) => number; }): number | null {
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
 * THE LAST MERGE OF ONE REPOSITORY: `{ at }` (`at` is `null` for a repository with no merged PR among the newest-updated), or `null` when the
 * read was refused or unparseable. The two are told apart because only the second says nothing about the repository.
 */
function askLastMerge(run: (args: string[]) => string, repo: string): { at: number | null; } | null {
  try {
    const out = run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MERGED_WINDOW}`,
      "--jq", "[.[] | select(.merged_at != null) | .merged_at] | max"]);
    // `gh --jq` prints a string RAW (no quotes) and the word `null` for an empty list, both of which `Date.parse` reads as NaN or a time.
    if (out.trim() === "null") return { at: null };
    const at = Date.parse(out.trim());
    return Number.isFinite(at) ? { at } : null;
  } catch {
    return null;
  }
}

/**
 * THE LAST MERGE, as epoch ms, or `null`. ONE REST CALL on the core pool: the newest-UPDATED closed PRs, of which the latest
 * `merged_at` is the answer (merging updates the PR, so every recent merge is among them). `null` -- refused, unparseable, or no
 * merged PR in the window -- is a stated unknown, never "long ago": a refusal says nothing about when the last merge was.
 */
export function readLastMergedAt(run: (args: string[]) => string, repo: string): number | null {
  return askLastMerge(run, repo)?.at ?? null;
}

/**
 * THE ORG'S LATEST MERGE across `repos` (#4047): the work that could land includes rows whose code merges in `agent-org`, so a gap measured
 * in the project's repository alone tripped `no-merge-while-work-exists` falsely twice in a day. ONE call per repository. A repository
 * whose read is refused makes the answer `null` (unknown): the others' older times would put a merge further back than it may be, and that
 * is a false trip. A repository with no merged PR in its window says nothing and is skipped; none anywhere is `null` too.
 */
export function readLatestMerge(run: (args: string[]) => string, repos: readonly string[]): { at: number; repo: string; } | null {
  const asked = repos.map((repo) => ({ repo, merge: askLastMerge(run, repo) }));
  if (asked.some(({ merge }) => merge === null)) return null;
  let latest: { at: number; repo: string; } | null = null;
  for (const { repo, merge } of asked) {
    if (merge?.at != null && (latest === null || merge.at > latest.at)) latest = { at: merge.at, repo };
  }
  return latest;
}

/** How many of the newest `release.yml` runs on `main` the release read looks at: the `status` runs it skips on every commit crowd the list, so the window is wide. */
const RELEASE_RUN_WINDOW = 30;
const RELEASE_JOBS_WINDOW = 100;
/** The job that publishes. A publishing run's jobs are named `release / <job>` (run 38332090768: `release / publish`, see {@link releaseJobPublished}). */
const RELEASE_PUBLISH_JOB = "release / publish";
/**
 * A run that says whether a release happened: any failure, and a success that PUBLISHED. A push to `main` publishes when it concludes success. A dispatch on `main` publishes only when its
 * `release / publish` job did (a dispatch carrying `action-tag-version` is the promote-only run, whose `release / publish` job is skipped by its `needs`). A `status` run's success is a promotion, never a release,
 * so it neither clears a streak nor joins one (a11ign/agent-org#1273: it cleared a streak of two on 2026-10-12). `cancelled`, `skipped`, `neutral` and a run still going say nothing (#4001).
 */
const isVerdict = (r: ReleaseRun): boolean => r.conclusion === "failure" || (r.conclusion === "success" && (r.event === "push" || (r.event === "workflow_dispatch" && r.published === true)));

/**
 * `published` is set only on a `workflow_dispatch` that concluded success: whether its `release / publish` job did too (see {@link isVerdict}). Absent on every other run.
 */
export type ReleaseRun = { id: number, event: string, status: string, conclusion: string | null, sha: string, createdAt: string, updatedAt: string, url: string, published?: boolean };
export type FailedJob = { id?: number, name: string, steps: string[] };
/**
 * `jobs` and `pending` are read only when the newest verdict is a failure; `null` is a read that was refused
 */
export type ReleaseRuns = { runs: ReleaseRun[], jobs?: FailedJob[] | null, pending?: string[] | null };

/** @returns the newest run that says whether a release happened (see {@link isVerdict}): the one that says whether the last release happened */
export function newestReleaseVerdict(runs: ReleaseRun[]): ReleaseRun | undefined {
  return [...runs].filter(isVerdict).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/**
 * SIGNAL 18 (#4001): THE LAST RELEASE RUN ON `main` FAILED AND NOTHING HAS SUCCEEDED SINCE. The newest run that says whether a release happened decides (see {@link isVerdict}): a later
 * publishing `success` clears it, and a `status` run's success, or a run that was cancelled, skipped or is still going, neither trips nor clears it (a promotion is not a release). Any event
 * counts, because a failed release is a failed release whatever started it. A list with no verdict in it is UNKNOWN, never clear: a window of skipped runs says nothing.
 * The jobs and the pending changesets are the DETAIL of a failure already certain, so a refusal of either is said in the detail and does not turn the trip into an unknown.
 */
export function releaseFailedReading({ releaseRuns }: { releaseRuns: ReleaseRuns | null; }): Reading {
  const signal = SIGNALS.RELEASE_FAILED;
  if (releaseRuns === null) return unknown(signal, "the runs of release.yml on main could not be read, so the last release is not known to have succeeded");
  const verdict = newestReleaseVerdict(releaseRuns.runs);
  if (verdict === undefined) return unknown(signal, `none of the newest ${releaseRuns.runs.length} release.yml run(s) on main concluded success or failure, so no release is known to have happened or failed`);
  if (verdict.conclusion === "success") return clear(signal);
  const failedAt = Date.parse(verdict.updatedAt);
  return { signal, status: "tripped", firstTrippedAt: Number.isFinite(failedAt) ? failedAt : null, discriminator: `${signal}@${verdict.id}`,
    detail: `release.yml on main FAILED and no later run succeeded: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(releaseRuns.jobs)}; ${pendingText(releaseRuns.pending)}; ${verdict.url}` };
}

function failedJobsText(jobs: FailedJob[] | null | undefined): string {
  if (!jobs) return "the failing job could not be read (read the run)";
  if (jobs.length === 0) return "no job of it reports failure (read the run)";
  const named = jobs.slice(0, MAX_NAMED).map(({ name, steps }) => `job \`${name}\`${steps.length > 0 ? ` (step ${steps.map((s) => `"${s}"`).join(", ")})` : ""}`);
  return `${named.join("; ")}${jobs.length > MAX_NAMED ? `; and ${jobs.length - MAX_NAMED} more` : ""}`;
}

function pendingText(pending: string[] | null | undefined): string {
  if (!pending) return "the pending changesets could not be read";
  if (pending.length === 0) return "no changeset is pending in .changeset/";
  return `${pending.length} changeset(s) pending in .changeset/: ${pending.slice(0, MAX_NAMED).join(", ")}${pending.length > MAX_NAMED ? ", ..." : ""}`;
}

/**
 * THE FACT FOR `releaseFailedReading`: ONE REST CALL on the core pool for the newest `release.yml` runs on `main`, and, only while the newest verdict is a failure, TWO MORE
 * (that run's jobs, and `.changeset/` on `main`). `null` is a refused or unparseable list, a stated unknown and never "no failure". NEVER THROWS.
 */
export function readReleaseRuns(run: (args: string[]) => string, repo: string): ReleaseRuns | null {
  const runs: ReleaseRun[] | null = tryJson(() => run(["api", "--method", "GET", `repos/${repo}/actions/workflows/release.yml/runs`, "-f", "branch=main", "-f", `per_page=${RELEASE_RUN_WINDOW}`,
    "--jq", "[.workflow_runs[] | {id, event, status, conclusion, sha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, url: .html_url}]"]));
  if (!Array.isArray(runs)) return null;
  for (const r of runs) if (r.event === "workflow_dispatch" && r.conclusion === "success") r.published = releaseJobPublished(run, repo, r.id);
  const verdict = newestReleaseVerdict(runs);
  if (verdict?.conclusion !== "failure") return { runs };
  const jobs = releaseJobsOf(run, repo, verdict.id, "[.jobs[] | select(.conclusion == \"failure\") | {id, name, steps: [.steps[] | select(.conclusion == \"failure\") | .name]}]");
  const files = tryJson(() => run(["api", `repos/${repo}/contents/.changeset?ref=main`, "--jq", "[.[].name]"]));
  return { runs, jobs: Array.isArray(jobs) ? jobs : null,
    pending: Array.isArray(files) ? files.filter((name) => name.endsWith(".md") && name !== "README.md") : null };
}

/**
 * @returns whether the run's publishing job concluded success: the one answer that tells a publishing dispatch from a promote-only one. A refused read is `false`, which neither clears nor trips.
 * The job is `release / publish`, not `release`: a called workflow's jobs are named `<caller job> / <job>`, so no job of a publishing run is named exactly `release`
 * (a11ign/agent-org#1298: that name matched nothing, so every dispatch read as promote-only and a release that shipped still read as failing).
 */
function releaseJobPublished(run: (args: string[]) => string, repo: string, id: number): boolean {
  const jobs = releaseJobsOf(run, repo, id, "[.jobs[] | {name, conclusion}]");
  return Array.isArray(jobs) && jobs.some((job) => job.name === RELEASE_PUBLISH_JOB && job.conclusion === "success");
}

/** @returns the jobs of one run as `jq` shapes them: the one read of a run's jobs, so the `gh` call site is counted once (agent-org#1273, gh-call-baseline). `null` for a refusal or text that is not JSON. */
function releaseJobsOf(run: (args: string[]) => string, repo: string, id: number, jq: string): any {
  return tryJson(() => run(["api", `repos/${repo}/actions/runs/${id}/jobs?per_page=${RELEASE_JOBS_WINDOW}`, "--jq", jq]));
}

/** @returns the parsed output, or `null` for a refusal or text that is not JSON: a stated gap for the caller, never an empty answer */
function tryJson(read: () => string): any {
  try {
    return JSON.parse(read());
  } catch {
    return null;
  }
}

// --- agent-org#887: A FAILED RELEASE ON ANY REPOSITORY THE ORG RELEASES, NAMING THE RUN'S FIRST ERROR LINE, AND THE SECOND ONE IN A ROW WAKES `ceo` ---------------------------------
//
// THE GAP (a11ign/agent-org#885 class 1, chairman 2026-10-11): `readReleaseRuns` is asked of ONE repository, the project's, so five failed `release.yml` runs of agent-org's own `main` were read by nobody for
// 50+ minutes. THE READING IS NOW ONE PER REPOSITORY, each with its own discriminator (`release-run-failed@<repo>@<first failed run of the streak>`), so one repository's failure neither hides nor re-keys
// another's, and a later success on one clears only that one. A FIRST failure is an INCIDENT ONLY (`fileReleaseIncidents`: an `incident` item in the tracker, no order); THE SECOND CONSECUTIVE FAILURE
// is also an order to `ceo`, keyed on the streak, so a third and a fourth failure are the same order and not a page each.

/** The key the incident item carries on its `Incident:` line, so `priority:emergency` can link it and the chairman's messaging finds it (`ORG_BLOCKING_INCIDENT_KEYS`, `readFixRow`). */
export const RELEASE_INCIDENT_KEY = `incident:${SIGNALS.RELEASE_FAILED}`;
/** How many failed releases in a row on one repository make the order to `ceo` (the chairman's "a second consecutive failure"). */
export const RELEASE_FAILURES_TO_WAKE = 2;
const LOG_STAMP = /^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const ANSI = /\u001b\[[0-9;]*m/g;
const STEP_GROUP = "##[group]";
const STEP_END = "##[endgroup]";
const STEP_ERROR = "##[error]";
/** What makes a line of a failing step an ERROR line: pnpm's `ERR_*` and npm's `ERR!`, the word `error`, and git's `fatal:`. */
const ERROR_LINE = /\bERR_|\berr(?:or)?\b|\bfatal\b/i;
const ERROR_LINE_CHARS = 240;

/** What a failed run's log says: the first error line of the step that failed, or why none is quoted (never an empty quote). */
export type FirstError = { line: string } | { unread: string };
/** One repository's release read: its runs (`null` is a refused list) and, while the newest verdict is a failure, the failed job's first error line. */
export type ReleaseFailureRead = { repo: string, runs: ReleaseRuns | null, firstError?: FirstError };

/**
 * THE FIRST ERROR LINE OF THE STEP THAT FAILED, from a job's log. GitHub marks the failure with a `##[error]` line (usually "Process completed with exit code 1", which says nothing), and the line
 * that names the cause is inside the same step, before it: the step is the span from the nearest `##[group]` above the marker, and its output starts after that group's `##[endgroup]` (the lines
 * between are the command echoed, which may say "error" without one). The first line of that output that reads as an error is quoted, else the marker's own text.
 */
export function firstErrorLine(log: string): FirstError {
  const lines = log.split(/\r?\n/).map((line) => line.replace(LOG_STAMP, "").replace(ANSI, ""));
  const marked = lines.findIndex((line) => line.startsWith(STEP_ERROR));
  if (marked === -1) return { unread: "the failed job's log holds no `##[error]` line" };
  let start = marked;
  while (start > 0 && !lines[start].startsWith(STEP_GROUP)) start -= 1;
  const ended = lines.slice(start, marked).findIndex((line) => line.startsWith(STEP_END));
  const output = lines.slice(ended === -1 ? start + 1 : start + ended + 1, marked);
  const found = output.find((line) => !line.startsWith("##[") && ERROR_LINE.test(line)) ?? lines[marked].slice(STEP_ERROR.length);
  const text = found.trim();
  if (text === "") return { unread: "the failed step's error line is empty" };
  return { line: text.length > ERROR_LINE_CHARS ? `${text.slice(0, ERROR_LINE_CHARS - 1)}…` : text };
}

function readFirstError(run: (args: string[]) => string, repo: string, job: FailedJob | undefined): FirstError {
  if (job?.id === undefined) return { unread: "the failed job's id was not read" };
  try {
    return firstErrorLine(jobLogOf(repo, job.id, run)); // the colour codes the log carries are stripped by `firstErrorLine`
  } catch {
    return { unread: "the failed job's log could not be read" };
  }
}

/**
 * THE FACT FOR `releaseFailureReadings`: each repository's `release.yml` runs, and, only for one whose newest verdict is a failure, the failed job's log (ONE MORE CALL beside the jobs and
 * `.changeset/` reads `readReleaseRuns` already makes). `known` is a repository's runs the tick already read (the project's, kept for the canary), so it is not asked twice. NEVER THROWS.
 */
export function readReleaseFailures(run: (args: string[]) => string, repos: readonly string[], { known = {} }: { known?: Record<string, ReleaseRuns | null | undefined> } = {}): ReleaseFailureRead[] {
  return repos.map((repo) => {
    const prior = known[repo];
    const runs = prior !== undefined ? prior : readReleaseRuns(run, repo);
    if (runs === null || newestReleaseVerdict(runs.runs)?.conclusion !== "failure") return { repo, runs };
    return { repo, runs, firstError: runs.jobs ? readFirstError(run, repo, runs.jobs[0]) : { unread: "the failed job could not be read" } };
  });
}

/**
 * THE FAILED RELEASES IN A ROW on one repository, newest first: the verdict runs back to the newest success. A cancelled, skipped, neutral or unfinished run neither joins the streak nor breaks it.
 * `ended` is whether a success closed it: false is a window with no success in it, so the streak is a floor.
 */
export function failureStreak(runs: ReleaseRun[]): { failures: ReleaseRun[]; ended: boolean } {
  const verdicts = runs.filter(isVerdict).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const failures = [];
  for (const verdict of verdicts) {
    if (verdict.conclusion !== "failure") return { failures, ended: true };
    failures.push(verdict);
  }
  return { failures, ended: false };
}

const firstErrorText = (error: FirstError | undefined): string => (error === undefined ? "its first error line was not read" : "line" in error ? `its first error line: "${error.line}"` : `its first error line is not quoted (${error.unread})`);

/**
 * SIGNAL 18 FOR EVERY REPOSITORY THE ORG RELEASES (agent-org#887): ONE READING PER REPOSITORY, tripped while that repository's newest release verdict is a failure. The discriminator names the repository
 * and the FIRST failed run of its streak, so it holds while the streak grows (one order, not a page per failure) and is a new key for the next streak. A first failure is `incidentOnly`; the
 * {@link RELEASE_FAILURES_TO_WAKE}th in a row is an order to `ceo`. A repository whose list was refused, or in which no run concluded, is UNKNOWN and never clear, and does not hide another's trip.
 */
export function releaseFailureReadings({ failures }: { failures: ReleaseFailureRead[] | null; }): Reading[] {
  const signal = SIGNALS.RELEASE_FAILED;
  if (failures === null) return [unknown(signal, "the repositories the org releases could not be listed, so no release is known to have succeeded")];
  const tripped: Reading[] = [];
  const unread: string[] = [];
  for (const { repo, runs, firstError } of failures) {
    if (runs === null) { unread.push(`${repo}: the runs of release.yml on main could not be read`); continue; }
    const verdict = newestReleaseVerdict(runs.runs);
    if (verdict === undefined) { unread.push(`${repo}: none of the newest ${runs.runs.length} release.yml run(s) on main concluded success or failure`); continue; }
    if (verdict.conclusion === "success") continue;
    const { failures: streak, ended } = failureStreak(runs.runs);
    const first = streak[streak.length - 1];
    const startedAt = Date.parse(first.updatedAt);
    const times = streak.length;
    const running = times >= RELEASE_FAILURES_TO_WAKE ? ` ${times}${ended ? "" : " or more"} times running (since run ${first.id})` : "";
    tripped.push({ signal, status: "tripped", firstTrippedAt: Number.isFinite(startedAt) ? startedAt : null, discriminator: `${signal}@${repo}@${first.id}`,
      ...(times < RELEASE_FAILURES_TO_WAKE && { incidentOnly: true as const }),
      detail: `release.yml on ${repo}'s main FAILED${running} and no later run succeeded: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(runs.jobs)}; ${firstErrorText(firstError)}; ${pendingText(runs.pending)}; ${verdict.url}` });
  }
  const gap = unread.length === 0 ? [] : [unknown(signal, `${unread.join("; ")}, so those repositories are not known to have released`)];
  if (tripped.length === 0 && gap.length === 0) return [{ ...clear(signal), detail: `${failures.map(({ repo }) => repo).join(", ")}: the newest release run of each succeeded` }];
  return [...tripped, ...gap];
}

/** The line of an incident item that names the failure it was raised for: `Release-failure: <repo>@<first failed run of the streak>`. */
const RELEASE_FAILURE_LINE = /^Release-failure:[ \t]*(\S+)@(\d+)[ \t]*$/m;
const releaseFailureOf = (body: string): { repo: string; episode: number } | null => {
  const found = RELEASE_FAILURE_LINE.exec(body);
  return found === null ? null : { repo: found[1], episode: Number(found[2]) };
};

/**
 * THE INCIDENT ITEM of one failed streak: its title names the repository and the first error line, and the body carries what the order's detail does, the `Incident:` key
 * ({@link RELEASE_INCIDENT_KEY}) and the `Release-failure:` line this file finds it again by.
 */
function releaseIncidentOf({ repo, runs, firstError }: ReleaseFailureRead & { runs: ReleaseRuns }): { title: string; body: string; episode: number } | null {
  const verdict = newestReleaseVerdict(runs.runs);
  if (verdict?.conclusion !== "failure") return null;
  const { failures: streak } = failureStreak(runs.runs);
  const episode = streak[streak.length - 1].id;
  const quoted = firstError !== undefined && "line" in firstError ? `: ${firstError.line.slice(0, 100)}` : "";
  return { episode, title: `Release failed on ${repo}${quoted}`,
    body: [`release.yml on ${repo}'s main FAILED: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(runs.jobs)}.`,
      `The run's ${firstErrorText(firstError)}.`, `Failed releases in a row: ${streak.length}. ${pendingText(runs.pending)}.`, verdict.url, "",
      `Incident: ${RELEASE_INCIDENT_KEY}`, `Release-failure: ${repo}@${episode}`, "",
      `Raised by the gate's \`${SIGNALS.RELEASE_FAILED}\` reading (agent-org#887). A second consecutive failure on ${repo} also wakes \`ceo\`. The gate closes this item when a later release.yml run on ${repo} succeeds.`].join("\n") };
}

/**
 * RAISE THE INCIDENT OF EACH FAILED RELEASE, ONCE, AND CLOSE IT WHEN THAT REPOSITORY RELEASES AGAIN. `tracker` is where incidents live (the project's tracker, as the canary's and the fleet's are). An item is
 * found by its `Release-failure:` line: an OPEN one for the repository (any streak: a streak that slid out of the run window must not be filed again) or a CLOSED one for the same streak (a person who
 * closed it did not ask for it again) means nothing is filed. A list that cannot be read files nothing and closes nothing: absence is not proof. Reads only when a repository's newest verdict is a failure
 * or a success, and NEVER THROWS.
 * @returns the titles filed and the numbers closed, for the caller's log
 */
export function fileReleaseIncidents(failures: ReleaseFailureRead[], { run, tracker, say = (line: string) => { process.stderr.write(line); } }:
  { run: (args: string[]) => string; tracker: string; say?: (line: string) => void; }): { filed: string[]; closed: number[] } {
  const out = { filed: [] as string[], closed: [] as number[] };
  try {
    const failed: { repo: string; episode: number; title: string; body: string }[] = [];
    for (const f of failures) {
      const incident = f.runs === null ? null : releaseIncidentOf({ ...f, runs: f.runs });
      if (incident !== null) failed.push({ repo: f.repo, ...incident });
    }
    const released = new Set(failures.flatMap(({ repo, runs }) => (runs !== null && newestReleaseVerdict(runs.runs)?.conclusion === "success" ? [repo] : [])));
    if (failed.length === 0 && released.size === 0) return out;
    const open = openIncidentsOf(tracker, run);
    if (open === null) {
      say(`org-health: ${SIGNALS.RELEASE_FAILED} could not read the open incidents of ${tracker}, so none is filed or closed this tick.\n`);
      return out;
    }
    const openFor = (repo: string) => open.some((item) => releaseFailureOf(item.body)?.repo === repo);
    for (const item of open) {
      const named = releaseFailureOf(item.body);
      if (named === null || !released.has(named.repo)) continue;
      closeIncident(tracker, item.number, `release.yml on ${named.repo}'s main succeeded again, so the failure this was raised for is over.`, run);
      out.closed.push(item.number);
    }
    for (const { repo, episode, title, body } of failed) {
      if (openFor(repo)) continue;
      const closed = closedIncidentsOf(tracker, run);
      if (closed === null) {
        say(`org-health: ${SIGNALS.RELEASE_FAILED} could not read the closed incidents of ${tracker}, so the incident of ${repo} is not filed this tick.\n`);
        continue;
      }
      if (closed.some((item) => { const named = releaseFailureOf(String(item?.body ?? "")); return named?.repo === repo && named.episode === episode; })) continue;
      createIncident(tracker, { title, body }, run);
      out.filed.push(title);
    }
  } catch (err) {
    say(`org-health: ${SIGNALS.RELEASE_FAILED} could not file its incident (${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}).\n`);
  }
  return out;
}
