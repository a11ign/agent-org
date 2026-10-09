// @ts-check
// module: the release-behind-main facts and verdicts -- a repository whose `main` holds shipped-path commits that no release carries (#4128, class fix for a11ign/a11ign#4084)
//
// THE CLASS: a pull request changes a package's shipped code, carries no changeset, and merges; nothing then releases it (screenreader-worker#25 and #26).
// Row 1's gate (`changeset-required` in a11ign/toolchain) stops that at the pull request. This is the reading for what gate cannot see: a repository that has not
// adopted it, a wrong `no-release:` line, a release that fails after the merge. It looks at `main` against the LATEST RELEASE, so it sees a release that never started,
// beside `release-run-failed` (#4001), which sees one that ran and failed. `org-health.mjs` turns the verdicts into the `release-behind-main` signal.
//
// A LEAF: it imports no org-health or work-gate name (the signal's name and the order text live there), so both can import it.
//
// THE PREDICATE IS COPIED, NOT SHARED, AND THE COPY IS PINNED BY ITS CASES. "Does this path count" and "what is a no-release line" are `TEST_FILE`, the releasable-path prefix
// test, `NO_RELEASE_LINE` and `PLACEHOLDER` of a11ign/toolchain's `scripts/changeset-required.mjs` (row 1, a11ign/a11ign#4127): the gate decides on a pull request's diff and this
// decides on a commit's, from the same four rules, so a reading that disagreed with the gate would trip on what the gate allows. A change to one must reach the other: the
// test file of this module holds the gate's own cases (`release-behind-main.test.ts`, "the predicate agrees with the gate's"), and a toolchain-side change that moves one of the
// four is a change to that table here.
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The age of the oldest unreleased commit past which the repository is behind. `ceo`'s figure (#4128); it would not have tripped on the 2 h gap of 2026-10-08, and says so on the row. */
export const BEHIND_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long one read of every repository is reused. The tick is every two minutes; eight repositories at several calls each, every tick, is the pool the org lives on. */
export const READ_INTERVAL_MS = 60 * 60 * 1000;
export const CACHE_FILE = "release-behind-main.json";

const COMMIT_PAGE = 100;
const MAX_PAGES = 3;
/** The commits of one repository whose files and pull request are read, OLDEST FIRST: the oldest decides, and the cost of a repository with a long unreleased tail is bounded. */
const MAX_EXAMINED = 20;
/** `GET /commits/{sha}` lists at most this many files; a commit that lists this many may have been cut, and a cut list cannot show that nothing shipped changed. */
const FILE_LIST_LIMIT = 300;
const RELEASES_WINDOW = 10;
const REGISTRY_TIMEOUT_SECONDS = 90;
const HTTP_OK = "200";
const HTTP_NOT_FOUND = "404";
const MAX_REASON_CHARS = 160;
const SHOWN = 3;
const SHORT_SHA = 9;

const TEST_FILE = /\.(test|spec)\.[^/]*$/;
const CHANGESET_DIR = ".changeset/";
const NO_RELEASE_LINE = /^[ \t]*no-release:[ \t]*(.*?)[ \t]*$/;
const PLACEHOLDER = "<reason>";

/** `isNameReservation` of `dora.mjs`, restated because that module runs its readers at import: a `0.0.0-` version is a name held on the registry and is no release. */
const isNameReservation = (version: string) => version.startsWith("0.0.0-");

/** the latest release; `at` is epoch ms of its publish or release time */
export type Release = { name: string, version: string, at: number };
/**
 * a commit made after the release; `touches` is a non-test file under a releasable path; `declared` is the reason of a `no-release:` line in its pull request's body
 */
export type Commit = { sha: string, at: number, pr: number | null, touches: boolean, declared: string | null };
/** `release: null` is a repository that has never released, which is a reading and not a gap */
export type RepoFact = { repo: string, release: Release | null, commits: Commit[], unexamined: number, truncated: boolean } | { repo: string, unreadable: string };
export type Verdict = { repo: string, verdict: "tripped" | "clear" | "unknown", detail: string, discriminator?: string, firstTrippedAt?: number };
/** a `dora` entry of `.agent-org/project.json` */
export type Repository = { repo: string, release: { kind: "npm", package: string } | { kind: "tag" }, releasablePaths: string[] };

/** @param {string} path @param {string[]} releasablePaths @returns {boolean} the file counts: under a releasable path, not a test file, not a changeset */
export function isShipped(path: string, releasablePaths: string[]): boolean {
  return !TEST_FILE.test(path) && !path.startsWith(CHANGESET_DIR) && releasablePaths.some((entry) => path.startsWith(entry));
}

