#!/usr/bin/env node
// command: trace -- every model turn, wake and GitHub event of one row, in order (a11ign/a11ign#3494, first and second slices).
//
// `agent-org trace -- <row-or-pr> [--since <ISO>] [--store <path>] [--json 1]`, and `agent-org trace -- <row-or-pr> --html --out <path>` (the swimlane, `swimlane.ts`, #3512), and `agent-org trace -- --aggregate [--since <ISO>] [--calls <n>] [--store <path>] [--json 1]` (`aggregate.ts`, #3513), and `agent-org trace -- --map --out <path> [--repo <r>] [--week <n>] [--cause <c>] [--since <ISO>] [--calls <n>] [--store <path>]` (`map.ts`, #3514)
//
// THE WATERFALL (`waterfall.ts`, #3511) is printed first, above the events: the row's eight phases, WORKING versus WAITING with what it waited on, tokens and dollars per phase, every repeat flagged.
//
// It does three things in order: INGEST the Claude transcripts, the Codex reviewers' sessions and the wake ledger, INGEST what GitHub saw of the row and its pull requests (`github-events.ts`),
// then PRINT the events about the row. Each ingest appends only the events the store does not have, so running it twice, or for two rows, adds nothing the first did
// not. What the store does NOT hold is named in the footer of every report so the absence is not read as "nothing happened": the deferral spans from before the gate's log began,
// and from when each kind of actor's transcripts and each account's `gh` calls are held. The `gh` call ledgers are ingested beside the transcripts (`gh-calls.ts`, #3516), and so is the gate's log of ended deferrals (`wake-deferral-log`, #3510).
//
// GITHUB IS READ THROUGH `gh api` ONLY, ON THE REST `core` POOL AND NEVER THE SEARCH API (30 calls a minute per user: a 1,500-call pass spent a person's limit on 2026-10-05, #3644), to learn which rows
// a pull request closes and which pull requests close a row (the row's timeline, the pull requests list), and then for the events themselves. The aggregate SAYS what it may spend before its first call,
// PACES itself and stops at a floor of `X-Ratelimit-Remaining`; the calls are counted and the report says how many were made.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFERRAL_LOG_FILE, parseDeferralLog } from "../deferral-log.ts";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { measure, mergedRows, parseLedger, readInstances, readTranscripts, rowsClosedBy } from "../wakes-per-row.ts";
import { aggregate, claimsOf, MOVES, renderAggregate, weekStart } from "./aggregate.ts";
import { buildMap } from "./map.ts";
import { swimlane } from "./swimlane.ts";
import { conditionalReader, readValidators, saveValidators } from "./publish.ts";
import type { Ask, Validated } from "./publish.ts";
import { renderWakeCache, wakeCache } from "./wake-cache.ts";
import { eventsOfCodexSession } from "./codex-turns.ts";
import { ghCallLines, ghIngestLines, ingestGhCalls } from "./gh-calls.ts";
import { countingGh, readGithubEvents } from "./github-events.ts";
import { freshnessLine, sessionsWorking, STALE_AFTER_MS, storeFreshness, transcriptRoots } from "./freshness.ts";
import { fingerprint, HEAD_BYTES, loadState, planRead, saveState, stateFileFor } from "./ingest-state.ts";
import type { Carry, FileState, IngestState } from "./ingest-state.ts";
import type { GhCallsReport } from "./gh-calls.ts";
import { appendToStore, DEFINITIONS, eventsForRow, eventsOfDeferrals, eventsOfTranscript, openStore, readStore, repriceEvents, subjectOf, subjectsOf as subjectsOfKey } from "./store.ts";
import { DEFINITIONS as WATERFALL_DEFINITIONS, renderWaterfall, waterfall } from "./waterfall.ts";
import type { Stats } from "node:fs";
import type { LedgerEntry, PullRequest } from "../wakes-per-row.ts";
import type { Tokens, TraceEvent } from "./store.ts";
import type { Move } from "./aggregate.ts";

const DEFAULT_SINCE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 30;
const BUDGET_SPENT = "GH_CALLS_SPENT";
const COST_DECIMALS = 4;
const SHORT_SHA = 7;
const NEWLINE = 0x0a;
const CODEX_DEPTH = 3; // sessions/<year>/<month>/<day>/rollout-*.jsonl
const AGGREGATE_FLAG = "--aggregate";
const MAP_FLAG = "--map";
const HTML_FLAG = "--html";
const USAGE = "usage: trace -- <row-or-pr number> [--since <ISO>] [--store <path>] [--json 1] [--html --out <path>]";
const WAKE_CACHE_FLAG = "--wake-cache";
const INGEST_FLAG = "--ingest";
const FRESHNESS_FLAG = "--freshness";
const DEFAULT_WAKE_CACHE_DAYS = 7; // a week of wakes: enough that each standing seat has a hundred or more first turns, and the store holds little older
const ISO_WEEK_ONE_DAY = 4; // 4 January is always in ISO week 1
const MAX_ISO_WEEK = 53;
const DEFAULT_GITHUB_CALLS = 1500; // a third of the REST pool an hour: the pool is the whole org's, and a second run continues where this one stopped
const REST_POOL = "core"; // `X-Ratelimit-Resource` of every endpoint this reads; a reply from any other pool (`search`) is a read that must not be here
const PACE_GAP_MS = 250; // between two calls: at most 240 a minute, whatever the budget, and far under the 900 points a minute GitHub allows a REST client
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]); // a server that failed this call and may answer the next; a 4xx (404, 403, 422) is an answer and is never asked again
const GH_ATTEMPTS = 3; // tries of one call, the first included, before the run stops saying so: the 500 of #3700 answered 200 seconds later
const RETRY_PAUSE_MS = 2000; // before the second try; before the third, twice this
const RATE_FLOOR = 500; // `X-Ratelimit-Remaining` this run leaves alone: a tenth of the 5,000 an hour that the org's own sessions draw on too
const DEFAULT_AGGREGATE_WEEKS = 4; // the weeks before this one that `--aggregate` reads when `--since` is not given

/** What this slice does not hold. Printed under every report. */
export const NOT_HELD = "NOT IN THIS STORE YET: the gate's deferral spans from before the first tick that wrote `wake-deferral-log` (#3510; a wait still OPEN is not in it either), the transcripts of Claude Code subagents (`<session>/subagents/`, one level below the sessions read).";

