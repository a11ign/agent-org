import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountLimitLogPath } from "../account-limit.ts";
import { CLAIM_LABEL, CLAIM_RECORD_MARKER } from "../claim-labels.ts";
import { claudeTurns, codexTurns, transcriptFiles } from "../token-audit.ts";
import { parseFailureLedger } from "../failure-ledger.ts";
import { idleClaimIncidents, idleClaimedHours, type ClaimedRow, type HolderState, type IdleClaim, type IdleClaimIncident } from "../idle-claim-incident.ts";
import { WORKER_STATE_DIR, lastDeliveredTo, readDeclarations } from "../worker-state.ts";
import { IDLE_CLAIMANT_MS, type Agent, type IdlePr } from "../idle-claimant.ts";
import { lookupConsumerFile } from "../closes-mismatch-check.ts";
import { safetyCheckDenials, type SafetyCheckDenialReading } from "../safety-check-denial-incident.ts";
import { inertOptionIncidents, type InertOptionReading, type MergedOptionPr } from "../inert-option-incident.ts";
import { mergedRowOpenIncidents, type MergedRowOpenIncident, type NamingPr, type OpenRow } from "../merged-row-open-incident.ts";
import { readJsonObject, STALL_STATE_FILE, type StallState } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { newestPerName } from "../newest-check-run.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { readDora, READ_TIMEOUT_MS } from "../dora.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { rows } from "../plugins/rows.ts";
import { underspecifiedReading, underspecifiedStops, type UnderspecifiedReading } from "../spec-lint.ts";
import { commentsSince } from "../ticket-port/comments-since.ts";
import { readRowsByLabel } from "../ticket-port/rows-by-label.ts";
import { SHARED_FAILURE_LABEL } from "../ci-failure-class.ts";
import { asListJson, readMergedPullRequests, readRowsSince, type SinceRead, sincePageSize, WindowCutShort } from "../ticket-port/rows-since.ts";

/** The cause this file feeds (`cause-declaration.ts` declares it), addressed to `ceo`. */
export const RETRO_CAUSE = "org-retrospective";

/** What an unreadable source prints. Never `0`: "could not read" and "none" are different states and never share a value. */
export const UNKNOWN = "unknown";

/** The window every number covers. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MINUTES_PER_HOUR = 60;

/**
 * Minutes one tick stands for. The tick runs about every 2.1 minutes (`repeating-lines.ts` measured it), so 2 UNDERSTATES
 * idle time slightly: the figure is a floor, and a floor is the honest direction for "how long did the org sit idle".
 */
export const TICK_MINUTES = 2;

/** `journalctl`'s own `-o short-iso` line: `2026-10-01T23:14:05+01:00 host unit[pid]: message`. */
export const JOURNAL_LINE = /^(\d{4}-\d\d-\d\dT[\d:]+(?:[+-]\d\d:?\d\d|Z)) \S+ [^:]+: (.*)$/;
export const TICK_START = /^Starting a11ign-work-tick\.service/;
/** A ready row was offered and no engineer could take it: the org's idle capacity next to claimable work. */
export const IDLE_OFFER = /^(?:UNDELIVERED|DEFERRED) \S*\/?ready-row-unclaimed\//;
/** A claim the org took back from its holder. `merged` is the ordinary end of a row, every other reason is a claim that stopped. */
export const RELEASE = /^RELEASED #(\d+) \(([^,)]+), ([^)]+)\)/;

/** @param {number} ms @returns {string} the UTC date, `YYYY-MM-DD` */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** @param {number[]} numbers @returns {number | null} `null` for none, never `0` */
export function median(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {number} minutes @returns {string} `1h30m`, or `45m` under an hour */
export function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < MINUTES_PER_HOUR) return `${whole}m`;
  return `${Math.floor(whole / MINUTES_PER_HOUR)}h${String(whole % MINUTES_PER_HOUR).padStart(2, "0")}m`;
}

/**
 * Pull requests merged in the window and the median open-to-merge. `null` input is a refused read.
 * @param {{ number: number, createdAt: string, mergedAt: string }[] | null} merged
 * @param {{ since: number, until: number }} window
 * @returns {{ count: number, medianMinutes: number | null } | null}
 */
export function mergedStats(merged: { number: number; createdAt: string; mergedAt: string; }[] | null, { since, until }: { since: number; until: number; }): { count: number; medianMinutes: number | null; } | null {
  if (merged === null) return null;
  const inWindow = merged.filter((pr) => {
    const at = Date.parse(pr.mergedAt);
    return at >= since && at <= until;
  });
  const minutes = inWindow.map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / MS_PER_MINUTE);
  return { count: inWindow.length, medianMinutes: median(minutes) };
}

/**
 * The most merged PRs one repository's read may return. `gh` pages through them to reach it; the old read stopped at 200, which a multi-repository count
 * reaches in a day. A read that returns this many may have stopped short, so it is `unknown` and never a count that is quietly too low.
 */
export const MERGED_READ_LIMIT = 1000;

/** What a merged-list read says when the window did not fit {@link MERGED_READ_LIMIT}: the rows past it were not seen, so the count is `unknown` and `limitHit` says why. */
export const MERGED_LIMIT_HIT = "limit-hit";