/** @param {string} body @returns {string | null} the reason of the first `no-release:` line that has one, else null */
export function noReleaseReason(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const reason = NO_RELEASE_LINE.exec(line)?.[1];
    if (reason && reason !== PLACEHOLDER) return reason;
  }
  return null;
}

// --- the verdicts: a function of the facts and `now` ------------------------------------------------------------------------------

/** @param {number} at @returns {string} */
const iso = (at: number): string => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

/** @param {number} ms @returns {number} whole tenths of a day */
const daysOld = (ms: number): number => Math.floor((ms / BEHIND_AFTER_MS) * 10) / 10;

/** @param {Release | null} release @returns {string} */
const releaseText = (release: Release | null): string => (release === null ? "never released" : `${release.name}@${release.version} (${iso(release.at)})`);

/** @param {Commit} commit @returns {string} */
const commitText = (commit: Commit): string => `${commit.sha.slice(0, SHORT_SHA)} (${iso(commit.at)}${commit.pr === null ? ", no pull request found" : `, #${commit.pr}`})`;

/** @param {Commit[]} declared @returns {string} */
const declaredText = (declared: Commit[]): string => (declared.length === 0 ? ""
  : `; ${declared.length} more DECLARED no-release and read as not behind: ${declared.slice(0, SHOWN).map((c) => `${c.sha.slice(0, SHORT_SHA)} ("${c.declared}")`).join(", ")}${declared.length > SHOWN ? ", ..." : ""}`);

/** @param {Extract<RepoFact, { release: unknown }>} fact @returns {string} what was not looked at, if anything, so a clear is never read as more than it is */
const limitsText = (fact: Extract<RepoFact, { release: unknown; }>): string => [
  fact.unexamined > 0 ? `${fact.unexamined} newer commit(s) not examined` : "",
  fact.truncated ? `only the newest ${COMMIT_PAGE * MAX_PAGES} commits per path were listed` : "",
].filter(Boolean).join("; ");

/**
 * ONE REPOSITORY'S VERDICT. A commit COUNTS when it touches a shipped file, and is DECLARED when its pull request says `no-release: <reason>`: a declared commit is named in the detail and
 * never trips, or a refactor allowed on purpose would trip for ever on an idle repository. The repository is BEHIND when the oldest commit that counts and is not declared is older than
 * `BEHIND_AFTER_MS`. `firstTrippedAt` is that commit's time plus the window, and the discriminator names it, so a LATER commit does not re-raise the signal.
 * A list cut short with nothing yet found cannot say clear: the commits not examined are NEWER than the ones that were, so they cannot make the oldest older, but nothing was found
 * either way for them, and "clear" is read as "nothing unreleased is old", which is not known.
 * @param {RepoFact} fact @param {number} now @returns {Verdict}
 */
export function repoVerdict(fact: RepoFact, now: number): Verdict {
  const { repo } = fact;
  if ("unreadable" in fact) return { repo, verdict: "unknown", detail: `${repo}: ${fact.unreadable}` };
  const counting = fact.commits.filter((c) => c.touches);
  const declared = counting.filter((c) => c.declared !== null);
  const behind = counting.filter((c) => c.declared === null);
  const limits = limitsText(fact);
  if (behind.length === 0) {
    const note = `${repo}: nothing unreleased counts since ${releaseText(fact.release)}${declaredText(declared)}${limits ? ` (${limits})` : ""}`;
    return { repo, verdict: fact.unexamined > 0 ? "unknown" : "clear", detail: fact.unexamined > 0 ? `${note}; the rest are unread` : note };
  }
  const [oldest, ...more] = behind;
  if (now - oldest.at <= BEHIND_AFTER_MS) return { repo, verdict: "clear", detail: `${repo}: the oldest unreleased commit ${commitText(oldest)} is under 24 h old` };
  return { repo, verdict: "tripped", firstTrippedAt: oldest.at + BEHIND_AFTER_MS, discriminator: `${repo}@${oldest.sha}`,
    detail: `${repo} is BEHIND ITS OWN main: latest release ${releaseText(fact.release)}; oldest unreleased commit on a releasable path ${commitText(oldest)}, `
      + `${daysOld(now - oldest.at)} days old; ${more.length} more unreleased${more.length > 0 ? ` (${more.slice(0, SHOWN).map((c) => c.sha.slice(0, SHORT_SHA)).join(", ")}${more.length > SHOWN ? ", ..." : ""})` : ""}${declaredText(declared)}${limits ? ` (${limits})` : ""}` };
}

// --- the fact reader: gh and the registry are handed in ----------------------------------------------------------------------------

/** @param {unknown} err @returns {string} */
const firstLine = (err: unknown): string => String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS);

