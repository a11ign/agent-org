// @ts-check
// THE TICK'S SNAPSHOT (#4148): ONE cheap question per repository per tick -- "did anything change?" -- asked of REST with an ETag, where an unchanged answer is a
// 304 that costs NO point, instead of every reader of the tick asking GitHub's GraphQL for the same pull requests and rows again.
//
// THE READS THEMSELVES ARE ANSWERED BY `plugins/github/wrapper/gh`, not here: every reader (the gate, its batch worker, `wake.ts`, `row-claim`, a session) reaches GitHub through that
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
//
// IN `webhook` MODE (agent-org#981, a11ign/a11ign#5043) THE ANSWER COMES FROM THE EVENT QUEUE, NOT FROM A PROBE: `refreshTickSnapshot` is handed `events`, and while the receiver is `healthy` a
// repository named by an event bumps its generation and every other keeps its counter, with NO `gh` call at all. Not `healthy`, it runs the probes above exactly as before: a dead receiver
// costs the old polling, never a silent org. Without `events` nothing here changes.
// A repository DUE for its reconcile in that mode is probed once (agent-org#982): a probe that moved with no event behind it is DRIFT and is filed once (`event-drift.ts` says what it can and cannot mean).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countSuppressed, driftOf, fileDrift, type Facts, type FileDrift, noContentChange, suppressedPath } from "./event-drift.ts";

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
export const probePaths = (repo: string): string[] => [
  `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=5`,
  `repos/${repo}/actions/runs?per_page=10`,
];

/** The name `plugins/github/wrapper/gh` files a repository's entries under: `a11ign/agent-org` -> `a11ign_agent-org`; the empty slug is `default` (a call that names no repository). */
export const slugOf = (repo: string) => (repo === "" ? "default" : repo.replace(/[^A-Za-z0-9._-]/g, "_"));

/** what one probe said: the HTTP status (`null` when `gh` printed none) and the tag, `W/` removed */
export type Answer = { status: number | null, etag: string | null };
export type GhRun = (args: string[]) => { stdout: string, status: number | null };

/** @param {string} stdout @returns {Answer} the `-i` header block of a `gh api` answer */
export function parseAnswer(stdout: string): Answer {
  const status = stdout.match(/^HTTP\/[\d.]+ (\d{3})/m);
  const etag = stdout.match(/^etag: *(?:W\/)?("[^"\r\n]*")/im);
  return { status: status === null ? null : Number(status[1]), etag: etag === null ? null : etag[1] };
}

const ghRun: GhRun = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", status: r.status };
};

