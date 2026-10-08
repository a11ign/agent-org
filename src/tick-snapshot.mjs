// @ts-check
// THE TICK'S SNAPSHOT (#4148): ONE cheap question per repository per tick -- "did anything change?" -- asked of REST with an ETag, where an unchanged answer is a
// 304 that costs NO point, instead of every reader of the tick asking GitHub's GraphQL for the same pull requests and rows again.
//
// THE READS THEMSELVES ARE ANSWERED BY `host/gh`, not here: every reader (the gate, its batch worker, `wake.mjs`, `row-claim`, a session) reaches GitHub through that
// wrapper, so a cache there reaches all of them and no reader had to learn it. What this file does is the one thing the wrapper cannot do in shell: decide, per
// repository, whether the entries stored under it are still true. It keeps a GENERATION per repository (`<counter> <verified-at>` in
// `$GH_CONFIG_DIR/read-cache/gen/<repository>`): the counter moves when a probe says the repository changed, `verified-at` moves every time the probes ran and
// found none. A process the tick started (`A11Y_TICK_SNAPSHOT` set) is served an entry stored under the current counter, never past `A11Y_TICK_SNAPSHOT_MAX_AGE`
// of the last verification; a session is never served one (the wrapper's header says why).
//
// WHAT A PROBE CAN SEE, and so what a snapshot can miss. Two endpoints per repository:
//   - `issues?state=all&sort=updated&direction=desc&per_page=5`: a pull request IS an issue to this endpoint, and every comment, label, edit, close, reopen, review
//     and push moves one to the top with a new `updated_at`, so the first page's bytes (and its ETag) change. `state=all` and not `open`, because a CLOSE must be seen
//     and a closed item leaves an open list without changing it.
//   - `actions/runs?per_page=10`: a workflow run starting, finishing or being re-run, which does NOT touch the pull request's `updated_at` and is what `statusCheckRollup` is made of.
// WHAT THEY CANNOT SEE: a check or status posted by something that is not Actions, and a change to a repository setting. Both are bounded by `MAX_UNCHANGED_SECONDS`: a repository
// is re-read at least that often whatever the probes say, and by the wrapper's own 150 s. An unreadable probe (anything but 200/304/404) counts as a CHANGE: fail towards reading.
//
// THE ETAG IS SENT WITHOUT ITS `W/` PREFIX. Measured 2026-10-08 with `gh` 2.100: `If-None-Match: W/"x"` came back 200 and cost a point, the same tag unprefixed came back 304.
// `gh api` exits 1 on a 304 (it says `gh: HTTP 304`), so the status is read off the `-i` header block, never off the exit code.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A repository is re-read at least this often even when every probe says unchanged: what a probe cannot see (a non-Actions status) is bounded by it. */
export const MAX_UNCHANGED_SECONDS = 300;
const HTTP_NOT_MODIFIED = 304;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const PROBE_TIMEOUT_MS = 15_000;
const MS = 1000;
/** What is held for a probe whose endpoint does not exist for this repository (no Actions, issues off): no tag to send, and no change to report. */
const ABSENT = "absent";

/** @param {string} repo @returns {string[]} the REST paths whose ETags say a repository's pull requests, rows and runs have not moved */
export const probePaths = (repo) => [
  `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=5`,
  `repos/${repo}/actions/runs?per_page=10`,
];

/** The name `host/gh` files a repository's entries under: `a11ign/agent-org` -> `a11ign_agent-org`; the empty slug is `default` (a call that names no repository). */
export const slugOf = (/** @type {string} */ repo) => (repo === "" ? "default" : repo.replace(/[^A-Za-z0-9._-]/g, "_"));

/**
 * @typedef {{ status: number | null, etag: string | null }} Answer what one probe said: the HTTP status (`null` when `gh` printed none) and the tag, `W/` removed
 * @typedef {(args: string[]) => { stdout: string, status: number | null }} GhRun
 */

/** @param {string} stdout @returns {Answer} the `-i` header block of a `gh api` answer */
export function parseAnswer(stdout) {
  const status = stdout.match(/^HTTP\/[\d.]+ (\d{3})/m);
  const etag = stdout.match(/^etag: *(?:W\/)?("[^"\r\n]*")/im);
  return { status: status === null ? null : Number(status[1]), etag: etag === null ? null : etag[1] };
}

/** @type {GhRun} */
const ghRun = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", status: r.status };
};