export function parseArgs(argv: string[]) {
  const [first, ...given] = argv[0] === "--" ? argv.slice(1) : argv;
  const number = Number(first);
  if (!Number.isInteger(number) || number <= 0) throw new Error(USAGE);
  const rest = given.filter((word) => word !== HTML_FLAG); // `--html` takes no value, so it is taken out before the rest are read as flag/value pairs
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const since = flags.since ? Date.parse(flags.since) : Date.now() - DEFAULT_SINCE_DAYS * MS_PER_DAY;
  if (Number.isNaN(since)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  const html = given.includes(HTML_FLAG);
  if (html && !flags.out) throw new Error(`--html needs --out <path>: the page is written to a file, never to the terminal. ${USAGE}`);
  return { number, since, store: flags.store ?? defaultStore(), json: flags.json === "1", html, out: flags.out };
}

/**
 * `trace -- --aggregate [--since <ISO>] [--calls <n>] [--store <path>] [--json 1]`: the weekly token-efficiency report. `--since` is rounded down to its Monday 00:00 UTC, so the first week is a
 * whole one; without it the report starts four weeks before the current one.
 */
export function parseAggregateArgs(argv: string[]) {
  const rest = (argv[0] === "--" ? argv.slice(1) : argv).filter((word) => word !== AGGREGATE_FLAG);
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const requested = flags.since ? Date.parse(flags.since) : weekStart(Date.now()) - DEFAULT_AGGREGATE_WEEKS * WEEK_DAYS * MS_PER_DAY;
  if (Number.isNaN(requested)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  const budget = flags.calls === undefined ? DEFAULT_GITHUB_CALLS : Number(flags.calls);
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`--calls must be a whole number of gh api calls (got ${flags.calls})`);
  return { since: weekStart(requested), store: flags.store ?? defaultStore(), json: flags.json === "1", budget };
}

export const isAggregate = (argv: string[]) => argv.includes(AGGREGATE_FLAG);

export const isMap = (argv: string[]) => argv.includes(MAP_FLAG);

export const isWakeCache = (argv: string[]) => argv.includes(WAKE_CACHE_FLAG);

export const isIngest = (argv: string[]) => argv.includes(INGEST_FLAG);

export const isFreshness = (argv: string[]) => argv.includes(FRESHNESS_FLAG);

/**
 * `trace -- --ingest [--since <ISO>] [--store <path>]` and `trace -- --freshness [--store <path>]` (agent-org#498). `--since` is the window of transcripts looked at, as in the other
 * modes (the last three days); a transcript the state has already read costs a `stat`, so it is not what the run costs.
 */
export function parseIngestArgs(argv: string[], now: number = Date.now()) {
  const rest = (argv[0] === "--" ? argv.slice(1) : argv).filter((word) => word !== INGEST_FLAG && word !== FRESHNESS_FLAG);
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const since = flags.since ? Date.parse(flags.since) : now - DEFAULT_SINCE_DAYS * MS_PER_DAY;
  if (Number.isNaN(since)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  return { since, store: flags.store ?? defaultStore() };
}

/**
 * `trace -- --wake-cache [--since <ISO>] [--until <ISO>] [--store <path>] [--json 1]`: the cache write of the first turn after each wake, per seat (#3563). `--since` is the start of the window and
 * is NOT rounded to a Monday; without it the window is the last seven days. `--until` ends it (default: now), so a before and an after of a change are two runs of one instrument.
 */
export function parseWakeCacheArgs(argv: string[], now: number = Date.now()) {
  const rest = (argv[0] === "--" ? argv.slice(1) : argv).filter((word) => word !== WAKE_CACHE_FLAG);
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const since = flags.since ? Date.parse(flags.since) : now - DEFAULT_WAKE_CACHE_DAYS * MS_PER_DAY;
  if (Number.isNaN(since)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  const until = flags.until ? Date.parse(flags.until) : now;
  if (Number.isNaN(until)) throw new Error(`--until must be an ISO time (got ${flags.until})`);
  return { since, until, store: flags.store ?? defaultStore(), json: flags.json === "1" };
}

/**
 * `--week` names one Monday-first UTC week: `2026-W40`, any day or time in it (`2026-09-30`), or a bare ISO week number `40` of this year. Returns its Monday 00:00 UTC.
 */
export function parseWeek(text: string, now: number) {
  const iso = /^(?:(\d{4})-W)?(\d{1,2})$/i.exec(text);
  if (iso) {
    const week = Number(iso[2]);
    if (week < 1 || week > MAX_ISO_WEEK) throw new Error(`--week ${text} is not an ISO week (1 to ${MAX_ISO_WEEK})`);
    const year = iso[1] ? Number(iso[1]) : new Date(now).getUTCFullYear();
    return weekStart(Date.UTC(year, 0, ISO_WEEK_ONE_DAY)) + (week - 1) * WEEK_DAYS * MS_PER_DAY;
  }
  const day = Date.parse(text);
  if (Number.isNaN(day)) throw new Error(`--week must be an ISO week (2026-W40 or 40) or a date in the week (got ${text})`);
  return weekStart(day);
}

/**
 * `trace -- --map --out <path> [--repo <r>] [--week <n>] [--cause <c>] [--since <ISO>] [--calls <n>] [--store <path>]`: the across-rows process map, written to one HTML file. `--since` is the start of
 * the merge window and is NOT rounded to a Monday (a map of the last 7 days is a map of the last 7 days); without it the window starts where `--aggregate`'s does, or at `--week`'s Monday when that is given.
 */
export function parseMapArgs(argv: string[], now: number = Date.now()) {
  const rest = (argv[0] === "--" ? argv.slice(1) : argv).filter((word) => word !== MAP_FLAG);
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  if (!flags.out) throw new Error("usage: trace -- --map --out <path> [--repo <r>] [--week <n>] [--cause <c>] [--since <ISO>] [--calls <n>] [--store <path>]");
  const week = flags.week === undefined ? undefined : parseWeek(flags.week, now);
  const requested = flags.since ? Date.parse(flags.since) : (week ?? weekStart(now) - DEFAULT_AGGREGATE_WEEKS * WEEK_DAYS * MS_PER_DAY);
  if (Number.isNaN(requested)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  const budget = flags.calls === undefined ? DEFAULT_GITHUB_CALLS : Number(flags.calls);
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`--calls must be a whole number of gh api calls (got ${flags.calls})`);
  return { since: requested, store: flags.store ?? defaultStore(), out: flags.out, budget, filter: { repo: flags.repo, week, cause: flags.cause } };
}

/** The `gh` call ledgers `host/gh` writes (#3466): one per account, in the config directory the wrapper routes that account to. An account that never called has none, and the ingest says so. */
const ghLedgerFiles = (home: string = homedir()) => [join(home, "workers", "gh"), join(home, "leads", "gh"), join(home, ".config", "gh")].map((dir) => join(dir, "gh-calls.tsv"));

const defaultStore = () => join(homedir(), ".cache", "a11ign", "trace", "events.ndjson");

export type IngestReport = { read: number; codexRead: number; unchanged: number; bytesRead: number; unreadableLines: number; failed: string[]; reread: string[]; heldBack: number; added: number;
  coldStart: string | null; firstRunAt: number; firstRunSince: number; ghCalls?: GhCallsReport; deferrals?: DeferralsReport; };

/** Read `[start, end)` of a file, counting what was read: the report says how many bytes a run touched, so "only what changed" is a measurement. */
function readRange(file: string, start: number, end: number, meter: { bytes: number; }) {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const descriptor = openSync(file, "r");
  try {
    readSync(descriptor, buffer, 0, buffer.length, start);
  } finally {
    closeSync(descriptor);
  }
  meter.bytes += buffer.length;
  return buffer;
}

/** A file that vanished between the listing and the stat is not a transcript to read; any other failure is real and throws. */
function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/**
 * The `.jsonl` files exactly `depth` directories under `root`, modified since `since`. Claude Code keeps a session at `projects/<project>/<id>.jsonl` (depth 1, and its
 * `<id>/subagents/` files, deeper, are not read); Codex at `sessions/<year>/<month>/<day>/rollout-*.jsonl` (depth 3).
 */
function transcriptsSince(root: string, since: number, depth: number): { file: string; stat: Stats; }[] {
  const found: { file: string; stat: Stats; }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (depth > 0 && entry.isDirectory()) found.push(...transcriptsSince(path, since, depth - 1));
    if (depth === 0 && entry.name.endsWith(".jsonl")) {
      const stat = statOrNull(path);
      if (stat && stat.mtimeMs >= since) found.push({ file: path, stat });
    }
  }
  return found;
}

/** The two kinds of session file, and how each is read: a Codex session has no wake, no ledger line and no message held back. */
const READERS = {
  claude: ({ text, file, ledger, rowRepo, carry, now }: Parameters<typeof eventsOfTranscript>[0]) => eventsOfTranscript({ text, file, ledger, rowRepo, carry, now }),
  codex: ({ text, file, rowRepo, carry }: Parameters<typeof eventsOfCodexSession>[0]) => ({ ...eventsOfCodexSession({ text, file, rowRepo, carry }), held: 0, settleAt: null, namedLate: false }),
};

/**
 * Read one transcript from where the state says to, and say what the state becomes: `null` when nothing is to be read. A transcript the state cannot be trusted for
 * is read from byte 0 and `reread` says why.
 */
function readTranscript({ file, kind, stat, entry, ledger, rowRepo, now }: {
        file: string; kind: keyof typeof READERS; stat: { size: number; mtimeMs: number; }; entry: FileState | undefined; ledger: LedgerEntry[];
        rowRepo: string; now: number;
    }, meter: { bytes: number; }) {
  const headMatches = () => !entry || fingerprint(readRange(file, 0, entry.headBytes, meter)) === entry.headHash;
  const plan = planRead({ entry, stat, now, headMatches });
  if (plan.action === "skip") return null;
  const readFrom = (start: number, carry: Carry | null) => {
    const bytes = readRange(file, start, stat.size, meter);
    return { bytes, start, result: (READERS[kind] as (input: Parameters<typeof eventsOfTranscript>[0]) => ReturnType<typeof eventsOfTranscript>)({ text: bytes.toString("utf8"), file, ledger, rowRepo, carry, now }) };
  };
  let reread = plan.reason;
  let pass = plan.action === "resume" && entry ? readFrom(entry.offset, entry.carry) : readFrom(0, null);
  if (pass.result.namedLate) { // the order that names the session came after turns already read under `unnamed:`
    reread = "its session was named by an order after turns it had already read";
    pass = readFrom(0, null);
  }
  const { bytes, start, result } = pass;
  const head = start === 0 ? bytes.subarray(0, Math.min(HEAD_BYTES, result.consumed)) : null;
  return { result, reread: reread ? `${file}: ${reread}` : null, next: {
    offset: start + result.consumed, size: stat.size, mtimeMs: stat.mtimeMs, firstReadAt: entry?.firstReadAt ?? now, settleAt: result.settleAt, carry: result.carry,
    headBytes: head ? head.length : (entry?.headBytes ?? 0), headHash: head ? fingerprint(head) : (entry?.headHash ?? fingerprint(Buffer.alloc(0))),
  } as FileState };
}

/**
 * Ingest the transcripts modified since `since` that gained bytes since the state last saw them. Their events are appended to the open store as ONE batch, and the
 * state returned is to be saved AFTER that append: a run killed in between leaves a state older than the store, which costs a re-read and no more. A file that cannot
 * be read is listed, never skipped quietly.
 */
export function ingest({ root, codexRoot = null, since, ledger, rowRepo, store, state, coldStart = null, now = Date.now() }: {
        root: string; codexRoot?: string | null; since: number; ledger: LedgerEntry[]; rowRepo: string; store: ReturnType<typeof openStore>;
        state: IngestState; coldStart?: string | null; now?: number;
    }): IngestReport & { state: IngestState; } {
  const meter = { bytes: 0 };
  const files = { ...state.files };
  const batch: TraceEvent[] = [];
  const failed: string[] = [];
  const reread: string[] = [];
  const counts = { read: 0, unchanged: 0, unreadableLines: 0, heldBack: 0, codexRead: 0 };
  const sources = [{ kind: "claude" as const, files: transcriptsSince(root, since, 1) },
    ...(codexRoot && existsSync(codexRoot) ? [{ kind: "codex" as const, files: transcriptsSince(codexRoot, since, CODEX_DEPTH) }] : [])];
  for (const { kind, file, stat } of sources.flatMap((source) => source.files.map((found) => ({ kind: source.kind, ...found })))) {
    try {
      const done = readTranscript({ file, kind, stat, entry: state.files[file], ledger, rowRepo, now }, meter);
      if (!done) {
        counts.unchanged += 1;
        continue;
      }
      for (const event of done.result.events) batch.push(event);
      counts.unreadableLines += done.result.unreadable;
      counts.heldBack += done.result.held;
      if (done.reread) reread.push(done.reread);
      files[file] = done.next;
      counts.read += 1;
      if (kind === "codex") counts.codexRead += 1;
    } catch (cause) {
      failed.push(`${file}: ${(cause as Error).message}`);
    }
  }
  const { added } = appendToStore(store, batch);
  return { ...counts, bytesRead: meter.bytes, failed, reread, added, coldStart, firstRunAt: state.firstRunAt, firstRunSince: state.firstRunSince, state: { ...state, files } };
}

/**
 * One run's ingest half: open the store (the one read of it), load the state, ingest the transcripts and then the `gh` call ledgers (whose calls are keyed to the turns just read), and save the
 * state once the events are in. The state is saved even when a file failed, because the files that did not fail were read.
 * `readEvents` is a parameter so a test can count the reads of the store.
 */
export function ingestTranscripts({ root, codexRoot = null, since, ledger, rowRepo, storePath, ghLedgers = [], deferralLogs = [], now = Date.now() }: { root: string; codexRoot?: string | null; since: number; ledger: LedgerEntry[]; rowRepo: string; storePath: string; ghLedgers?: string[]; deferralLogs?: string[]; now?: number; }, readEvents: (path: string) => TraceEvent[] = readStore) {
  const store = openStore(storePath, readEvents);
  const statePath = stateFileFor(storePath);
  const { state, coldStart } = loadState({ statePath, storePath, now, since });
  const { state: afterTranscripts, ...report } = ingest({ root, codexRoot, since, ledger, rowRepo, store, state, coldStart, now });
  const calls = ghLedgers.length > 0 ? ingestGhCalls({ ledgers: ghLedgers, store, state: afterTranscripts, now }) : null;
  const deferrals = deferralLogs.length > 0 ? ingestDeferrals({ logs: deferralLogs, rowRepo, store, state: calls?.state ?? afterTranscripts, now }) : null;
  saveState(statePath, { ...(deferrals?.state ?? calls?.state ?? afterTranscripts), storeBytes: existsSync(storePath) ? statSync(storePath).size : 0 });
  return { store, report: { ...report, ...(calls ? { ghCalls: calls.report } : {}), ...(deferrals ? { deferrals: deferrals.report } : {}) } };
}

/**
 * THE INGEST OF A HOST'S HOME as `--ingest` runs it: the transcripts of Claude Code and Codex, the wake ledger, the `gh` call ledgers and the deferral log, with the same roots and ledgers
 * `trace -- <row>` and `--aggregate` name, so the store a clock-driven `--ingest` fills is the store a reading command would have filled. It reaches no GitHub.
 */
export function ingestHome({ home = homedir(), since, storePath, rowRepo, ledger, now = Date.now() }: { home?: string; since: number; storePath: string; rowRepo: string; ledger?: LedgerEntry[]; now?: number; }) {
  const cache = join(home, ".cache", "a11ign");
  return ingestTranscripts({
    root: join(home, ".claude", "projects"), codexRoot: join(home, ".codex", "sessions"), since, ledger: ledger ?? parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8")), rowRepo, storePath,
    ghLedgers: ghLedgerFiles(home), deferralLogs: [join(cache, DEFERRAL_LOG_FILE)], now,
  });
}

/**
 * Every file the run could not read, across the three sources it ingests: the transcripts, the `gh` call ledgers and the deferral logs each report their own `failed`, and a clock that
 * counted only the first would stay green over a ledger it was not ingesting. A file that is merely absent is not a failure (a host with no Codex, no deferral log yet).
 */
export function ingestFailures(ingested: IngestReport): string[] {
  return [...ingested.failed, ...(ingested.ghCalls?.failed ?? []), ...(ingested.deferrals?.failed ?? [])];
}

/** What `--ingest` prints: one line (read, unchanged, added, failed), the failed files under it, and a cold start said as one. `added` is every kind of event the run appended. */
export function ingestSummary(ingested: IngestReport): string[] {
  const added = ingested.added + (ingested.ghCalls?.added ?? 0) + (ingested.deferrals?.added ?? 0);
  const failures = ingestFailures(ingested);
  return [`ingest: ${ingested.read} transcripts read, ${ingested.unchanged} unchanged, ${added} events added, ${failures.length} failed`
    + `${ingested.heldBack > 0 ? `, ${ingested.heldBack} messages held back (written in the last 5 minutes)` : ""}`,
  ...failures.map((failure) => `  failed: ${failure}`), ...(ingested.coldStart ? [`  COLD START: ${ingested.coldStart}`] : [])];
}

type DeferralsReport = { read: number; unchanged: number; absent: string[]; failed: string[]; spans: number; reread: string[]; added: number; };

/**
 * The whole lines of a deferral log from where the state says to, or `null` when the file has not changed. The gate appends whole lines in one write, so a half line (a write caught
 * mid-way) is left for the next run by reading only up to the last newline; a line that does not parse THROWS, which fails the file (listed, state unmoved) and never skips it.
 */
function readDeferralLog({ file, entry, now }: { file: string; entry: FileState | undefined; now: number; }) {
  const stat = statSync(file);
  const bytes = readFileSync(file);
  const plan = planRead({ entry, stat: { size: bytes.length, mtimeMs: stat.mtimeMs }, now, headMatches: () => !entry || fingerprint(bytes.subarray(0, entry.headBytes)) === entry.headHash });
  if (plan.action === "skip") return null;
  const start = plan.action === "resume" && entry ? entry.offset : 0;
  const text = bytes.subarray(start, bytes.lastIndexOf(NEWLINE) + 1).toString("utf8");
  const consumed = Buffer.byteLength(text);
  const head = start === 0 ? bytes.subarray(0, Math.min(HEAD_BYTES, consumed)) : null;
  const next: FileState = {
    offset: start + consumed, size: bytes.length, mtimeMs: stat.mtimeMs, firstReadAt: entry?.firstReadAt ?? now, settleAt: null, carry: { session: null, owner: null, lastAt: null, used: [] },
    headBytes: head ? head.length : (entry?.headBytes ?? 0), headHash: head ? fingerprint(head) : (entry?.headHash ?? fingerprint(Buffer.alloc(0))),
  };
  return { spans: parseDeferralLog(text, file), next, reread: plan.reason };
}

/**
 * Ingest the gate's deferral logs (`deferral-log.ts`) INCREMENTALLY, through the same state as the transcripts (#3526): only the bytes a log gained are read, and a log that shrank or whose first
 * bytes changed is read again from byte 0 and SAID. One event per span, appended to the open store as ONE batch; the state is the caller's to save AFTER that append. A log that does not exist
 * (a host whose gate has not ticked since #3510) is listed as absent, never as empty.
 */
export function ingestDeferrals({ logs, rowRepo, store, state, now }: { logs: string[]; rowRepo: string; store: ReturnType<typeof openStore>; state: IngestState; now: number; }): { report: DeferralsReport; state: IngestState; } {
  const files = { ...state.files };
  const report: DeferralsReport = { read: 0, unchanged: 0, absent: [], failed: [], spans: 0, reread: [], added: 0 };
  const batch: TraceEvent[] = [];
  for (const file of logs) {
    if (!existsSync(file)) {
      report.absent.push(file);
      continue;
    }
    try {
      const done = readDeferralLog({ file, entry: state.files[file], now });
      if (!done) {
        report.unchanged += 1;
        continue;
      }
      batch.push(...eventsOfDeferrals(done.spans, rowRepo));
      Object.assign(report, { read: report.read + 1, spans: report.spans + done.spans.length });
      if (done.reread) report.reread.push(`${file}: ${done.reread}`);
      files[file] = done.next;
    } catch (cause) {
      report.failed.push(`${file}: ${(cause as Error).message}`);
    }
  }
  report.added = appendToStore(store, batch).added;
  return { report, state: { ...state, files } };
}

/** The deferral half of the ingest footer. */
function deferralIngestLines(report: DeferralsReport) {
  const lines = [`deferral logs: ${report.read} read, ${report.unchanged} unchanged since the last run, ${report.spans} spans, ${report.added} new to the store`];
  for (const file of report.absent) lines.push(`  no log at ${file}: the gate has not ticked since it began writing one, so NO deferral span is held`);
  for (const file of report.failed) lines.push(`  failed: ${file}`);
  for (const reason of report.reread) lines.push(`  read again from byte 0: ${reason}`);
  return lines;
}

/**
 * What `number` is about, by `gh api` on the REST pool: when it is a pull request, the rows it closes; when it is a row, itself; and in both cases every pull request
 * that closes one of those rows. A call that fails THROWS: an empty answer from a failed call would print a trace that silently lacks the standing leads' turns.
 * `gh` is `gh api <args>` parsed; a parameter so a test can hand it a fixture.
 */
export function resolveSubject(number: number, rowRepo: string, gh: (args: string[]) => any = ghApi): { rows: number[]; prs: number[]; } {
  const pull = askPull(number, rowRepo, gh);
  const rows = pull ? rowsClosedBy(pull.body ?? "", rowRepo) : [number];
  const prs = new Set(pull ? [number] : []);
  for (const row of rows) for (const found of pullsClosing({ row, rowRepo, gh })) prs.add(found);
  return { rows, prs: [...prs] };
}

/**
 * The pull requests of `rowRepo` whose body closes `row`, from the row's own timeline: a pull request that names a row leaves a `cross-referenced` event on it, carrying the pull request
 * and its body. This is the row's timeline, a REST list on the `core` pool, where the search API (30 calls a minute per user) is not used. A mention that closes nothing, or closes another
 * repository's row, is not a link, and a pull request of another repository is not read under `rowRepo`.
 */
function pullsClosing({ row, rowRepo, gh }: { row: number; rowRepo: string; gh: (args: string[]) => any; }): number[] {
  const { items, reached } = pagedList({ gh, path: `repos/${rowRepo}/issues/${row}/timeline` });
  if (!reached) throw new Error(`gh api repos/${rowRepo}/issues/${row}/timeline: more than ${LIST_MAX_PAGES} pages; refusing to name the pull requests of a row on part of its timeline`);
  const sources = items.filter((event) => event.event === "cross-referenced" && event.source?.issue?.pull_request && String(event.source.issue.repository_url).endsWith(`/repos/${rowRepo}`)).map((event) => event.source.issue);
  return sources.filter((issue) => rowsClosedBy(issue.body ?? "", rowRepo).includes(row)).map((issue) => issue.number);
}

function runGhApi(args: string[]) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: GH_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

function ghApi(args: string[]) {
  return JSON.parse(runGhApi(args));
}

/** The rate-limit headers of a `gh api -i` reply and its body. A pool's `Remaining` is read off a REAL call, never off `rate_limit`, which has reported a full pool during an outage. */
export function splitHttp(text: string) {
  const [head, ...rest] = text.split(/\r?\n\r?\n/);
  const header = (name: string) => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im").exec(head)?.[1];
  const remaining = Number(header("x-ratelimit-remaining")); // NaN when the header is absent: no reading, which is not a reading of zero
  return { rate: Number.isNaN(remaining) ? null : { remaining, resource: header("x-ratelimit-resource") ?? null }, body: rest.join("\n\n") };
}

/**
 * The reads that send the validator they were last given, because their ETag was MEASURED to hold (2026-10-08, #4097): a row's or pull request's own record and a head's check-runs. The timeline is
 * left out on purpose (its body embeds the source issue of every cross-reference, and those moved within 15 seconds on a row nothing had touched), and so are the lists (a paged list's ETag
 * changed within 120 seconds, #4077). Only a call of ONE argument can be one of these: a list carries `-X GET` and its parameters as further arguments.
 */
const VALIDATED_READS = [/^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/\d+$/, /^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+\/check-runs\?/];
const NOT_MODIFIED = /^HTTP\/\S+\s+304\b/;

/** `gh api`, whose exit code is 1 on a 304 as on a failure: the status line is what says which, so a 304 comes back as text and any other failure is thrown as it came. */
function runGhApiAnswering(args: string[]) {
  try {
    return runGhApi(args);
  } catch (error) {
    if (NOT_MODIFIED.test(String((error as { stdout?: string }).stdout ?? ""))) return (error as { stdout: string }).stdout;
    throw error;
  }
}

/**
 * `gh api` that also remembers the rate-limit headers of the last reply (`.rate`) and of the first (`.first`), so a run can pace itself, stop at a floor, and say what it spent.
 * A read in VALIDATED_READS sends the ETag it was last given (`held`, the kept validators: see `publish.ts`) and answers a 304 from the body kept with it, which costs no point of the pool. THE `-H` COMES
 * FIRST on that call because the `gh` ledger keeps the first two words of a command (`api -H`), which is how the conditional reads are counted apart from the others (`api -i`). `validators.unchanged(path)` says
 * whether this run got a 304 for it; `validators.forget(path)` drops a validator whose subject was not read to the end, so the next run asks for it whole.
 * `run` is a parameter so a test can hand it a fixture.
 */
export function meteredGhApi({ held = {}, now = Date.now(), run = runGhApiAnswering }: { held?: Record<string, Validated>; now?: number; run?: (args: string[]) => string; } = {}): ((args: string[]) => any) & { rate: { remaining: number; resource: string | null; } | null; first: { remaining: number; resource: string | null; } | null; validators: { unchanged: (path: string) => boolean; forget: (path: string) => void; }; } {
  const answered304: Set<string> = new Set();
  const remember = (rate: { remaining: number; resource: string | null; } | null) => {
    metered.rate = rate;
    metered.first ??= rate;
  };
  const ask: Ask = (path, etag) => {
    const text = run([...(etag === null ? [] : ["-H", `If-None-Match: ${etag}`]), "-i", path]);
    const { rate, body } = splitHttp(text);
    remember(rate);
    if (NOT_MODIFIED.test(text)) {
      answered304.add(path);
      return { status: 304, etag, body: null };
    }
    return { status: 200, etag: /^etag:\s*(.+?)\s*$/im.exec(text.split(/\r?\n\r?\n/)[0])?.[1] ?? null, body: JSON.parse(body) };
  };
  const reader = conditionalReader({ held, ask, now });
  const metered = Object.assign((args: string[]) => {
    if (args.length === 1 && VALIDATED_READS.some((pattern) => pattern.test(args[0]))) return reader.read(args[0], (body) => body);
    const { rate, body } = splitHttp(run(["-i", ...args]));
    remember(rate);
    return JSON.parse(body);
  }, { rate: null as { remaining: number; resource: string | null; } | null, first: null as { remaining: number; resource: string | null; } | null, validators: { unchanged: (path: string) => answered304.has(path), forget: (path: string) => { delete held[path]; } } });
  return metered;
}

/** The pull request numbered `number`, or `null` on a 404 (it is a row); any other failure throws. */
function askPull(number: number, rowRepo: string, gh: (args: string[]) => any) {
  try {
    return gh([`repos/${rowRepo}/pulls/${number}`]);
  } catch (cause) {
    if (!/404|Not Found/.test(String((cause as { stderr?: string }).stderr ?? cause))) throw cause;
    return null;
  }
}

function clock(ms: number) {
  const seconds = Math.round(ms / MS_PER_SECOND);
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}s`;
}

const tokenLine = (tokens: Tokens) => `in ${tokens.input} out ${tokens.output} read ${tokens.cacheRead} write ${tokens.cacheWrite5m + tokens.cacheWrite1h}`;

const GITHUB_DETAIL: Record<string, (event: TraceEvent) => string> = {
  filed: (event) => `FILED   row #${event.row} by ${event.actor}`,
  opened: (event) => `OPENED  pull request #${event.pr} by ${event.actor}`,
  claimed: (event) => `CLAIMED by ${event.claimant}`,
  released: (event) => `RELEASED by ${event.claimant}`,
  labeled: (event) => `LABEL   + ${event.name} by ${event.actor}`,
  unlabeled: (event) => `LABEL   - ${event.name} by ${event.actor}`,
  ready_for_review: (event) => `READY   for review by ${event.actor}`,
  reviewed: (event) => `REVIEW  ${event.state} by ${event.actor} at head ${event.headSha?.slice(0, SHORT_SHA)}`,
  head_moved: (event) => `HEAD    ${event.headSha?.slice(0, SHORT_SHA)}`,
  ci_run: (event) => `CI      ${event.name} ${event.state ?? event.status}${event.completedAt ? ` in ${clock(Math.max(0, event.completedAt - (event.startedAt ?? event.completedAt)))}` : ""} at head ${event.headSha?.slice(0, SHORT_SHA)}`,
  added_to_merge_queue: (event) => `QUEUED  by ${event.actor}`,
  removed_from_merge_queue: (event) => `DEQUEUED (${event.outcome})`,
  merged: (event) => `MERGED  by ${event.actor}`,
  closed: (event) => `CLOSED  ${event.row === null ? `pull request #${event.pr}` : `row #${event.row}`} by ${event.actor}`,
};

const githubDetail = (event: TraceEvent) => (GITHUB_DETAIL[event.kind] ?? (() => event.kind))(event);

const isoSeconds = (ms: number) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM:SS".length).replace("T", " ");

function line(event: TraceEvent): string {
  const when = isoSeconds(event.at);
  const who = event.session.padEnd(18);
  if (event.source === "github") return `${when}  ${who} ${githubDetail(event)}`;
  if (event.kind === "deferral") return `${when}  ${who} DEFERRED ${event.causeKey}  waited ${clock((event.completedAt ?? event.at) - (event.startedAt ?? event.at))} (from ${isoSeconds(event.startedAt ?? event.at)}Z), ${event.how}`;
  if (event.kind === "turn" && event.tokens) {
    const cost = event.costUsd === null || event.costUsd === undefined ? "$?" : `$${event.costUsd.toFixed(COST_DECIMALS)}`;
    const wall = event.wallClockMs === null || event.wallClockMs === undefined ? "?" : clock(event.wallClockMs);
    return `${when}  ${who} turn   ${wall.padStart(7)}  ${cost.padStart(8)}  ${tokenLine(event.tokens)}  ${event.model}${event.sidechain ? " (subagent)" : ""}`;
  }
  if (event.kind === "wake") {
    const lag = event.deliveryLagMs === null || event.deliveryLagMs === undefined ? "" : `  lag ${clock(event.deliveryLagMs)}`;
    return `${when}  ${who} WAKE   ${event.causeKey ?? "(no ledger line)"}${lag}`;
  }
  return `${when}  ${who} COMPACTION`;
}

/** The session as one line of the totals: `reviewer-3406` run by Codex is not `reviewer-3406` run by Claude Code */
const actorOf = (event: TraceEvent) => `${event.session}${event.harness === "codex" ? " (codex)" : ""}`;

/** The KIND of actor, for "since when do we hold its transcripts": a worker or reviewer per row is one kind. */
function kindOfActor(event: TraceEvent) {
  const kind = /^(worker|reviewer)-/.test(event.session) ? event.session.split("-")[0] : event.session.replace(/^unnamed:.*/, "unnamed (no order named it)").replace(/^codex:.*/, "other directory");
  return `${kind}${event.harness === "codex" ? " (codex)" : ""}`;
}

/** One line per actor of the row: its turns, its priced cost, and its output tokens. */
function actorTotals(turns: TraceEvent[]) {
  const byActor: Map<string, { turns: number; priced: number; cost: number; output: number; }> = new Map();
  for (const turn of turns) {
    const total = byActor.get(actorOf(turn)) ?? { turns: 0, priced: 0, cost: 0, output: 0 };
    total.turns += 1;
    total.output += turn.tokens?.output ?? 0;
    if (typeof turn.costUsd === "number") {
      total.priced += 1;
      total.cost += turn.costUsd;
    }
    byActor.set(actorOf(turn), total);
  }
  return [...byActor].map(([actor, t]) => `  ${actor.padEnd(26)} ${String(t.turns).padStart(4)} turns  $${t.cost.toFixed(COST_DECIMALS)} over ${t.priced} priced  out ${t.output}`);
}

/** The earliest turn or wake the store holds, per kind of actor, over the whole store: an absence before it is "not read", never "nothing happened". */
function heldFrom(everything: TraceEvent[]) {
  const first: Map<string, number> = new Map();
  for (const event of everything) {
    if (event.source === "github" || event.source === "gh-ledger" || event.source === "deferral-log") continue;
    const kind = kindOfActor(event);
    first.set(kind, Math.min(first.get(kind) ?? Number.POSITIVE_INFINITY, event.at));
  }
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length);
  return [...first].sort(([, a], [, b]) => a - b).map(([kind, at]) => `  ${kind.padEnd(28)} held from ${iso(at)}Z`);
}