/** A `GhRun` as the `Run` `recordIncident` takes: the output, and a throw on a refusal (it catches that and the caller retries). */
const asRun = (run: GhRun) => (args: string[]): string => {
  const { stdout, status } = run(args);
  if (status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${status ?? "without a status"}`);
  return stdout;
};

/**
 * What a 200 body says besides its tag (agent-org#1207): the newest `updated_at` of the items it lists and how many there are. The body is the array of issues, or the
 * `workflow_runs` of an Actions answer. `undefined` when the body is neither, or an item has no readable `updated_at`: nothing is then confirmed, and so nothing is drift.
 * @param {string} stdout @returns {Facts | undefined}
 */
export function factsOf(stdout: string): Facts | undefined {
  const split = stdout.match(/\r?\n\r?\n/);
  if (split === null || split.index === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(split.index + split[0].length));
  } catch {
    return undefined;
  }
  const items: unknown = Array.isArray(parsed) ? parsed : (parsed as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(items)) return undefined;
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const item of items) {
    const at: unknown = (item as { updated_at?: unknown } | null)?.updated_at;
    const ms = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(ms)) return undefined;
    if (ms > newestMs) {
      newestMs = ms;
      newest = at as string;
    }
  }
  return { newest, count: items.length };
}

/**
 * One probe: conditional if a tag is held. `changed` is true for a 200 whose tag is not the one held, or for an answer that is none of 200, 304, 404 and 410; a 404 or 410 is a repository
 * with no Actions (or no issues) and is a steady state, not a change. A 200 with the SAME tag is not a change either (a CDN may ignore the condition). A 200 also says what it read (`facts`).
 * @param {{ path: string, held: string | undefined, run: GhRun }} probe
 * @returns {{ changed: boolean, etag: string | undefined, why: string, facts?: Facts }}
 */
export function probeOnce({ path, held, run }: { path: string; held: string | undefined; run: GhRun; }): { changed: boolean; etag: string | undefined; why: string; facts?: Facts; } {
  const conditional = held === undefined || held === ABSENT ? [] : ["-H", `If-None-Match: ${held}`];
  const { stdout } = run(["api", "-i", ...conditional, path]);
  const answer = parseAnswer(stdout);
  if (answer.status === HTTP_NOT_MODIFIED) return { changed: false, etag: held, why: "304" };
  if (answer.status === HTTP_NOT_FOUND || answer.status === HTTP_GONE) return { changed: false, etag: ABSENT, why: String(answer.status) };
  if (answer.status === HTTP_OK && answer.etag !== null) return { changed: answer.etag !== held, etag: answer.etag, why: answer.etag === held ? "200 same tag" : "200 new tag", facts: factsOf(stdout) };
  return { changed: true, etag: held, why: `unreadable (${answer.status ?? "no status"})` };
}

/**
 * What the event queue told this tick (agent-org#981). `changed` is the repositories the consumed events named; `healthy` is the caller's verdict that the receiver is alive (the
 * heartbeat is younger than its limit), so the probes may be skipped; `reconcileEverySeconds` replaces `MAX_UNCHANGED_SECONDS` while it is.
 */
export type TickEvents = { changed: ReadonlySet<string>, healthy: boolean, reconcileEverySeconds: number };

/**
 * what is kept per repository: the tag each probe path last returned, and when its generation last moved. `facts` is the content each tag was read with (agent-org#1207), by
 * probe path; a tag held without it (a file written before this check) is a baseline, not a drift. `factsReadAt` is when that content was read (agent-org#1431): the window
 * a drift is judged over starts there, because an event moves `bumpedAt` past it without re-reading anything.
 */
export type Held = { tags: Record<string, string>, bumpedAt: number, facts?: Record<string, Facts>, factsReadAt?: number };

/** @param {string} path @returns {Record<string, Held>} */
function readTags(path: string): Record<string, Held> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {}; // no tags held yet (the first tick, or a file a crash left half written): every probe is then unconditional, which reads, and reads are the safe side
  }
}

/** @param {string} path @returns {{ counter: number, verified: number } | null} */
function readGeneration(path: string): { counter: number; verified: number; } | null {
  try {
    const [counter, verified] = readFileSync(path, "utf8").trim().split(" ").map(Number);
    return Number.isFinite(counter) && Number.isFinite(verified) ? { counter, verified } : null;
  } catch {
    return null; // none yet: the first refresh starts one at 1
  }
}

/** Write through a rename, so a reader in the wrapper never reads half of it. @param {string} path @param {string} text */
function writeWhole(path: string, text: string) {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Probe each repository once and move its generation. Returns one line per repository for the tick's log.
 * @param {{ repos: string[], homeRepo: string, configDir: string, run?: GhRun, nowMs?: number, events?: TickEvents }} input
 * `homeRepo` is the repository a call that names none is about, so its generation is ALSO written under `default`.
 * `events` absent is the poll path, unchanged. With `events.healthy` no probe runs: a repository in `events.changed` (compared without case, as GitHub spells `full_name` its own way)
 * is bumped, one that is not keeps its counter, and its `verified-at` still moves, because a live receiver is what vouches for it. Not healthy, the probes run as they always did.
 */
export function refreshTickSnapshot({ repos, homeRepo, configDir, run = ghRun, nowMs = Date.now(), events, fileDrift: file = (drift) => fileDrift(drift, { run: asRun(run) }) }: { repos: string[]; homeRepo: string; configDir: string; run?: GhRun; nowMs?: number; events?: TickEvents; fileDrift?: FileDrift; }) {
  const viaEvents = events !== undefined && events.healthy;
  if (viaEvents && !(Number.isFinite(events.reconcileEverySeconds) && events.reconcileEverySeconds > 0)) {
    throw new Error(`reconcileEverySeconds must be a positive number of seconds, not ${events.reconcileEverySeconds}: a repository would never be re-read`);
  }
  const named = new Set([...(events?.changed ?? [])].map((repo) => repo.toLowerCase()));
  const reconcileSeconds = viaEvents ? events.reconcileEverySeconds : MAX_UNCHANGED_SECONDS;
  const root = join(configDir, "read-cache");
  mkdirSync(join(root, "gen"), { recursive: true });
  const tagsPath = join(root, "etags.json");
  const tags = readTags(tagsPath);
  const nowS = Math.floor(nowMs / MS);
  // Phase 1: read every repository. Nothing is filed or written yet, so the drifts of the pass can be filed together (agent-org#1207).
  const reads = repos.map((repo) => {
    const held = tags[repo] ?? { tags: {}, bumpedAt: 0 };
    const before = readGeneration(join(root, "gen", slugOf(repo)));
    const due = before === null || nowS - held.bumpedAt >= reconcileSeconds;
    const eventNamed = named.has(repo.toLowerCase());
    // Poll: the probes are the answer. Events: none, except ONCE when the repository is due, as the safety net for a delivery the receiver never got (agent-org#982).
    const probes = !viaEvents || due ? probePaths(repo).map((path) => ({ path, held: held.tags[path], heldFacts: held.facts?.[path], ...probeOnce({ path, held: held.tags[path], run }) })) : [];
    // The baseline's read time. An event that named the repository after it has moved `bumpedAt` past it (`bumpedAt` only moves on an event or a reconcile, and a reconcile that
    // keeps the baseline does not move it), so that comparison is the question "did an event name this repository since the content was read?" (agent-org#1431).
    const readAt = held.factsReadAt ?? held.bumpedAt;
    const namedSince = eventNamed || held.bumpedAt > readAt;
    const drift = viaEvents && due ? driftOf({ repo, probes, namedSince, windowStartS: readAt, nowS }) : null;
    // A tag that moved over the same content is counted, not filed: the health signal stays visible without an incident per repository per window.
    const isUnchangedContent = viaEvents && due && drift === null && probes.some(noContentChange);
    const sameContent = isUnchangedContent ? 1 : 0;
    const changed = (viaEvents && eventNamed) || probes.some((p) => p.changed);
    return { repo, held, before, due, probes, drift, sameContent, changed, eventNamed, readAt };
  });
  // Phase 2: file the pass's drifts as ONE incident naming every drifted repository (agent-org#1207). A refused filing leaves their windows and held tags as they were, so the next tick is due and the same probes say CHANGED again: retried, not lost.
  const drifts = reads.flatMap((r) => (r.drift === null ? [] : [r.drift]));
  const filed = drifts.length === 0 ? true : file(drifts);
  const sameContent = reads.reduce((n, r) => n + r.sameContent, 0);
  if (sameContent > 0) countSuppressed(suppressedPath(root), nowMs, sameContent);
  // Phase 3: write each repository's state and its line.
  const lines = [];
  for (const { repo, held, before, due, probes, drift, changed, eventNamed, readAt } of reads) {
    const unfiled = drift !== null && !filed;
    const counter = changed || due ? (before?.counter ?? 0) + 1 : (before?.counter ?? 1);
    // While events answer, tags are kept as they are except at a reconcile that filed (or found nothing): they are what the probes compare against on the tick the receiver is found dead, where a difference reads as a change.
    // The content each tag was read with is kept with it, so a kept tag and its facts are always the same read, and `factsReadAt` is the time of that read (agent-org#1431).
    const keep = viaEvents && (!due || unfiled);
    const kept = keep ? held.tags : Object.fromEntries(probes.flatMap((p) => (p.etag === undefined ? [] : [[p.path, p.etag]])));
    const keptFacts = keep ? held.facts : Object.fromEntries(probes.flatMap((p): [string, Facts][] => {
      const facts = p.facts ?? (p.etag === p.held ? p.heldFacts : undefined);
      return p.etag === undefined || facts === undefined ? [] : [[p.path, facts]];
    }));
    tags[repo] = { tags: kept, bumpedAt: unfiled ? held.bumpedAt : changed || due ? nowS : held.bumpedAt, facts: keptFacts, factsReadAt: keep ? readAt : nowS };
    for (const slug of repo === homeRepo ? [slugOf(repo), slugOf("")] : [slugOf(repo)]) writeWhole(join(root, "gen", slug), `${counter} ${nowS}\n`);
    const driftNote = drift === null ? "" : `; MISSED DELIVERY inferred from the ${drift.probe} probe, ${filed ? "incident filed" : "incident NOT filed, retried next tick"}`;
    const why = viaEvents ? (eventNamed ? "event" : "no event") : probes.map((p) => p.why).join(", ");
    lines.push(`${repo}: ${changed || due ? "CHANGED" : "unchanged"} (${why}${due && !changed ? "; re-read due" : ""}${driftNote}) generation ${counter}`);
  }
  writeWhole(tagsPath, JSON.stringify(tags));
  return lines;
}