/**
 * One repository's merged pull requests since `since`, as the connection gives them (#5076: `pr list -R repo --search merged:>=` was a GitHub SEARCH). `-R` NAMED the repository
 * because a read with none answers for the working directory's alone; the connection names it in its variables. {@link MERGED_LIMIT_HIT} for a window of more than the limit.
 * @param {string} repo @param {number} since @param {(args: string[]) => any} [read] the seam: parsed JSON, `null` when refused
 */
export function readMergedSince(repo: string, since: number, read: (args: string[]) => any = ghJson): any[] | null | typeof MERGED_LIMIT_HIT {
  try {
    return readMergedPullRequests({ repo, select: "number createdAt", run: runThrough(read), window: { since: new Date(since).toISOString(), maxPages: MERGED_READ_LIMIT / sincePageSize() } }) as any[];
  } catch (error) {
    return error instanceof WindowCutShort ? MERGED_LIMIT_HIT : null; // any other failure is `unknown`: a refused read, a payload that was not a connection
  }
}

/**
 * The connection readers take a `run` that answers text; this file's seam answers parsed JSON and `null` for a refusal, so the text is its re-serialisation and a refusal is a
 * THROW, the reader's own "could not read" (the cause is not narrated per read, as `ghJson` says).
 * @param {(args: string[]) => any} read @returns {(args: string[]) => string}
 */
const runThrough = (read: (args: string[]) => any) => (args: string[]): string => {
  const answer = read(args);
  if (answer === null) throw new Error("the read was refused");
  return JSON.stringify(answer);
};

/**
 * THE REPOSITORIES WHOSE MERGES ARE COUNTED: the project's primary plus every `dora` entry, the primary first and once (#3593). The primary leads because the
 * count before this change was its alone, and its entry is that old figure.
 * @param {{ repo: string, dora: { repo: string }[] }} declaration @returns {string[]}
 */
export function mergedPopulation({ repo, dora }: { repo: string; dora: { repo: string; }[]; }): string[] {
  return [...new Set([repo, ...dora.map((entry) => entry.repo)])];
}

/**
 * Every population repository's merged list since `since`. `prs` is `null` for one that could not be read, and `limitHit` says why when it was the limit.
 * @param {{ declaration: Parameters<typeof mergedPopulation>[0], since: number, readPrs?: (repo: string, since: number) => any[] | null }} input
 * @returns {{ repo: string, prs: any[] | null, limitHit: boolean }[]}
 */
export function readMerged({ declaration, since, readPrs = (repo, from) => readMergedSince(repo, from) }: { declaration: Parameters<typeof mergedPopulation>[0]; since: number; readPrs?: (repo: string, since: number) => any[] | null | typeof MERGED_LIMIT_HIT; }): { repo: string; prs: any[] | null; limitHit: boolean; }[] {
  return mergedPopulation(declaration).map((repo) => {
    const read = readPrs(repo, since);
    const limitHit = read === MERGED_LIMIT_HIT || (read !== null && read.length >= MERGED_READ_LIMIT);
    return { repo, prs: limitHit ? null : (read as any[] | null), limitHit };
  });
}

/** A stretch in which the Claude allowance held Claude work, clipped to the window it was read for. */
export type PausedInterval = { from: number; to: number; };

/**
 * THE CLAUDE PAUSE, read from `account-limit.ndjson`: one `enter` and one `leave` line each time the allowance is spent and resumed, and the pause
 * runs from an `enter` to the next `leave`. An `enter` with NO `leave` after it runs to `until`, the end of the window: the pause has not been said to end.
 * Clipped to the window, so a pause that began before it counts only from its start.
 * @param {string} text the log's text, which the caller has read
 * @param {{ since: number, until: number }} window
 * @returns {PausedInterval[] | null} `null` when a line does not parse: UNKNOWN, never "not paused"
 */
export function pausedIntervals(text: string, { since, until }: { since: number; until: number; }): PausedInterval[] | null {
  const spans: PausedInterval[] = [];
  let open: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: { kind?: unknown; at?: unknown; } | null;
    try { event = JSON.parse(line); } catch { return null; }
    const at = typeof event?.at === "string" ? Date.parse(event.at) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    if (event?.kind === "enter") open ??= at;
    else if (event?.kind === "leave") { if (open !== null) spans.push({ from: open, to: at }); open = null; }
    else return null;
  }
  if (open !== null) spans.push({ from: open, to: until });
  return spans.map(({ from, to }) => ({ from: Math.max(from, since), to: Math.min(to, until) })).filter(({ from, to }) => to > from);
}

/** The pause read for the window and the window before it: `null` when the log is unknown, and a share of 0 to 1 for each. */
export type PauseReading = { intervals: PausedInterval[]; current: number; previous: number; };

/** @param {PausedInterval[]} intervals @returns {number} the share of a window `WINDOW_MS` long that the intervals cover */
function pausedShare(intervals: PausedInterval[]): number {
  return intervals.reduce((sum, { from, to }) => sum + (to - from), 0) / WINDOW_MS;
}

/**
 * @param {string | null | undefined} text the log's text: `null` when it could not be read, `undefined` when nobody read it (both are unknown)
 * @returns {PauseReading | null}
 */