/** From when the store holds deferral spans: the log is kept from the first tick that wrote it, so a wait before that is in no record. */
function deferralHeldLine(everything: TraceEvent[]) {
  const spans = everything.filter((event) => event.kind === "deferral");
  if (spans.length === 0) return "DEFERRAL SPANS HELD: none in the store yet; a wait of this row's is NOT shown as absent, it is unrecorded (name it from the review event, the ledger's delivery and the seat's turns, and mark it inferred)";
  const first = Math.min(...spans.map((event) => event.startedAt ?? event.at));
  return `DEFERRAL SPANS HELD: ${spans.length} ended waits, the earliest started ${isoSeconds(first).slice(0, "YYYY-MM-DD HH:MM".length)}Z; a wait before the first tick that wrote the log is unrecorded, and one still open is not in it`;
}

/** The transcript half of the footer: what this run read, and from when the state holds the transcripts, so an absence before that is not read as "nothing happened". */
function ingestLines(ingested: IngestReport) {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length);
  const lines = [`ingested ${ingested.read} transcripts (${ingested.bytesRead} bytes read; ${ingested.unchanged} unchanged since the last run); ${ingested.unreadableLines} unreadable lines; `
    + `${ingested.failed.length} files failed${ingested.failed.map((f) => `\n  ${f}`).join("")}`];
  lines.push(`${ingested.codexRead} of those were Codex reviewer sessions (read from ~/.codex/sessions, never written)`);
  if (ingested.coldStart) lines.push(`COLD START (every transcript in the window read from its first byte): ${ingested.coldStart}`);
  for (const reason of ingested.reread) lines.push(`read again from byte 0: ${reason}`);
  if (ingested.heldBack > 0) lines.push(`${ingested.heldBack} messages written in the last 5 minutes are held back to the next run (a message may still be gaining blocks, and its turn is built from the last)`);
  if (ingested.ghCalls) lines.push(...ghIngestLines(ingested.ghCalls));
  if (ingested.deferrals) lines.push(...deferralIngestLines(ingested.deferrals));
  lines.push(`TRANSCRIPT STATE: holds each transcript from the run that first read it, the first run being ${iso(ingested.firstRunAt)}Z over transcripts modified after ${iso(ingested.firstRunSince)}Z. `
    + "A transcript is read from its first byte then, but one last modified before that window is not in the store: absence before it is not \"nothing happened\".");
  return lines;
}