/**
 * One probe: conditional if a tag is held. `changed` is true for a 200 whose tag is not the one held, or for an answer that is none of 200, 304, 404 and 410; a 404 or 410 is a repository
 * with no Actions (or no issues) and is a steady state, not a change. A 200 with the SAME tag is not a change either (a CDN may ignore the condition).
 * @param {{ path: string, held: string | undefined, run: GhRun }} probe
 * @returns {{ changed: boolean, etag: string | undefined, why: string }}
 */
export function probeOnce({ path, held, run }) {
  const conditional = held === undefined || held === ABSENT ? [] : ["-H", `If-None-Match: ${held}`];
  const { stdout } = run(["api", "-i", ...conditional, path]);
  const answer = parseAnswer(stdout);
  if (answer.status === HTTP_NOT_MODIFIED) return { changed: false, etag: held, why: "304" };
  if (answer.status === HTTP_NOT_FOUND || answer.status === HTTP_GONE) return { changed: false, etag: ABSENT, why: String(answer.status) };
  if (answer.status === HTTP_OK && answer.etag !== null) return { changed: answer.etag !== held, etag: answer.etag, why: answer.etag === held ? "200 same tag" : "200 new tag" };
  return { changed: true, etag: held, why: `unreadable (${answer.status ?? "no status"})` };
}

/** @typedef {{ tags: Record<string, string>, bumpedAt: number }} Held what is kept per repository: the tag each probe path last returned, and when its generation last moved */

/** @param {string} path @returns {Record<string, Held>} */
function readTags(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {}; // no tags held yet (the first tick, or a file a crash left half written): every probe is then unconditional, which reads, and reads are the safe side
  }
}

/** @param {string} path @returns {{ counter: number, verified: number } | null} */
function readGeneration(path) {
  try {
    const [counter, verified] = readFileSync(path, "utf8").trim().split(" ").map(Number);
    return Number.isFinite(counter) && Number.isFinite(verified) ? { counter, verified } : null;
  } catch {
    return null; // none yet: the first refresh starts one at 1
  }
}

/** Write through a rename, so a reader in the wrapper never reads half of it. @param {string} path @param {string} text */
function writeWhole(path, text) {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Probe each repository once and move its generation. Returns one line per repository for the tick's log.
 * @param {{ repos: string[], homeRepo: string, configDir: string, run?: GhRun, nowMs?: number }} input
 * `homeRepo` is the repository a call that names none is about, so its generation is ALSO written under `default`.
 */
export function refreshTickSnapshot({ repos, homeRepo, configDir, run = ghRun, nowMs = Date.now() }) {
  const root = join(configDir, "read-cache");
  mkdirSync(join(root, "gen"), { recursive: true });
  const tagsPath = join(root, "etags.json");
  const tags = readTags(tagsPath);
  const nowS = Math.floor(nowMs / MS);
  const lines = [];
  for (const repo of repos) {
    const held = tags[repo] ?? { tags: {}, bumpedAt: 0 };
    const probes = probePaths(repo).map((path) => ({ path, ...probeOnce({ path, held: held.tags[path], run }) }));
    const before = readGeneration(join(root, "gen", slugOf(repo)));
    const changed = probes.some((p) => p.changed);
    const due = before === null || nowS - held.bumpedAt >= MAX_UNCHANGED_SECONDS;
    const counter = changed || due ? (before?.counter ?? 0) + 1 : (before?.counter ?? 1);
    tags[repo] = { tags: Object.fromEntries(probes.flatMap((p) => (p.etag === undefined ? [] : [[p.path, p.etag]]))), bumpedAt: changed || due ? nowS : held.bumpedAt };
    for (const slug of repo === homeRepo ? [slugOf(repo), slugOf("")] : [slugOf(repo)]) writeWhole(join(root, "gen", slug), `${counter} ${nowS}\n`);
    lines.push(`${repo}: ${changed || due ? "CHANGED" : "unchanged"} (${probes.map((p) => p.why).join(", ")}${due && !changed ? "; re-read due" : ""}) generation ${counter}`);
  }
  writeWhole(tagsPath, JSON.stringify(tags));
  return lines;
}