export function pauseOf(text: string | null | undefined, now: number): PauseReading | null {
  if (text === undefined || text === null) return null;
  const intervals = pausedIntervals(text, { since: now - WINDOW_MS, until: now });
  if (intervals === null) return null;
  const previous = pausedIntervals(text, { since: now - 2 * WINDOW_MS, until: now - WINDOW_MS }) ?? [];
  return { intervals, current: pausedShare(intervals), previous: pausedShare(previous) };
}

/**
 * `mergedRepositories` is the population PRs-merged counted (#3593); a reading without it counted the primary alone
 */
export type Reading = { date: string, numbers: Record<string, number | null>, mergedRepositories?: string[] };

// ---------------------------------------------------------------------------------------------------------------------
// The READS. Each returns `null` for a refused one and never throws; everything above is pure.

/**
 * THE RETRO READS (agent-org#1081): how many reads of each class this process made, and the seconds they took, for the one line each due tick prints. Counted where the
 * reads are MADE (`ghJson` for `pages` and `lists`, `readFileAt` for `contents`), so a test's fake is not counted. `resetRetroTally` starts a tick's count.
 */
export type ReadClass = "pages" | "lists" | "contents";
export const RETRO_TALLY: Record<ReadClass, { n: number; ms: number; }> = { pages: { n: 0, ms: 0 }, lists: { n: 0, ms: 0 }, contents: { n: 0, ms: 0 } };
function tallied<T>(kind: ReadClass, read: () => T): T {
  const began = performance.now();
  try {
    return read();
  } finally {
    RETRO_TALLY[kind].n += 1;
    RETRO_TALLY[kind].ms += performance.now() - began;
  }
}

/** @param {string[]} args @returns {any[] | null} */
export function ghJson(args: string[]): any[] | null {
  return tallied(args[0] === "api" && args[1] === "graphql" ? "pages" : "lists", () => {
    try {
      return JSON.parse(rows().runnerWith({ maxBuffer: 64 * 1024 * 1024, timeoutMs: READ_TIMEOUT_MS, echo: false })(args));
    } catch {
      return null; // a refused read is `unknown` in the report, which says so; the cause is not narrated per read, and a hung one is refused at the bound (#3736)
    }
  });
}

/** The refs of one kind a ledger text already holds; a ledger that is absent or does not parse holds none (`recordFailures` still skips a pair it can read). */
export function recordedRefs(ledger: string | null, kind: string): string[] {
  try { return parseFailureLedger(ledger ?? "").filter((entry) => entry.classKey === kind).map((entry) => entry.ref); } catch { return []; }
}

/** @template T @param {() => T} read @returns {T | null} `null` for a refused read (a declaration that will not parse included) */
export function attemptDora<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}

/** @param {number} now @returns {ReturnType<typeof readDora>} every repository the project declares, through the real readers */
export const readDeclaredDora = (now: number): ReturnType<typeof readDora> => readDora({ repositories: homeProjectDeclaration().dora, now });

/** Rows at or past this many are a list that may have been cut short, so it is refused, never a count quietly too low (`LIST_LIMIT`'s reason). */
const CLOSED_SHARED_ROWS_LIMIT = 500;

/**
 * The closed shared-failure rows as read, or `null` when they cannot be counted whole (agent-org#997). A row whose comments run past the first page has a closing
 * comment this read may not have seen, so the list is refused rather than counted as 0 for that row; so is a list at its ceiling.
 * @param {Record<string, unknown>[]} raw the rows as `readRowsByLabel` returned them, comments still in their connection shape
 * @returns {any[] | null}
 */
export function readableClosedSharedRows(raw: Record<string, unknown>[]): any[] | null {
  if (raw.length >= CLOSED_SHARED_ROWS_LIMIT) return null;
  const whole = raw.every((row) => {
    const comments = row.comments as { totalCount?: unknown; nodes?: unknown[]; } | null | undefined;
    return typeof comments?.totalCount === "number" && (comments.nodes?.length ?? 0) >= comments.totalCount;
  });
  return whole ? raw.map(asListJson) : null;
}

/**
 * THE CLOSED SHARED-FAILURE ROWS, each with its comments, for the "not the same failure" count (agent-org#997). `null` when the read is refused, or when the rows
 * cannot be read whole (`readableClosedSharedRows`). A refusal is `unknown` in the report, not 0.
 * @returns {any[] | null}
 */
export const readClosedSharedRows = (): any[] | null => {
  try {
    const raw = readRowsByLabel({ label: SHARED_FAILURE_LABEL, state: "CLOSED", repo: homeProjectDeclaration().repo,
      select: "number closedAt comments(first:100){totalCount nodes{body}}", run: runThrough(ghJson) });
    return readableClosedSharedRows(raw);
  } catch {
    return null; // a refused read is `unknown`, as `ghJson` says
  }
};

/** @param {string} path @returns {string | null} */
export function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * The Claude pause's log. NO FILE is `""`, which is "not paused": nothing has ever been entered. A file that is there and cannot be read (a directory
 * at its path included) is `null`, which is unknown and never "not paused".
 * @param {string} stateDir @returns {string | null}
 */
export function readAccountLimitLog(stateDir: string): string | null {
  const path = accountLimitLogPath(stateDir);
  return existsSync(path) ? readText(path) : "";
}

/**
 * Transcripts untouched since before the window cannot hold a turn inside it, so their (large) text is never parsed.
 * @param {string} root @param {number} since @returns {string[]}
 */