/**
 * The waterfall of each row the number names, or of the pull request alone when it closes none. A row's waterfall reads that row's events and the pull requests' that close it.
 */
export function waterfallsOf({ rows, prs, number, events: stored, now }: { rows: number[]; prs: number[]; number: number; events: TraceEvent[]; now: number; }) {
  return subjectsOf({ rows, prs, number, events: stored }).map(({ title, found }) => ({ title, waterfall: waterfall({ events: found, now }) }));
}

/**
 * The events of each subject of a number: one per row it names (that row's events and its pull requests'), or the pull request alone when it closes none.
 */
function subjectsOf({ rows, prs, number, events: stored }: { rows: number[]; prs: number[]; number: number; events: TraceEvent[]; }) {
  const events = repriceEvents(stored);
  return rows.length > 0 ? rows.map((row) => ({ title: `row #${row}`, found: eventsForRow(events, { rows: [row], prs }) })) : [{ title: `pull request #${number}`, found: events }];
}

/**
 * The report for one row's events, as text.
 * `held` is every event of the store, for the footer's "held from"; `now` is the reading's time, which an open phase runs to
 */
export function render({ number, rows, prs, events: found, ingest: ingested, github, held, now = Date.now() }: {
        number: number; rows: number[]; prs: number[]; events: TraceEvent[]; ingest?: IngestReport;
        github?: { calls: number; read: number; added: number; }; held?: TraceEvent[]; now?: number;
    }) {
  const events = repriceEvents(found).filter((event) => event.source !== "gh-ledger"); // a row can hold thousands of calls: they are summarised below, never one line each
  const turns = events.filter((event) => event.kind === "turn");
  const priced = turns.filter((event) => typeof event.costUsd === "number");
  const total = priced.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  const sessions = [...new Set(events.filter((event) => event.source !== "github" && event.source !== "deferral-log").map((event) => event.session))];
  const fromGithub = events.filter((event) => event.source === "github").length;
  const named = [rows.length > 0 ? `rows: ${rows.map((row) => `#${row}`).join(", ")}` : "", prs.length > 0 ? `pull requests: ${prs.map((pr) => `#${pr}`).join(", ")}` : ""].filter(Boolean);
  const out = [`TRACE #${number}${named.length > 0 ? `  (${named.join("; ")})` : ""}`];
  for (const { title, waterfall: drawn } of waterfallsOf({ rows, prs, number, events: found, now })) out.push("", ...renderWaterfall(drawn, { title, now }));
  out.push("", "EVENTS");
  if (events.length === 0) out.push("no events: nothing in the store names this row or its pull requests within the ingested window (widen it with --since).");
  for (const event of events) out.push(line(event));
  out.push("", `${events.length} events (${fromGithub} from GitHub), ${turns.length} turns across ${sessions.length} sessions (${sessions.join(", ")})`);
  out.push(`cost $${total.toFixed(COST_DECIMALS)} over ${priced.length} priced turns; ${turns.length - priced.length} turns have a model with no price and are NOT in that total`);
  if (turns.length > 0) out.push("per actor on this row:", ...actorTotals(turns));
  if (ingested) out.push(...ingestLines(ingested));
  if (held) out.push("TRANSCRIPTS HELD, per actor (the earliest turn or wake in the store; Claude Code sessions and Codex reviewer sessions):", ...heldFrom(held));
  out.push(...ghCallLines({ events: found, held }));
  if (held) out.push(deferralHeldLine(held));
  if (github) out.push(`GitHub: ${github.calls} REST calls (gh api); ${github.read} events read, ${github.added} new to the store`);
  out.push(NOT_HELD, "", ...WATERFALL_DEFINITIONS, ...DEFINITIONS);
  return out.join("\n");
}

const pauseMs = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);