export type Gh = (args: string[]) => string;
export type Registry = (npmPackage: string) => { status: string, body: string };

/** @param {string} text @param {string} what @returns {any[]} */
function jsonList(text: string, what: string): any[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${what} did not answer a list`);
  return parsed;
}

/**
 * THE NEWEST NON-RESERVATION VERSION BY PUBLISH TIME. A 404 is a package never published and is a reading (`null`); any other status is a refusal and throws.
 * @param {Registry} registry @param {string} npmPackage @returns {Release | null}
 */
function npmRelease(registry: Registry, npmPackage: string): Release | null {
  const { status, body } = registry(npmPackage);
  if (status === HTTP_NOT_FOUND) return null;
  if (status !== HTTP_OK) throw new Error(`the registry answered HTTP ${status} for ${npmPackage}`);
  const times = Object.entries(JSON.parse(body).time ?? {}).filter(([version]) => version !== "created" && version !== "modified" && !isNameReservation(version))
    .map(([version, at]) => ({ version, at: Date.parse(String(at)) }));
  if (times.some((t) => !Number.isFinite(t.at))) throw new Error(`${npmPackage}: a version has no parseable publish time`);
  const newest = times.sort((a, b) => b.at - a.at)[0];
  return newest === undefined ? null : { name: npmPackage, version: newest.version, at: newest.at };
}

/**
 * THE LATEST GITHUB RELEASE that is not a draft, by its published time. An empty list is a repository that never released.
 * @param {Gh} gh @param {string} repo @returns {Release | null}
 */
function tagRelease(gh: Gh, repo: string): Release | null {
  const rows = jsonList(gh(["api", "--method", "GET", `repos/${repo}/releases`, "-f", `per_page=${RELEASES_WINDOW}`,
    "--jq", "[.[] | select(.draft | not) | {tag: .tag_name, at: .published_at}]"]), `${repo} releases`);
  const dated = rows.map((r) => ({ version: String(r.tag), at: Date.parse(r.at) }));
  if (dated.some((r) => !Number.isFinite(r.at))) throw new Error(`${repo}: a release has no parseable published time`);
  const newest = dated.sort((a, b) => b.at - a.at)[0];
  return newest === undefined ? null : { name: repo, version: newest.version, at: newest.at };
}

/**
 * ONE PATH'S COMMITS ON `main` made since the release, newest first, up to `MAX_PAGES` pages. A merge commit is left out: its own commits are listed and carry the pull request.
 * @param {Gh} gh @param {string} repo @param {string} path @param {number | null} since
 * @returns {{ commits: { sha: string, at: number }[], truncated: boolean }}
 */
function pathCommits(gh: Gh, repo: string, path: string, since: number | null): { commits: { sha: string; at: number; }[]; truncated: boolean; } {
  const commits: { sha: string; at: number; }[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = jsonList(gh(["api", "--method", "GET", `repos/${repo}/commits`, "-f", "sha=main", "-f", `path=${path}`, "-f", `per_page=${COMMIT_PAGE}`, "-f", `page=${page}`,
      ...(since === null ? [] : ["-f", `since=${iso(since)}`]),
      "--jq", "[.[] | {sha, at: .commit.committer.date, parents: (.parents | length)}]"]), `${repo} commits under ${path}`);
    if (rows.some((r) => !Number.isFinite(Date.parse(r.at)))) throw new Error(`${repo}: a commit under ${path} has no parseable time`);
    commits.push(...rows.filter((r) => r.parents <= 1).map((r) => ({ sha: String(r.sha), at: Date.parse(r.at) })));
    if (rows.length < COMMIT_PAGE) return { commits, truncated: false };
  }
  return { commits, truncated: true };
}

/** @param {Gh} gh @param {string} repo @param {string} sha @param {string[]} releasablePaths @returns {boolean} the commit touches a shipped file, a cut file list counting as yes */
function touchesShipped(gh: Gh, repo: string, sha: string, releasablePaths: string[]): boolean {
  const files = jsonList(gh(["api", `repos/${repo}/commits/${sha}`, "--jq", "[.files[] | {filename, previous_filename}]"]), `${repo} commit ${sha}`);
  if (files.length >= FILE_LIST_LIMIT) return true;
  return files.some((f) => [f.filename, f.previous_filename].some((p) => typeof p === "string" && isShipped(p, releasablePaths)));
}

/** @param {Gh} gh @param {string} repo @param {string} sha @returns {{ pr: number | null, declared: string | null }} the pull request(s) the commit came in by, and the first `no-release:` reason among them */
function pullOf(gh: Gh, repo: string, sha: string): { pr: number | null; declared: string | null; } {
  const pulls = jsonList(gh(["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", "[.[] | {number, body}]"]), `${repo} pulls of ${sha}`);
  const declared = pulls.map((p) => noReleaseReason(String(p.body ?? ""))).find((reason) => reason !== null) ?? null;
  return { pr: pulls[0]?.number ?? null, declared };
}

/** @param {Gh} gh @param {Repository} repository @param {Release | null} release @returns {Extract<RepoFact, { release: unknown }>} */
function readCommits(gh: Gh, repository: Repository, release: Release | null): Extract<RepoFact, { release: unknown; }> {
  const since = release === null ? null : release.at;
  const listed = repository.releasablePaths.map((path) => pathCommits(gh, repository.repo, path, since));
  const bySha = new Map(listed.flatMap((l) => l.commits).filter((c) => since === null || c.at > since).map((c) => [c.sha, c]));
  const oldestFirst = [...bySha.values()].sort((a, b) => a.at - b.at);
  const commits = oldestFirst.slice(0, MAX_EXAMINED).map((c) => {
    const touches = touchesShipped(gh, repository.repo, c.sha, repository.releasablePaths);
    return { sha: c.sha, at: c.at, touches, ...(touches ? pullOf(gh, repository.repo, c.sha) : { pr: null, declared: null }) };
  });
  return { repo: repository.repo, release, commits, unexamined: oldestFirst.length - commits.length, truncated: listed.some((l) => l.truncated) };
}

/**
 * ONE REPOSITORY, NEVER THROWING: a refused or unparseable read is `{ unreadable }`, a stated gap and never "nothing unreleased" (absence is not zero), and it does not stop the others.
 * @param {{ gh: Gh, registry: Registry }} io @param {Repository} repository @returns {RepoFact}
 */
export function readRepoFact({ gh, registry }: { gh: Gh; registry: Registry; }, repository: Repository): RepoFact {
  try {
    const release = repository.release.kind === "npm" ? npmRelease(registry, repository.release.package) : tagRelease(gh, repository.repo);
    return readCommits(gh, repository, release);
  } catch (err) {
    return { repo: repository.repo, unreadable: `could not be read (${firstLine(err)})` };
  }
}

/** @param {{ gh: Gh, registry: Registry, repositories: Repository[] }} input @returns {RepoFact[]} every declared repository, each read on its own */
export function readReleaseBehind({ gh, registry, repositories }: { gh: Gh; registry: Registry; repositories: Repository[]; }): RepoFact[] {
  return repositories.map((repository) => readRepoFact({ gh, registry }, repository));
}

/** @type {Registry} the npm registry's document for a package, with the HTTP status after it (no `-f`: it would make a 404 and a failed read the same exit status) */
export function npmRegistryRead(npmPackage: string) {
  const url = `https://registry.npmjs.org/${npmPackage.replace("/", "%2f")}`;
  const answer = execFileSync("curl", ["-sS", "--max-time", String(REGISTRY_TIMEOUT_SECONDS), "-H", "Accept: application/json", "-w", "\n%{http_code}", url],
    { encoding: "utf8", maxBuffer: 1 << 28 });
  const split = answer.lastIndexOf("\n");
  return { status: answer.slice(split + 1), body: answer.slice(0, split) };
}