function recentTranscripts(root: string, since: number): string[] {
  return transcriptFiles(root).filter((file) => {
    try { return statSync(file).mtimeMs >= since; } catch { return false; }
  });
}

/** @param {number} since @returns {any[] | null} `null` only when NO transcript root could be listed at all */
export function readTurns(since: number): any[] | null {
  const home = process.env.HOME ?? "";
  const claudeRoot = join(home, ".claude", "projects");
  const codexRoot = join(home, ".codex", "sessions");
  try { readdirSync(claudeRoot); } catch { return null; }
  const turns = [];
  for (const file of recentTranscripts(claudeRoot, since)) {
    try { turns.push(...claudeTurns(readFileSync(file, "utf8"))); } catch { /* one unreadable transcript is skipped, the rest still count */ }
  }
  for (const file of recentTranscripts(codexRoot, since)) {
    try { turns.push(...codexTurns(readFileSync(file, "utf8"), "codex-reviewers")); } catch { /* as above */ }
  }
  return turns;
}

/**
 * THE LIVE READ OF THE SAFETY-CHECK DENIALS (a11ign#4957): every Claude transcript touched since `since`, through the pure `safetyCheckDenials`. `null` only when the transcript root
 * could not be listed at all; a transcript that cannot be read or parsed is counted in `unreadable` and contributes nothing. Codex transcripts are not read: the denial is Claude Code's.
 * @param {{ since: number, root?: string }} read @returns {SafetyCheckDenialReading | null}
 */
export function readSafetyCheckDenials({ since, root = join(process.env.HOME ?? "", ".claude", "projects") }: { since: number; root?: string; }): SafetyCheckDenialReading | null {
  try { readdirSync(root); } catch { return null; }
  const reading: SafetyCheckDenialReading = { incidents: [], unreadable: 0 };
  for (const file of recentTranscripts(root, since)) {
    let found: ReturnType<typeof safetyCheckDenials> = null;
    try { found = safetyCheckDenials({ text: readFileSync(file, "utf8"), file, since }); } catch { /* unreadable: counted below, never clean */ }
    if (found === null) reading.unreadable += 1; else reading.incidents.push(...found);
  }
  return reading;
}