const spent = (message: string, reason: "budget" | "floor" | "failure") => Object.assign(new Error(message), { code: BUDGET_SPENT, reason });

/**
 * The HTTP status a failed `gh api` call reports, or `null` when its error names none (a missing binary, a malformed reply). `gh` says it on stderr as `(HTTP 500)`, and with `-i` the reply
 * on stdout opens with `HTTP/2.0 500`.
 */
export function httpStatusOf(error: any): number | null {
  const named = /\bHTTP(?:\/[\d.]+)? (\d{3})\b/.exec(`${error?.stderr ?? ""}\n${error?.message ?? ""}\n${String(error?.stdout ?? "").split("\n", 1)[0]}`);
  return named === null ? null : Number(named[1]);
}

/**
 * `gh` that makes at most `budget` calls and counts every one (a failed call is still a call). The (budget+1)th THROWS, before it is made, with `code: GH_CALLS_SPENT`: the budget is
 * checked per CALL, because one pull request costs several (the issue, each page of its timeline, a check-runs list per head), so a check per pull request can be overshot by all of them.
 * It PACES: a call waits until `gapMs` have passed since the last one ended. It stops at a FLOOR: when the reply last read carried an `X-Ratelimit-Remaining` under `floor`, the next call
 * throws the same code with `reason: "floor"`, before it is made. And it refuses a reply whose pool is not `core`, one that names no pool included (the search API's 30 a minute is the limit this exists to keep off).
 * A 5xx reply (RETRYABLE_STATUSES) is tried again after a pause, up to GH_ATTEMPTS in all, and EVERY try is a counted, paced and floor-checked call; the last failure throws the same code with
 * `reason: "failure"` and the url and status in its message, so a reader stops there as it stops at the budget and what was read before it is kept. Any other failure is thrown as it came.
 * `.stopped` says which of the three stops ended the run, or `null`.
 */
export function budgetedGh({ gh, budget, floor = 0, gapMs = 0, pause = pauseMs, clock = Date.now }: { gh: ((args: string[]) => any) & { rate?: { remaining: number; resource: string | null; } | null; }; budget: number; floor?: number; gapMs?: number; pause?: (ms: number) => void; clock?: () => number; }): ((args: string[]) => any) & { calls: number; stopped: { reason: "budget" | "floor" | "failure"; message: string; } | null; } {
  const counted = countingGh(gh);
  let lastEnd: number | null = null;
  let stopped: { reason: "budget" | "floor" | "failure"; message: string; } | null = null;
  const stop = (message: string, reason: "budget" | "floor" | "failure") => {
    stopped = { reason, message };
    return spent(message, reason);
  };
  const attempt = (args: string[]) => {
    if (counted.calls >= budget) throw stop(`--calls ${budget} is spent`, "budget");
    const left = gh.rate?.remaining;
    if (left !== undefined && left < floor) throw stop(`X-Ratelimit-Remaining is ${left}, under the floor of ${floor}`, "floor");
    if (lastEnd !== null && clock() - lastEnd < gapMs) pause(gapMs - (clock() - lastEnd));
    try {
      return counted(args);
    } finally {
      lastEnd = clock();
    }
  };
  const bounded = (args: string[]) => {
    let reply: any;
    for (let tried = 1; reply === undefined; tried += 1) {
      try {
        reply = attempt(args);
      } catch (error) {
        const status = httpStatusOf(error);
        if (status === null || !RETRYABLE_STATUSES.has(status)) throw error;
        if (tried >= GH_ATTEMPTS) throw stop(`stopped at gh api ${args.join(" ")}: HTTP ${status} after ${tried} attempts`, "failure");
        pause(RETRY_PAUSE_MS * tried);
      }
    }
    const pool = gh.rate?.resource ?? null;
    if (pool !== REST_POOL) throw new Error(`a reply came from ${pool === null ? "no named pool (X-Ratelimit-Resource is absent)" : `the "${pool}" pool`}, not "${REST_POOL}": ${args.join(" ")} must not be read by this report, because a pool that is not named cannot be known not to be the search API (30 calls a minute per user)`);
    return reply;
  };
  return Object.defineProperties(bounded, { calls: { get: () => counted.calls }, stopped: { get: () => stopped } }) as typeof bounded & { calls: number; stopped: { reason: "budget" | "floor" | "failure"; message: string; } | null; };
}

const isSpent = (error: any) => error?.code === BUDGET_SPENT;

/**
 * Every item of a REST list, one counted call per page, until a page comes back short (the end of the list), `done` says the pages read hold what was wanted, or LIST_MAX_PAGES have been
 * read: that last is `reached: false`, and a caller must refuse it rather than print a list that stops part way without saying so.
 */