// --- the hourly cache -------------------------------------------------------------------------------------------------------------

/** @template T @param {() => T} read @returns {T | null} `null` for a file that cannot be read or parsed: a cache miss, never an error */
function attempt<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}

/**
 * THE FACTS, READ AT MOST ONCE AN HOUR. The verdicts are a function of the facts and `now`, so a tick between reads re-judges the kept facts against the clock and the 24 h line is
 * crossed on the tick it is crossed, not on the next read. Written to a sibling and renamed, so a tick killed mid-write leaves the facts it had. A cache that cannot be written is a
 * miss and the next tick reads again; a `readAt` in the FUTURE is a miss too, or a clock set back would keep a stale read for ever.
 * @param {{ stateDir: string, now: number, read: () => RepoFact[] }} input @returns {RepoFact[]}
 */
export function cachedReleaseBehind({ stateDir, now, read }: { stateDir: string; now: number; read: () => RepoFact[]; }): RepoFact[] {
  const path = join(stateDir, CACHE_FILE);
  const kept = attempt(() => JSON.parse(readFileSync(path, "utf8")));
  if (Array.isArray(kept?.facts) && Number.isFinite(kept.readAt) && kept.readAt <= now && now - kept.readAt < READ_INTERVAL_MS) return kept.facts;
  const facts = read();
  attempt(() => {
    writeFileSync(`${path}.tmp`, JSON.stringify({ readAt: now, facts }));
    renameSync(`${path}.tmp`, path);
  });
  return facts;
}