/** @param {string} unit @returns {string | null} */
export function readJournal(unit: string): string | null {
  try {
    return execFileSync("journalctl", ["--user", "-u", unit, "--since", "-24h", "--no-pager", "-o", "short-iso"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const PR_RUNNING_STATUSES = ["IN_PROGRESS", "QUEUED", "PENDING"];

/** The gate's `checksPending` (`withChecksPending`): a check of the NEWEST run per name is still running. Restated, because this file is a leaf and `work-gate.ts` imports it. */
function checksPendingOf(pr: { statusCheckRollup?: { status?: string }[] }): boolean {
  return newestPerName((pr.statusCheckRollup ?? []) as any).some((c: any) => PR_RUNNING_STATUSES.includes(String(c?.status ?? "").toUpperCase()));
}

/**
 * WHEN A HOLDER'S IDLE RUN BEGAN, from what the gate remembers of it (`claim-stalls.json`, written every tick by `nextStallState`): an `idle-watch` entry carries `idleSince`; an
 * idle NUDGE carries only `nudgedAt`, sent when the run reached `IDLE_CLAIMANT_MS`, so the start is that long before it -- an ESTIMATE, and the short side (the run was at least that long).
 * Anything else (a stall nudge, a vacating row, no entry) is not an idle run, so `null`, which the detector reads as CANNOT TELL.
 */
function idleSinceOf(entry: StallState[string]): number | null {
  if (typeof entry.idleSince === "number") return entry.idleSince;
  return entry.idle === true && typeof entry.nudgedAt === "number" ? entry.nudgedAt - IDLE_CLAIMANT_MS : null;
}

/**
 * THE LIVE READ OF THE IDLE-CLAIM INCIDENTS (#4642): `null` when the open-PR list or the herdr listing could not be read (`unknown` in the report, never 0).
 * THE CLAIMS ARE THE GATE'S MEMORY, so a holder with a declared row wait is not among them (the gate drops its memory the tick it reads a wait; at most one tick stale).
 * A PULL REQUEST IS ATTRIBUTED TO A HOLDER BY ITS `session:` LABEL, as the gate does, so a session holding two rows credits its pull request to both: a quiet row of that
 * session can be hidden, never invented. The pure decision is `idle-claim-incident.ts`'s.
 * @param {{ now: number, stateDir: string, openPrs: any[] | null, agents: Agent[] | null }} reads
 */
export function readIdleClaims({ now, stateDir, openPrs, agents }: { now: number; stateDir: string; openPrs: any[] | null; agents: Agent[] | null; }): IdleClaimIncident[] | null {
  if (openPrs === null || agents === null) return null;
  const memory = readJsonObject(join(stateDir, STALL_STATE_FILE)) as StallState;
  const prsOf = (session: string): IdlePr[] => openPrs
    .filter((pr) => (pr.labels ?? []).some((l: any) => (typeof l === "string" ? l : l?.name) === `${SESSION_PREFIX}${session}`))
    .map((pr) => ({ number: pr.number, labels: pr.labels, reviewDecision: pr.reviewDecision, checksPending: checksPendingOf(pr) }));
  const claims: IdleClaim[] = Object.entries(memory).map(([row, entry]) => ({ row: Number(row), session: entry.session, idleSince: idleSinceOf(entry), prs: prsOf(entry.session) }));
  return idleClaimIncidents({ claims, agents, now });
}

/** How far back the merged pull requests are read (#4769): wider than the report's 24 hours, because a merge is not yet an incident when the pass that sees it first runs. */
export const MERGED_ROW_OPEN_LOOKBACK_MS = 7 * WINDOW_MS;
/** One list's ceiling: a list this long may have stopped short, so it is a refused read and never a count quietly too low (as `MERGED_READ_LIMIT`). */
const LIST_LIMIT = 1000;
const CLAIMED_BRANCH = /^Claimed-branch:\s*(.+)$/m;

/** @param {() => any[]} ask a list read of the code host's rows @returns {any[] | null} `null` for a refused list, a list at its ceiling included */
const listRead = (ask: () => any[]): any[] | null => {
  try {
    const list = ask();
    return list.length >= LIST_LIMIT ? null : list;
  } catch {
    return null;
  }
};

/** The branch the NEWEST claim-record comment names, or `null`: a row's record is re-written by a re-claim and the last one is who holds it. */
function claimedBranchOf(comments: { body?: string }[]): string | null {
  const bodies = comments.map((comment) => comment.body ?? "").filter((body) => body.includes(CLAIM_RECORD_MARKER));
  return bodies.reduce<string | null>((branch, body) => CLAIMED_BRANCH.exec(body)?.[1].trim() ?? branch, null);
}

/** An open row of one tracker. `claimedAt` is present only on a row carrying the claim label (#4957): the newest claim record's own time, `null` when it could not be dated. */
type TrackerRow = OpenRow & { claimedAt?: number | null; };

/**
 * One tracker's open rows carrying the claim label, each with its comments (the claim record is one): `repository.issues(labels:)`, a connection, because `--label` was sent
 * as a GitHub SEARCH (#5076). `null` when refused or when the list may be cut short, as {@link listRead} says.
 */
function readClaimedWithComments({ repo, read }: { repo: string; read: (args: string[]) => any; }): any[] | null {
  try {
    const rows = readRowsByLabel({ label: CLAIM_LABEL, state: "OPEN", repo, select: "number comments(first:100){nodes{body createdAt}}", run: runThrough(read) });
    return rows.length >= LIST_LIMIT ? null : rows.map(asListJson);
  } catch {
    return null; // a refused read is `unknown`, as `ghJson` says
  }
}

/** One tracker's open rows, each with its claim record's branch (and, for a claimed one, its claim's time). `null` when either list was refused. */
function readOpenRows({ repo, read }: { repo: string; read: (args: string[]) => any[] | null; }): TrackerRow[] | null {
  const open = listRead(() => rows().openRowLabelsOf({ repo, limit: LIST_LIMIT, run: runThrough(read) }));
  const claimed = readClaimedWithComments({ repo, read });
  if (open === null || claimed === null) return null;
  const claims = new Map<number, any[]>(claimed.map((row) => [row.number, row.comments ?? []]));
  return open.map((row) => ({ repo, number: row.number, labels: (row.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
    claimedBranch: claims.has(row.number) ? claimedBranchOf(claims.get(row.number)!) : null,
    ...(claims.has(row.number) ? { claimedAt: claimedAtOf(claims.get(row.number)!) } : {}) }));
}

/**
 * THE RETRO'S MEMORY OF ITS MERGED READS AND ACCEPTANCE FILES (agent-org#1081), kept in the state entry (`RETRO_READS_FILE`) by the gate's daily pass only.
 * `marks`: per `repo|select`, the merged rows the last walk left and the newest `updatedAt` it saw; a later walk reads only the pages above that mark.
 * `contents`: per `repo|path|oid`, an acceptance file's text AT ITS MERGE COMMIT, which cannot change, so it is read once. Open pull requests are never cached.
 * `walked`, `used` and `fullReads` belong to THIS tick: a key walked already reads no page, a key touched is kept, and a repository read in full is named in the line.
 */
type MergedMark = { updatedAt: string; rows: Record<string, unknown>[]; };
/**
 * `keep` is set by `readRetroReads` (the daily pass only) and writes the memory as it is read (agent-org#1089): a cut gate leaves what it read for the next tick.
 * `budget` is the class being read this tick, set by `readRetroClasses` and never by a manual run (`ClassBudget`).
 */
export type RetroReads = {
  marks: Record<string, MergedMark>; contents: Record<string, string>; unreadable: boolean;
  walked: Set<string>; used: Set<string>; fullReads: string[]; keep?: () => void; budget?: ClassBudget;
};

/**
 * A class's own budget this tick (agent-org#1089): `past()` is true once the tick has spent `RETRO_TICK_BUDGET_MS`. Each item the class reaches
 * (`acceptanceOf`, `readNamingPrs`) counts in `items`; an item it reaches past the budget is not read, counts in `refused`, and reads as `null` (`unknown`).
 */
export type ClassBudget = { past: () => boolean; items: number; refused: number; };

/** An empty memory: a manual run's (which writes nothing), a test's, and the one a tick starts from when the state entry is missing or unreadable. */
export function freshRetroReads({ unreadable = false }: { unreadable?: boolean; } = {}): RetroReads {
  return { marks: {}, contents: {}, unreadable, walked: new Set(), used: new Set(), fullReads: [] };
}

/**
 * The pull requests MERGED and UPDATED at or after `since`, newest update first, in `gh pr list --json` shape, with NO merge-time filter (agent-org#1081). A merged row
 * is updated when it merges, and again when its body or comments change, so a caller that keeps the rows it has and walks only the pages above its mark (the newest
 * `updatedAt` it saw) reads what changed, and a body edited after the merge is among those rows. The caller keeps the rows whose own time it means (`mergedAt`).
 * A window longer than `maxPages` THROWS, as `readRowsSince` does: the caller reads in full instead.
 */
function readMergedUpdatedSince({ repo, select, run, since, maxPages }: { repo: string; select: string; run: Parameters<typeof readRowsSince>[0]["run"]; since: string; maxPages?: number; }): Record<string, unknown>[] {
  const ask: SinceRead = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo, select: `${select} mergedAt`, since, ...(maxPages === undefined ? {} : { maxPages }) };
  return readRowsSince({ ask, run }).map(asListJson);
}

/**
 * One code repository's pull requests merged since `since`, with the fields `select` asks, WALKED ONLY ABOVE ITS MARK when there is one (agent-org#1081). The rows
 * a walk reads are merged into the mark's rows by number, so a row the walk saw again replaces its old self. A mark that is missing, unusable, or whose walk was longer than
 * its pages is read IN FULL, and the repository is named in `fullReads`. `null` when refused: then the mark does not move.
 */
function readMergedPrs({ repo, since, read, select, memory }: { repo: string; since: number; read: (args: string[]) => any[] | null; select: string; memory: RetroReads; }): any[] | null {
  const key = `${repo}|${select}`;
  memory.used.add(key);
  const mark = memory.marks[key];
  const marked = mark !== undefined && Number.isFinite(Date.parse(mark.updatedAt)) && Array.isArray(mark.rows);
  const walk = (from: string) => readMergedUpdatedSince({ repo, select, run: runThrough(read), since: from, maxPages: LIST_LIMIT / sincePageSize() }); // #5076: a connection read, not `--search merged:>=` (a GitHub SEARCH)
  try {
    if (marked && memory.walked.has(key)) return mark.rows.filter((row) => Date.parse(String(row.mergedAt)) >= since);
    let fresh: Record<string, unknown>[] | null = null;
    let base: Record<string, unknown>[] = [];
    if (marked) {
      try {
        fresh = walk(mark.updatedAt);
        base = mark.rows;
      } catch {
        fresh = null; // the walk above the mark was longer than its pages: read in full, as a missing mark is
      }
    }
    if (fresh === null) {
      memory.fullReads.push(repo);
      fresh = walk(new Date(since).toISOString());
    }
    const byNumber = new Map([...base, ...fresh].map((row) => [row.number, row]));
    const rows = [...byNumber.values()].filter((row) => Date.parse(String(row.mergedAt)) >= since);
    if (rows.length >= LIST_LIMIT) return null;
    const newest = fresh.reduce((max, row) => (String(row.updatedAt) > max ? String(row.updatedAt) : max), "");
    memory.marks[key] = { updatedAt: newest || (marked ? mark.updatedAt : new Date(since).toISOString()), rows: rows as Record<string, unknown>[] };
    memory.walked.add(key);
    memory.keep?.(); // a cut gate keeps this mark for the next tick (agent-org#1089)
    return rows;
  } catch {
    return null; // a refused read, or a window the pages did not hold, is `unknown`
  }
}

/** The GraphQL selection each merged-pull-request reader asks for: the naming read's (`readMergedRowOpen`) and the inert-option read's (`readInertOptions`: the files whose acceptance it reads, the commit they are read at, and the body it reads the switch row of). */
const NAMING_SELECT = "number body headRefName";
const INERT_SELECT = "number body mergeCommit{oid} files(first:100){nodes{path}}";

/**
 * One code repository's merged (since the look-back) and open pull requests, tagged with the repository. `null` when either list was refused.
 * THE MERGED SELECT IS `number body headRefName`: the one caller that reads it (`readMergedRowOpen`) reads the body and the branch, and no field else (#1081).
 * `readIdleClaimedHours` reads the open list only, for its labels, so the merged list is read for its refusal and nothing else.
 */
function readNamingPrs({ repo, since, read, memory }: { repo: string; since: number; read: (args: string[]) => any[] | null; memory: RetroReads; }): { merged: NamingPr[]; open: (NamingPr & { labels?: any[]; })[]; } | null {
  if (!admitItem(memory)) return null;
  const merged = readMergedPrs({ repo, since, read, select: NAMING_SELECT, memory });
  const open = listRead(() => rows().openPullsNamingRowsOf({ repo, limit: LIST_LIMIT, run: runThrough(read) }));
  if (merged === null || open === null) return null;
  return { merged: merged.map((pr) => ({ ...pr, repo })), open: open.map((pr) => ({ ...pr, repo })) };
}

/**
 * THE LIVE READ OF THE ROWS LEFT OPEN AFTER THEIR DELIVERABLE MERGED (#4769): every declared tracker's open rows against every declared code repository's merged and open
 * pull requests. `null` when ANY of those lists was refused (`unknown` in the report, never 0): a repository that could not be listed is a deliverable nobody could see.
 * The pure decision is `merged-row-open-incident.ts`'s. `read` is the seam (`ghJson` by default).
 * @param {{ now: number, declaration?: ReturnType<typeof homeProjectDeclaration>, read?: (args: string[]) => any[] | null }} reads
 */
export function readMergedRowOpen({ now, declaration = homeProjectDeclaration(), read = ghJson, memory = freshRetroReads() }: { now: number; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; memory?: RetroReads; }): MergedRowOpenIncident[] | null {
  const rowLists = declaration.tracker.map(({ repo }) => readOpenRows({ repo, read }));
  const prLists = declaration.code.map(({ repo }) => readNamingPrs({ repo, since: now - MERGED_ROW_OPEN_LOOKBACK_MS, read, memory }));
  if (rowLists.includes(null) || prLists.includes(null)) return null;
  const prs = prLists as NonNullable<ReturnType<typeof readNamingPrs>>[];
  return mergedRowOpenIncidents({ rows: (rowLists as OpenRow[][]).flat(), mergedPrs: prs.flatMap((p) => p.merged), openPrs: prs.flatMap((p) => p.open), now });
}

/** The path a pull request ADDED under `.acceptance/` (ADR 0044): the file CI reads, so a later body edit cannot change what it declared. */
const ACCEPTANCE_FILE = /^\.acceptance\/[A-Za-z0-9_.~-]+\.md$/;
const COMMIT_OID = /^[0-9a-f]{40}$/;

/**
 * One file AS THE MERGE LEFT IT: the contents API at the merge commit, so a later pull request that edits or deletes the acceptance file cannot change what an earlier one declared
 * (agent-org#938 review). It is `lookupConsumerFile`'s optional `ref`, so it adds no `gh` call site. `null` when the commit is absent or malformed, or the file could not be read.
 */
function readFileAt({ repo, path, oid, readFile }: { repo: string; path: string; oid: unknown; readFile: (repo: string, path: string, ref?: string) => string | null; }): string | null {
  return typeof oid === "string" && COMMIT_OID.test(oid) ? tallied("contents", () => readFile(repo, path, oid)) : null;
}

/**
 * ONE acceptance file of a merged pull request, from the memory when this merge commit's text is kept (agent-org#1081). A text is kept only when it was read, never a
 * refusal, so an unreadable file is read again next tick. The key is the merge commit, so a later pull request cannot change what is kept.
 */
function acceptanceOf({ repo, path, oid, readFile, readAcceptance, memory }: { repo: string; path: string; oid: unknown; readFile: (repo: string, path: string, ref?: string) => string | null; readAcceptance: typeof readFileAt; memory: RetroReads; }): string | null {
  const key = `${repo}|${path}|${String(oid)}`;
  memory.used.add(key);
  const cached = memory.contents[key];
  if (!admitItem(memory, { cached: cached !== undefined })) return null; // a text the memory holds costs no budget; a read past the budget is `unknown`
  if (cached !== undefined) return cached;
  const text = readAcceptance({ repo, path, oid, readFile });
  if (text !== null) {
    memory.contents[key] = text;
    memory.keep?.(); // kept as it is read: a gate cut before the next file keeps this one (agent-org#1089)
  }
  return text;
}

/**
 * ONE ITEM OF THE CLASS BEING READ (agent-org#1089): `false` once this tick's budget has passed, and the item is counted as refused. `cached` items are counted and admitted,
 * since a kept text is no read. Outside `readRetroClasses` there is no budget and every item is admitted.
 */
function admitItem(memory: RetroReads, { cached = false }: { cached?: boolean; } = {}): boolean {
  const budget = memory.budget;
  if (budget === undefined) return true;
  budget.items += 1;
  if (cached || !budget.past()) return true;
  budget.refused += 1;
  return false;
}

/**
 * THE LIVE READ OF THE OPTIONS A MERGED PULL REQUEST DECLARED AS A CONSUMER'S TO SET (agent-org#839): every declared code repository's merged pull requests of the look-back, each with the
 * text of the `.acceptance/` file it touched, against the consumer's file on its default branch. `null` when a list was refused (`unknown`, never 0). A pull request whose acceptance file
 * could not be read carries `acceptanceText: null`, which the leaf reports as unknown. The pure decision is `inert-option-incident.ts`'s. `read`, `readFile` (the consumer's file on its default branch) and `readAcceptance` (the acceptance file at the merge commit) are the seams (`ghJson` and
 * `lookupConsumerFile`, which is the one reader of a file's text the refusal already uses, so this adds no `gh` call site). `recorded` are the refs the ledger already holds.
 * @param {{ now: number, declaration?: ReturnType<typeof homeProjectDeclaration>, read?: (args: string[]) => any[] | null, readFile?: (repo: string, path: string) => string | null, recorded?: Iterable<string> }} reads
 */
export function readInertOptions({ now, declaration = homeProjectDeclaration(), read = ghJson, readFile = lookupConsumerFile, readAcceptance = readFileAt, recorded = [], memory = freshRetroReads() }: {
  now: number; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; readFile?: (repo: string, path: string, ref?: string) => string | null; readAcceptance?: typeof readFileAt; recorded?: Iterable<string>; memory?: RetroReads;
}): InertOptionReading | null {
  const lists = declaration.code.map(({ repo }) => ({ repo, merged: readMergedPrs({ repo, since: now - MERGED_ROW_OPEN_LOOKBACK_MS, read, select: INERT_SELECT, memory }) }));
  if (lists.some(({ merged }) => merged === null)) return null;
  const mergedPrs: MergedOptionPr[] = lists.flatMap(({ repo, merged }) => (merged as any[]).flatMap((pr): MergedOptionPr[] => {
    const paths: string[] = (pr.files ?? []).map((file: any) => String(file?.path)).filter((path: string) => ACCEPTANCE_FILE.test(path));
    if (paths.length === 0) return []; // no acceptance file added: nothing it declared can be read, and none is not unknown
    const texts = paths.map((path) => acceptanceOf({ repo, path, oid: pr.mergeCommit?.oid, readFile, readAcceptance, memory }));
    return [{ repo, number: pr.number, mergedAt: pr.mergedAt, body: pr.body, acceptanceText: texts.includes(null) ? null : texts.join("\n") }];
  }));
  return inertOptionIncidents({ mergedPrs, readConsumerFile: readFile, now, recorded });
}

export type IdleClaimedHours = ReturnType<typeof idleClaimedHours>;

/** The newest claim record's own time, or `null`: the clock of the claim a row's holder began (`claimedBranchOf`'s reading of the same comments). */
function claimedAtOf(comments: { body?: string; createdAt?: string; }[]): number | null {
  const at = comments.filter((c) => (c.body ?? "").includes(CLAIM_RECORD_MARKER)).map((c) => Date.parse(String(c.createdAt))).filter(Number.isFinite);
  return at.length === 0 ? null : Math.max(...at);
}

/**
 * THE LIVE READ OF WORKER-HOURS IDLE ON A CLAIMED ROW (#4957): every declared tracker's open claimed rows (the `session:` label names the holder, the claim record dates the
 * claim), every declared code repository's open pull requests by `session:` label, and the worker declarations and wake ledger of `stateDir`. IT SHARES `readOpenRows` AND
 * `readNamingPrs` WITH THE ROWS-LEFT-OPEN READ and adds no `gh` call site (`gh-call-ratchet.test.ts`). `null` when ANY list or the declarations could not be read (`unknown`,
 * never 0). The pure decision is `idle-claim-incident.ts`'s `idleClaimedHours`. `read` is the seam (`ghJson` by default).
 * @param {{ now: number, stateDir: string, declaration?: ReturnType<typeof homeProjectDeclaration>, read?: (args: string[]) => any[] | null }} reads
 */
export function readIdleClaimedHours({ now, stateDir, declaration = homeProjectDeclaration(), read = ghJson, memory = freshRetroReads() }: { now: number; stateDir: string; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; memory?: RetroReads; }): IdleClaimedHours | null {
  const rowLists = declaration.tracker.map(({ repo }) => readOpenRows({ repo, read }));
  const prLists = declaration.code.map(({ repo }) => readNamingPrs({ repo, since: now - MERGED_ROW_OPEN_LOOKBACK_MS, read, memory }));
  const declarations = readDeclarations(join(stateDir, WORKER_STATE_DIR));
  if (rowLists.includes(null) || prLists.includes(null) || declarations === null) return null;
  const sessionsOf = (labels: any[] | undefined): string[] => (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n) => typeof n === "string" && n.startsWith(SESSION_PREFIX)).map((n: string) => n.slice(SESSION_PREFIX.length));
  const claims: ClaimedRow[] = (rowLists as TrackerRow[][]).flat().flatMap((row) => {
    const sessions = sessionsOf(row.labels);
    return row.claimedAt !== undefined && sessions.length === 1 ? [{ repo: row.repo, row: row.number, session: sessions[0], claimedAt: row.claimedAt }] : [];
  });
  const ledger = readText(`${stateDir}/wake-ledger`) ?? "";
  const holders = new Map<string, HolderState>([...new Set(claims.map((c) => c.session))].map((session) => [session,
    { declaredAt: declarations.byClaimant.get(session)?.at ?? null, turnStartedAt: lastDeliveredTo(ledger, session) }]));
  const sessionsWithPr = new Set((prLists as NonNullable<ReturnType<typeof readNamingPrs>>[]).flatMap((p) => p.open).flatMap((pr) => sessionsOf(pr.labels)));
  // the pause is read here, so the claimed span is net of it; an unreadable log counts the span whole and the report's pause line says `unknown`
  const paused = pauseOf(readAccountLimitLog(stateDir), now)?.intervals ?? [];
  return idleClaimedHours({ claims, sessionsWithPr, holders, since: now - WINDOW_MS, now, paused });
}

/**
 * THE "UNDERSPECIFIED" STOPS BY FIELD (a11ign#5117): every declared tracker's issue comments since the window opened, in ONE paginated call each
 * (`commentsSince`, in the port's directory so this file gains no `gh` call), and the lines `Underspecified: <field>` in them (`underspecifiedStops`).
 * `null` when ANY tracker's list was refused (`unknown`, never 0). `read` is the seam (`ghJson` by default).
 */
export function readUnderspecified({ now, declaration = homeProjectDeclaration(), read = ghJson }: { now: number; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; }): UnderspecifiedReading | null {
  const since = now - WINDOW_MS;
  const lists = declaration.tracker.map(({ repo }) => commentsSince({ repo, since, run: read }));
  if (lists.includes(null)) return null;
  return underspecifiedReading(underspecifiedStops(lists.flat(), { since, until: now }));
}