function pagedList({ gh, path, params = [], done = () => false }: { gh: (args: string[]) => any; path: string; params?: string[]; done?: (page: any[]) => boolean; }): { items: any[]; reached: boolean; } {
  const items: any[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const reply = gh(["-X", "GET", path, ...params.flatMap((param) => ["-f", param]), "-f", `per_page=${LIST_PAGE}`, "-f", `page=${page}`]);
    if (!Array.isArray(reply)) throw new Error(`gh api ${path}: the reply carried no list where one was expected`);
    items.push(...reply);
    if (reply.length < LIST_PAGE || done(reply)) return { items, reached: true };
  }
  return { items, reached: false };
}

/**
 * Merged pull requests of one repository in the window, one counted call per page of the pull requests list, NEWEST UPDATE FIRST, read until a page reaches a pull request last updated
 * before the window: a pull request merged in the window was updated at or after its merge, so none can be further down. This is the REST list on the `core` pool; the search API it replaces
 * (30 calls a minute per user, 1,000 results at most) is not used. A list that is not finished in LIST_MAX_PAGES is REFUSED, not cut short, because a week missing its pull requests
 * prints as a smaller week: `--since` is narrowed instead.
 */
export function listMergedPulls({ repo, window, gh }: { repo: string; window: { from: number; to: number; }; gh: (args: string[]) => any; }): PullRequest[] {
  const { items, reached } = pagedList({ gh, path: `repos/${repo}/pulls`, params: ["state=closed", "sort=updated", "direction=desc"], done: (page) => page.some((pull) => Date.parse(pull.updated_at) < window.from) });
  if (!reached) throw new Error(`${repo} has more than ${LIST_MAX_PAGES * LIST_PAGE} closed pull requests updated since ${new Date(window.from).toISOString()}; a list cut short would print smaller weeks, so narrow --since`);
  const inWindow = items.filter((pull) => pull.merged_at && Date.parse(pull.merged_at) >= window.from && Date.parse(pull.merged_at) <= window.to);
  inWindow.sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.number - b.number); // the list is in order of UPDATE, which moves between two runs; the report's tied lines follow this order
  return inWindow.map((pull) => ({ repo, number: pull.number, createdAt: pull.created_at, mergedAt: pull.merged_at, body: pull.body ?? "" }));
}

/** The rows GitHub says are open now, one counted call per page, pull requests (which the issues endpoint also lists) left out. */
export function listOpenRows({ rowRepo, gh }: { rowRepo: string; gh: (args: string[]) => any; }): number[] {
  const { items, reached } = pagedList({ gh, path: `repos/${rowRepo}/issues`, params: ["state=open"] });
  if (!reached) throw new Error(`gh api repos/${rowRepo}/issues: more than ${LIST_MAX_PAGES} pages; refusing to call a row open on part of the list`);
  return items.filter((item) => !item.pull_request).map((item) => item.number);
}

/**
 * What the run must know before it can place a single week: the merged pull requests of every code repository, then which rows are open. Both are counted calls. Without the pull
 * requests there is no list of merged rows, so a stop (the budget, or the floor) that cannot list them is an ERROR (a partial list would print smaller weeks); the open rows are optional, and a stop
 * before them leaves them unknown (`null`, printed `not asked`).
 */
export function readListings({ repos, rowRepo, window, gh, budget }: { repos: string[]; rowRepo: string; window: { from: number; to: number; }; gh: ReturnType<typeof budgetedGh>; budget: number; }) {
  try {
    const pulls = repos.flatMap((repo) => listMergedPulls({ repo, window, gh }));
    return { pulls, openRows: openRowsWithin({ rowRepo, gh }) };
  } catch (cause) {
    if (!isSpent(cause)) throw cause;
    throw listingStopped({ gh, budget, cause });
  }
}

/** The error of a run that a stop kept from listing the merged pull requests: what stopped it, and what to do. It carries the stop's code, so the entry point prints it without a stack. */
function listingStopped({ gh, budget, cause }: { gh: ReturnType<typeof budgetedGh>; budget: number; cause: unknown; }) {
  const reason = gh.stopped?.reason;
  const why = reason === "floor" ? `stopped at the floor: ${gh.stopped?.message} to list the merged pull requests` : reason === "failure" ? `${gh.stopped?.message}, listing the merged pull requests` : `--calls ${budget} is too small to list the merged pull requests`;
  const remedy = reason === "floor" ? "wait for the pool to refill" : reason === "failure" ? "run it again" : "raise --calls";
  return Object.assign(new Error(`${why} (${gh.calls} made): no week can be placed without that list, and a part of it would print smaller weeks; ${remedy}`, { cause }), { code: BUDGET_SPENT });
}

function openRowsWithin({ rowRepo, gh }: { rowRepo: string; gh: ReturnType<typeof budgetedGh>; }): number[] | null {
  try {
    return listOpenRows({ rowRepo, gh });
  } catch (error) {
    if (isSpent(error)) return null;
    throw error;
  }
}

/** One pull request's own events, tagged with its repository's short name when it is a keyed repository's (how the store keeps `repo`). */
function pullEventsOf({ pull, rowRepo, gh }: { pull: { number: number; repo: string; }; rowRepo: string; gh: (args: string[]) => any; }) {
  const events = readGithubEvents({ rows: [], prs: [pull.number], repo: pull.repo, gh });
  return pull.repo === rowRepo ? events : events.map((event) => ({ ...event, repo: pull.repo.split("/")[1] }));
}

/**
 * Read what `pending` names of one pull request and the rows it closes, until the budget is spent. A subject whose reading the budget cut off is NOT stored (its events come back only
 * from a whole reading); what finished before it is. Returns what is still pending, which is non-empty only when the budget stopped it.
 */
function readPull({ pull, pending, rowRepo, gh }: { pull: PullRequest; pending: { pull: boolean; rows: number[]; }; rowRepo: string; gh: (args: string[]) => any; }) {
  const events: TraceEvent[] = [];
  const left = { ...pending };
  try {
    if (left.pull) {
      events.push(...pullEventsOf({ pull, rowRepo, gh }));
      left.pull = false;
    }
    if (left.rows.length > 0) {
      events.push(...readGithubEvents({ rows: left.rows, prs: [], repo: rowRepo, gh }));
      left.rows = [];
    }
  } catch (error) {
    if (!isSpent(error)) throw error;
  }
  return { events, left };
}

/**
 * What the aggregate reads of GitHub: for the merged rows, their own events (the claim, which gives the wall-clock) and those of the pull requests that closed them. OLDEST MERGE
 * FIRST, and it STOPS when `gh` (budgeted: see `budgetedGh`) refuses a call: a backfill of three weeks is about nine thousand REST calls, and the pool is the whole org's. A merged pull
 * request and a closed row do not change, so what the store already holds of one is not read again: a second run continues where the first stopped. What was not read is
 * returned, so a week that depends on it is marked PARTIAL.
 */
export function githubEventsOfMerged({ pulls, rowRepo, held, gh }: { pulls: PullRequest[]; rowRepo: string; held: TraceEvent[]; gh: (args: string[]) => any; }) {
  const merged = new Set(held.filter((event) => event.kind === "merged" && event.pr !== null).map((event) => `${event.repo ?? "primary"}#${event.pr}`));
  const closed = new Set(held.filter((event) => event.kind === "closed" && event.row !== null).map((event) => event.row));
  const events: TraceEvent[] = [];
  const unreadRows: number[] = [];
  let stopped = false;
  for (const pull of [...pulls].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))) {
    const closes = rowsClosedBy(pull.body ?? "", rowRepo);
    let left = { pull: !merged.has(`${pull.repo === rowRepo ? "primary" : pull.repo.split("/")[1]}#${pull.number}`), rows: closes.filter((row) => !closed.has(row)) };
    if (!stopped) {
      const read = readPull({ pull, pending: left, rowRepo, gh });
      events.push(...read.events);
      left = read.left;
      stopped = left.pull || left.rows.length > 0;
    }
    if (left.pull || left.rows.length > 0) unreadRows.push(...closes);
  }
  return { events, unreadRows };
}

/** `Named` is a row, or a pull request of the primary repository (`repo` null) or of a keyed one (its short name). */
type Named = { number: number; isPull: boolean; repo: string | null; };

/** Which row or pull request, as one string: the form `githubEventsOfMerged` keeps its `merged` set in. */
const nameOf = ({ number, isPull, repo }: Named) => (isPull ? `${repo ?? "primary"}#${number}` : `row ${number}`);

/** The rows and pull requests ONE ledger key names, the way `aggregate.ts` reads it, so what is read here is what a repeat is judged by. A key naming none (`ready-queue-empty`) names none. */
function namedByKey(key: string): Named[] {
  const named = { ...subjectOf(key), ...subjectsOfKey(key) };
  const numbers = (list: unknown[]) => list.filter((number) => typeof number === "number");
  return [
    ...numbers([named.row, ...(named.rows ?? [])]).map((number) => ({ number, isPull: false, repo: null })),
    ...numbers([named.pr, ...(named.prs ?? [])]).map((number) => ({ number, isPull: true, repo: named.repo ?? null })),
  ];
}

/** What a reading can no longer change: a row that was closed, a pull request that was merged or closed. A subject with none of these is open, so its record grows and a stored reading may be stale. */
function settledIn(held: TraceEvent[]) {
  const github = held.filter((event) => event.source === "github");
  return new Set([
    ...github.flatMap(({ kind, row }) => (kind === "closed" && typeof row === "number" ? [nameOf({ number: row, isPull: false, repo: null })] : [])),
    ...github.flatMap(({ kind, pr, repo }) => ((kind === "merged" || kind === "closed") && typeof pr === "number" ? [nameOf({ number: pr, isPull: true, repo: repo ?? null })] : [])),
  ]);
}

/**
 * The rows and pull requests the wakes of the window name, each once, in the order a wake first named it. The oldest first, so that when the budget stops the reading it is the newest wakes that stay unexplained.
 */
function namedByWakes(held: TraceEvent[], since: number) {
  const wakes = held.filter((event) => event.kind === "wake" && event.causeKey && event.at >= since).sort((a, b) => a.at - b.at);
  return [...new Map(wakes.flatMap((wake) => namedByKey(String(wake.causeKey))).map((subject) => [nameOf(subject), subject])).values()];
}

/** The answer already in hand for `path`, so a read that was made once to ask a question is not made again to answer it. */
const replaying = ({ path, reply, gh }: { path: string; reply: any; gh: (args: string[]) => any; }) => (args: string[]) => (args.length === 1 && args[0] === path ? reply : gh(args));

/** What of GitHub's reading of a subject a run may take as read: `unchanged(path)` is true when the run got a 304 for it, `forget(path)` drops the validator of a subject whose reading did not finish. */
const NO_VALIDATORS = { unchanged: (_path: string) => false, forget: (_path: string) => {} };

/** The repository a named subject lives in: the row repository unless the wake named another of the owner's. */
const repoOfNamed = ({ subject, rowRepo }: { subject: Named; rowRepo: string; }) => (subject.repo === null ? rowRepo : `${rowRepo.split("/")[0]}/${subject.repo}`);

/** The path of the record a subject's reading starts from, which is the key its validator is kept under: `pulls/N` for a pull request, `issues/N` for a row. */
const recordPathOf = ({ subject, rowRepo }: { subject: Named; rowRepo: string; }) => `repos/${repoOfNamed({ subject, rowRepo })}/${subject.isPull ? "pulls" : "issues"}/${subject.number}`;

/**
 * A ROW whose own record answers 304 and whose `filed` event the store holds has nothing new in its timeline: every event the store takes from it (a label, a claim comment, a close) moves the
 * issue's ETag, so its timeline read (51 of the 105 calls a map render spent on the subjects the wakes name, #4097) is skipped. A pull request is read whole: a check-run finishing moves no ETag of the pull request.
 */
function readNamed({ subject, rowRepo, gh, filedRows, validators }: { subject: Named; rowRepo: string; gh: (args: string[]) => any; filedRows: Set<number>; validators: typeof NO_VALIDATORS; }) {
  if (subject.isPull) return pullEventsOf({ pull: { number: subject.number, repo: repoOfNamed({ subject, rowRepo }) }, rowRepo, gh });
  const path = recordPathOf({ subject, rowRepo });
  const reply = gh([path]);
  if (validators.unchanged(path) && filedRows.has(subject.number)) return [];
  return readGithubEvents({ rows: [subject.number], prs: [], repo: rowRepo, gh: replaying({ path, reply, gh }) });
}

/**
 * What the aggregate reads of GitHub for the subjects the window's WAKES name: a repeat is `after a change` or `unchanged` only from the store's record of its row or pull request, and
 * `githubEventsOfMerged` reads only the merged ones, so a wake naming a row that is open, closed another way or closed in an earlier week had no record to read (349 of the 599 repeats of the
 * week of 2026-09-28, #3688). `held` is the store AFTER the merged reading was added to it: a subject it settles (see `settledIn`) is not read again, an OPEN one is read on every run because
 * its record grows. Oldest naming first, within the same budget, and it STOPS when `gh` refuses a call; what it did not reach is returned by name and stays `unexplained`, as does a key that names
 * none. A subject that cannot be read for another reason (a number GitHub does not know) is returned as `failed` with the message and the next one is tried: one key must not cost the week.
 */
export function githubEventsOfNamed({ held, since, rowRepo, gh, validators = NO_VALIDATORS }: { held: TraceEvent[]; since: number; rowRepo: string; gh: ReturnType<typeof budgetedGh>; validators?: typeof NO_VALIDATORS; }) {
  const settled = settledIn(held);
  const filedRows = new Set(held.flatMap((event) => (event.source === "github" && event.kind === "filed" && typeof event.row === "number" ? [event.row] : [])));
  const events: TraceEvent[] = [];
  const unread: string[] = [];
  const failed: { subject: string; message: string; }[] = [];
  for (const subject of namedByWakes(held, since).filter((named) => !settled.has(nameOf(named)))) {
    if (gh.stopped) {
      unread.push(nameOf(subject));
      continue;
    }
    try {
      events.push(...readNamed({ subject, rowRepo, gh, filedRows, validators }));
    } catch (error) {
      validators.forget(recordPathOf({ subject, rowRepo })); // read to the end or not at all: a validator kept for a half-read row would let the next run take it as read
      if (isSpent(error)) unread.push(nameOf(subject));
      else failed.push({ subject: nameOf(subject), message: String((error as Error).message) });
    }
  }
  return { events, unread, failed };
}

/** wakes-per-row's reading of each week, from the same pulls, so its counts are the ones the aggregate compares its own with. */
function wakesPerRowByWeek({ starts, pulls, rowRepo, claims, ledger, cache }: { starts: number[]; pulls: PullRequest[]; rowRepo: string; claims: Map<number, number>; ledger: LedgerEntry[]; cache: string; }) {
  const transcripts = readTranscripts(join(homedir(), ".claude", "projects"), starts[0]);
  const instances = readInstances(cache);
  const claimedAt = new Map([...claims].map(([row, at]) => [row, at as number | null]));
  const readings = new Map(starts.map((start) => [start, measure({ window: { from: start, to: start + WEEK_DAYS * MS_PER_DAY }, pulls, transcripts, ledger, instances, claimedAt, rowRepo }).rows]));
  return { readings, unreadable: transcripts.flatMap((transcript) => (transcript.ok ? [] : [transcript.file])) };
}

const STOP_LABEL: Record<string, string> = { floor: "FLOOR", budget: "BUDGET", failure: "GITHUB ERROR" };

/**
 * What a run says BEFORE its first call: the most it may spend, the pool it spends, how it paces itself and where it stops. Said first so that a person who started it knows what it will cost
 * without waiting for the end, which is where this used to be said.
 */
export function budgetLine({ budget, floor = RATE_FLOOR, gapMs = PACE_GAP_MS }: { budget: number; floor?: number; gapMs?: number; }) {
  const longest = Math.ceil((budget * gapMs) / MS_PER_SECOND);
  return `GitHub budget: at most ${budget} gh api calls, all on the REST "${REST_POOL}" pool (X-Ratelimit-Resource, checked on every reply; the search API is never called), at least ${gapMs} ms apart (${longest} s if all are spent), and it stops, saying so, when X-Ratelimit-Remaining falls under ${floor}`;
}

/**
 * What the GitHub reading cost and how it ended, for the footer. A stop is NAMED, because a run that stopped at the floor has not read the weeks it left PARTIAL.
 * `github.named`, when the run read the subjects the wakes name (`githubEventsOfNamed`), adds how many of them it did not reach and which it could not read: their repeats stay `unexplained`.
 */
export function githubSummary({ github, budget, unread }: { github: { calls: number; read: number; added: number; remaining: { first: number | null; last: number | null; }; stopped: { reason: string; message: string; } | null; named?: { unread: number; failed: { subject: string; message: string; }[]; }; }; budget: number; unread: number; }) {
  const { first, last } = github.remaining;
  const stop = github.stopped ? `; STOPPED AT THE ${STOP_LABEL[github.stopped.reason] ?? github.stopped.reason.toUpperCase()}: ${github.stopped.message}` : "";
  const { named } = github;
  const wakes = named ? `; subjects the wakes name, not yet read: ${named.unread}${named.failed.map(({ subject, message }) => `; could not read ${subject}: ${message}`).join("")}` : "";
  return `GitHub: ${github.calls} REST calls (gh api, pool ${REST_POOL}, budget ${budget}); X-Ratelimit-Remaining ${first ?? "unread"} at the first reply, ${last ?? "unread"} at the last; ${github.read} events read, ${github.added} new to the store; rows whose GitHub events are not yet read: ${unread}${wakes}${stop}`;
}

/**
 * What both reports read: the transcripts, the wake ledger and the `gh` call ledgers ingested into the store, the merged pull requests and open rows listed, and what GitHub saw of the merged rows
 * read into the store, within the call budget. `log` receives the budget line before anything is read.
 */
async function readSources({ since, storePath, budget, log }: { since: number; storePath: string; budget: number; log: (line: string) => void; }) {
  log(budgetLine({ budget }));
  const { homeProjectDeclaration } = await import("../project-config.ts");
  const declaration = homeProjectDeclaration();
  const rowRepo = declaration.tracker[0].repo;
  const cache = join(homedir(), ".cache", "a11ign");
  const now = Date.now();
  const ledger = parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8"));
  const { store, report: ingested } = ingestTranscripts({ root: join(homedir(), ".claude", "projects"), codexRoot: join(homedir(), ".codex", "sessions"), since, ledger, rowRepo, storePath, ghLedgers: ghLedgerFiles(), deferralLogs: [join(cache, DEFERRAL_LOG_FILE)], now });
  const validatorsDir = dirname(storePath);
  const heldValidators = readValidators(validatorsDir);
  const metered = meteredGhApi({ held: heldValidators, now });
  const gh = budgetedGh({ gh: metered, budget, floor: RATE_FLOOR, gapMs: PACE_GAP_MS });
  const { pulls, openRows } = readListings({ repos: declaration.code.map((code) => code.repo), rowRepo, window: { from: since, to: now }, gh, budget });
  const moves = readMoves({ rowRepo, gh }); // one counted call for each package that moved, BEFORE the long reading that can spend the budget: when its row closed
  const { events: seen, unreadRows } = githubEventsOfMerged({ pulls, rowRepo, held: store.events, gh });
  const addedOfMerged = appendToStore(store, seen).added;
  const named = githubEventsOfNamed({ held: store.events, since, rowRepo, gh, validators: metered.validators }); // after the merged reading is in the store: a subject it read is not read twice
  const addedOfNamed = appendToStore(store, named.events).added;
  saveValidators({ out: validatorsDir, held: heldValidators, now }); // AFTER the events are in the store: a validator is kept only for a reading the store already holds
  const github = { calls: gh.calls, read: seen.length + named.events.length, added: addedOfMerged + addedOfNamed, remaining: { first: metered.first?.remaining ?? null, last: metered.rate?.remaining ?? null }, stopped: gh.stopped, named: { unread: named.unread.length, failed: named.failed } };
  return { rowRepo, cache, now, ledger, store, ingested, pulls, openRows, unreadRows, github, moves };
}

async function mainAggregate() {
  const { since, store: storePath, json, budget } = parseAggregateArgs(process.argv.slice(2));
  const log = json ? console.error : console.log; // stdout of a `--json 1` run is the JSON and nothing before it
  const { rowRepo, cache, now, ledger, store, ingested, pulls, openRows, unreadRows, github, moves } = await readSources({ since, storePath, budget, log });
  const starts = Array.from({ length: Math.floor((weekStart(now) - since) / (WEEK_DAYS * MS_PER_DAY)) + 1 }, (_, week) => since + week * WEEK_DAYS * MS_PER_DAY);
  const { readings, unreadable } = wakesPerRowByWeek({ starts, pulls, rowRepo, claims: claimsOf(store.events), ledger, cache });
  const held = { from: ingested.firstRunSince, basis: `the ingest state's first run, ${new Date(ingested.firstRunAt).toISOString()}, over transcripts modified after that time` };
  const { HOME_CHECKOUT } = await import("../project-config.ts");
  const { paths: pullPaths, note } = readMergePaths({ checkout: HOME_CHECKOUT, rowRepo, since });
  const result = aggregate({ events: store.events, pulls, rowRepo, now, since, held, readings, unreadable: [...new Set([...ingested.failed, ...unreadable])], unreadRows, openRows, moves, pullPaths });
  console.log(json ? JSON.stringify(result, null, 2) : renderAggregate(result, { ingestFooter: ["", ...ingestLines(ingested), githubSummary({ github, budget, unread: unreadRows.length }), ...(note ? [note] : []), NOT_HELD] }));
}

async function mainMap() {
  const { since, store: storePath, out, budget, filter } = parseMapArgs(process.argv.slice(2));
  const { rowRepo, now, store, pulls, unreadRows, github } = await readSources({ since, storePath, budget, log: console.log });
  writeFileSync(out, buildMap({ events: repriceEvents(store.events), pulls, rowRepo, window: { from: since, to: now }, filter, generatedAt: now }));
  console.log(`wrote ${out}: the merged rows since ${new Date(since).toISOString()}; ${githubSummary({ github, budget, unread: unreadRows.length })}`);
}

/**
 * The time each package's move row closed (#3967), from the row itself: one counted call each. A stop of the budget leaves `at` null, printed `not held`, never a guess; any other failure is thrown.
 */
export function readMoves({ rowRepo, gh }: { rowRepo: string; gh: (args: string[]) => any; }): Move[] {
  return MOVES.map((move) => {
    try {
      const closedAt = gh([`repos/${rowRepo}/issues/${move.row}`]).closed_at;
      return { ...move, at: closedAt ? Date.parse(closedAt) : null };
    } catch (error) {
      if (isSpent(error)) return { ...move, at: null };
      throw new Error(`gh api repos/${rowRepo}/issues/${move.row}: could not read when the move closed`, { cause: error });
    }
  });
}

/** A pull request lands as a merge commit (`Merge pull request #n from ...`) or, in the early weeks of the history, as a squash commit whose subject ends `(#n)`. */
const MERGE_SUBJECT = /^Merge pull request #(\d+) |\(#(\d+)\)$/;

/**
 * The paths each merged pull request changed, from `git log --first-parent -m --name-only` text (the merge commit's difference from its first parent, which is the pull request's own change; a squash
 * commit's own). A commit whose subject names no pull request is not one's and is left out. Keys are `<repo>#<number>`, as the aggregate looks them up.
 * A commit that appears in more than one section (`-m` without `--first-parent` repeats a merge commit once per parent, the first parent's first) keeps its FIRST section: a later parent's diff
 * is not the pull request's change and must not replace it.
 * `text` is the output of `git log --format=@@%x09%H%x09%s`.
 */
export function parseMergePaths(text: string, rowRepo: string): Map<string, string[]> {
  const paths: Map<string, string[]> = new Map();
  const seen = new Set();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@\t")) {
      const [sha, ...subject] = line.slice("@@\t".length).split("\t");
      const found = MERGE_SUBJECT.exec(subject.join("\t"));
      const number = found?.[1] ?? found?.[2];
      current = number && !seen.has(sha) ? [] : null;
      seen.add(sha);
      if (number && current) paths.set(`${rowRepo}#${number}`, current);
    } else if (line.trim() && current) current.push(line.trim());
  }
  return paths;
}

/**
 * The paths of every pull request merged into the primary repository since `since`, read from the checkout's own `origin/main` (as last fetched, no `gh` call). `note` says why none was read.
 */
export function readMergePaths({ checkout, rowRepo, since }: { checkout: string; rowRepo: string; since: number; }): { paths: Map<string, string[]>; note: string | null; } {
  try {
    const text = execFileSync("git", ["-C", checkout, "log", "origin/main", "--first-parent", "-m", `--since=${new Date(since).toISOString()}`, "--format=@@%x09%H%x09%s", "--name-only"], { encoding: "utf8", maxBuffer: GH_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"], env: sandboxGitEnv() });
    return { paths: parseMergePaths(text, rowRepo), note: null };
  } catch (error) {
    return { paths: new Map(), note: `changed paths not read, so no row before a move is placed on a package: git -C ${checkout} log origin/main failed (${(error as Error).message.split("\n")[0]})` };
  }
}

/** The first turn after each wake needs the transcripts and the wake ledger and nothing from GitHub, so it makes no `gh` call. */
/**
 * `--html --out <path>`: one page, the swimlane of the row. A number that names several rows (a pull request closing two) writes one page per row, the row's number before the extension, so none overwrites another.
 */
export function writeSwimlanes({ out, subjects, now, github }: { out: string; subjects: { title: string; found: TraceEvent[]; }[]; now: number; github: { calls: number; read: number; added: number; }; }) {
  const several = subjects.length > 1;
  for (const { title, found } of subjects) {
    const path = several ? out.replace(/(\.html?)?$/, `-${title.replace(/\W+/g, "-")}$1`) : out;
    writeFileSync(path, swimlane({ events: found, now, title }));
    console.log(`wrote ${path}: the swimlane of ${title}, ${found.length} events; GitHub: ${github.calls} REST calls (gh api), ${github.added} events new to the store`);
  }
}

/**
 * `--ingest`: the store's clock (agent-org#498). Ingest and save the state, print the one-line report, render nothing and call no GitHub: the reading commands decide what is shown, and the
 * publisher's pull-request and row listings are not what keeps the store fresh.
 */
async function mainIngest() {
  const { since, store: storePath } = parseIngestArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.ts");
  const { report } = ingestHome({ since, storePath, rowRepo: homeProjectDeclaration().tracker[0].repo });
  for (const line of ingestSummary(report)) console.log(line);
  if (ingestFailures(report).length > 0) process.exitCode = 1;
}

/** `--freshness`: the store's newest turn against the clock, read from its tail; exit 1 when it is stale, so a unit or a person can act on the code. */
function mainFreshness() {
  const { store: storePath } = parseIngestArgs(process.argv.slice(2));
  const now = Date.now();
  const working = sessionsWorking({ roots: transcriptRoots(homedir()), now, windowMs: STALE_AFTER_MS });
  const reading = storeFreshness({ storePath, now, working });
  console.log(freshnessLine(reading));
  if (reading.stale) process.exitCode = 1;
}

async function mainWakeCache() {
  const { since, until, store: storePath, json } = parseWakeCacheArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.ts");
  const rowRepo = homeProjectDeclaration().tracker[0].repo;
  const now = Date.now();
  const ledger = parseLedger(readFileSync(join(homedir(), ".cache", "a11ign", "wake-ledger"), "utf8"));
  const { store, report: ingested } = ingestTranscripts({ root: join(homedir(), ".claude", "projects"), codexRoot: join(homedir(), ".codex", "sessions"), since, ledger, rowRepo, storePath, now });
  const report = wakeCache({ events: repriceEvents(store.events), window: { from: since, to: until } });
  console.log(json ? JSON.stringify(report, null, 2) : renderWakeCache(report, { footer: ["", ...ingestLines(ingested)] }));
}

async function main() {
  if (isIngest(process.argv.slice(2))) return mainIngest();
  if (isFreshness(process.argv.slice(2))) return mainFreshness();
  if (isAggregate(process.argv.slice(2))) return mainAggregate();
  if (isWakeCache(process.argv.slice(2))) return mainWakeCache();
  if (isMap(process.argv.slice(2))) return mainMap();
  const { number, since, store: storePath, json, html, out } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.ts");
  const rowRepo = homeProjectDeclaration().tracker[0].repo;
  const cache = join(homedir(), ".cache", "a11ign");
  const { store, report: ingested } = ingestTranscripts({ root: join(homedir(), ".claude", "projects"), codexRoot: join(homedir(), ".codex", "sessions"), since, ledger: parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8")), rowRepo, storePath, ghLedgers: ghLedgerFiles(), deferralLogs: [join(cache, DEFERRAL_LOG_FILE)] });
  const gh = countingGh(ghApi);
  const { rows, prs } = resolveSubject(number, rowRepo, gh);
  const seen = readGithubEvents({ rows, prs, repo: rowRepo, gh });
  const github = { calls: gh.calls, read: seen.length, added: appendToStore(store, seen).added };
  const events = eventsForRow(store.events, { rows, prs });
  const now = Date.now();
  if (html) return writeSwimlanes({ out: out as string, subjects: subjectsOf({ rows, prs, number, events }), now, github });
  console.log(json ? JSON.stringify({ number, rows, prs, github, waterfalls: waterfallsOf({ rows, prs, number, events, now }), events: repriceEvents(events) }, null, 2) : render({ number, rows, prs, events, ingest: ingested, github, held: store.events, now }));
}

/** A stop of the run (the budget, the floor, a GitHub error that outlasted its tries) is a report: its message, exit 1, no stack. */
async function mainOrReportStop() {
  try {
    await main();
  } catch (error) {
    if (!isSpent(error)) throw error;
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await mainOrReportStop();
