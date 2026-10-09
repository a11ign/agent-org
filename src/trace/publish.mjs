// a11ign/a11ign#3515: the trace pages, regenerated after each merge and at least hourly, into ONE directory that `tailscale serve` publishes to the tailnet and
// nowhere else (the chairman's order on #3494, 2026-10-04: "regenerates both pages after each merge into a directory on the agents host ... nothing goes public").
//
//   node src/trace/publish.mjs [--out <dir>] [--max-age-minutes <n>] [--recent <n>] [--row <n>]... [--calls <n>]
//
// `--row` names a row OR a pull request (`trace`'s own subject: a pull request draws the row it closes, so the page is titled by that row); one that closes SEVERAL rows is refused loudly, because
// `trace` then writes a page per row at other paths and the one expected is not there.
//
// THE TRIGGER IS A TIMER THAT ASKS A QUESTION, NOT A CALL IN THE GATE'S TICK. The tick is a model-free script that must stay short (#3566 is cutting it down), the pages take
// minutes the first time, and a timer fires on the clock whether or not a session is awake. So `trace-publish.timer` runs this every ten minutes and this DECIDES: it reads the head of
// `main` in every code repository the project declares (one REST call each), compares them with the heads it stamped at its last publication, and regenerates only when one moved
// or the stamp is older than `--max-age-minutes` (the "at least hourly otherwise"). A run that finds neither does nothing and says so, which is what keeps a ten-minute clock from
// being a regeneration loop. A merge reaches the pages within one tick; a head that moved is any merge, because `main` is only reached by merging.
//
// WHAT IS DRAWN: the across-rows process map over the last seven days, and the swimlane of the most recently CLOSED rows of the tracker repository, closed in those seven days (`--recent`, plus any `--row`
// named), because a swimlane is per row and the chairman looks at a row that has just finished. An `index.html` links them and says what the publication was read at.
//
// WHAT IS ASKED OF GITHUB IS ASKED LESS (a11ign/a11ign#4077, #4055 move 11). The head of `main` of each repository is a conditional GET: the ETag GitHub sent is kept beside the pages (`.validators.json`) with the sha it
// belonged to, and the next run sends it as `If-None-Match`; a 304 is answered from the kept sha, and GitHub does not charge a 304 to the primary rate limit (its documentation says so; it is not measured here). The
// closed-rows list is NOT conditional, because MEASURED 2026-10-08 its ETag does not survive three minutes (the same page, the same content, a different ETag: 13 of 13 pages came back 200); it is read newest-UPDATED
// first and STOPS as soon as no unread issue can change the answer (see `recentClosedRows`), which is one page where it was thirteen. A row's swimlane is redrawn only when its issue's `updated_at` moved since the page was
// drawn (or the page is a day old), because the closed rows that fill it change rarely and each redraw is about eighteen `gh` calls inside `trace`. THE SAFE DIRECTION OF EVERY DOUBT IS TO ASK AGAIN: a missing, corrupt or
// ill-shaped store sends no validator, an unreadable stamp redraws every page, and a row whose input is unknown (a `--row` that is not in the recent set) is always redrawn. The map is NOT skipped on an unchanged GitHub:
// it is drawn from the local store too, which no validator can vouch for.
//
// A FAILURE IS AN ERROR, NEVER AN EMPTY DIRECTORY. Every page is rendered into a staging directory first and checked to exist and to be non-empty; what succeeded is moved into
// place, what failed is listed, the stamp is NOT written (so the next tick retries), and the process exits non-zero, so the unit shows FAILED. Nothing here catches a write error
// and carries on: the one `catch` that does carry on collects a renderer's failure so the other pages still publish, and it rethrows them all at the end.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { esc } from "./swimlane.mjs";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
export const DEFAULT_MAX_AGE_MINUTES = 60;
export const DEFAULT_RECENT_ROWS = 6;
export const MAP_WINDOW_DAYS = 7;
const DEFAULT_MAP_CALLS = 300; // a fifth of `trace`'s own default: the pool is the whole org's, an unread row is counted on the page, and the next run continues where this one stopped
const CLOSED_ROWS_PAGE = 100;
export const CLOSED_ROWS_MAX_PAGES = 30;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 30 * MS_PER_MINUTE;
export const STAMP_FILE = ".published.json";
export const VALIDATORS_FILE = ".validators.json";
/** How long a row's page is trusted on its issue's `updated_at` alone: what the stamp cannot see (the local store, the sliding seven-day window `trace` is given) is bounded by redrawing a day later. */
export const ROW_PAGE_MAX_AGE_MS = MS_PER_DAY;
/** A validator unused this long is dropped, so the `since` of every earlier day does not stay in the store for good. */
const VALIDATOR_KEEP_MS = 2 * MS_PER_DAY;
const HTTP_NOT_MODIFIED = 304;
const HTTP_ERROR_FROM = 400;
export const MAP_PAGE = "map.html";
const ROW_PAGE = /^row-(\d+)\.html$/;
const TRACE = join(dirname(fileURLToPath(import.meta.url)), "trace.mjs");

/** The directory the host serves: beside the store (`~/.cache/a11ign/trace/`), under the home the unit declares. */
export const defaultOut = () => join(homedir(), ".cache", "a11ign", "trace-pages");

/**
 * @param {string[]} argv
 * @returns {{ out: string, maxAgeMs: number, recent: number, rows: number[], calls: number }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string[]>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) (flags[argv[index].replace(/^--/, "")] ??= []).push(argv[index + 1]);
  const whole = (/** @type {string} */ name, /** @type {number} */ fallback) => {
    const value = flags[name] === undefined ? fallback : Number(flags[name][0]);
    if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number (got ${flags[name]?.[0]})`);
    return value;
  };
  const known = ["out", "max-age-minutes", "recent", "row", "calls"];
  const stray = Object.keys(flags).filter((name) => !known.includes(name));
  if (stray.length > 0) throw new Error(`unknown flag --${stray[0]}. usage: publish [--out <dir>] [--max-age-minutes <n>] [--recent <n>] [--row <n>]... [--calls <n>]`);
  return {
    out: flags.out?.[0] ?? defaultOut(),
    maxAgeMs: whole("max-age-minutes", DEFAULT_MAX_AGE_MINUTES) * MS_PER_MINUTE,
    recent: whole("recent", DEFAULT_RECENT_ROWS),
    rows: (flags.row ?? []).map(Number).filter((row) => Number.isInteger(row) && row > 0),
    calls: whole("calls", DEFAULT_MAP_CALLS),
  };
}

/**
 * @typedef {{ input: string, at: number }} DrawnRow what a row's page was drawn FROM (its issue's `updated_at`) and when
 * @typedef {{ at: number, heads: Record<string, string>, rows: Record<string, DrawnRow> }} Stamp
 */

/** A stamp's rows, or none: a stamp from before row pages were remembered has no `rows`, and none means every row is drawn again. @param {any} rows @returns {Record<string, DrawnRow>} */
const stampedRows = (rows) => Object.fromEntries(Object.entries(rows ?? {}).filter(([, row]) => typeof row?.input === "string" && Number.isFinite(row.at)));

/** The stamp of the last COMPLETE publication. Absent is `null`; unreadable is also `null`, on purpose: the safe direction of "I cannot tell" is to regenerate. @param {string} out @returns {Stamp | null} */
export function readStamp(out) {
  const path = join(out, STAMP_FILE);
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    return Number.isFinite(stamp.at) && typeof stamp.heads === "object" && stamp.heads !== null ? { at: stamp.at, heads: stamp.heads, rows: stampedRows(stamp.rows) } : null;
  } catch (cause) {
    console.error(`publish: ${path} is unreadable (${/** @type {Error} */ (cause).message}); regenerating`);
    return null;
  }
}

/**
 * WHY a run must regenerate, or `null` when it must not. A moved head names the repository, so a log line says which merge started it.
 * @param {{ heads: Record<string, string>, stamp: Stamp | null, now: number, maxAgeMs: number }} input
 * @returns {string | null}
 */
export function whyRun({ heads, stamp, now, maxAgeMs }) {
  if (stamp === null) return "no earlier publication is stamped";
  const moved = Object.keys(heads).filter((repo) => stamp.heads[repo] !== heads[repo]);
  if (moved.length > 0) return `main moved in ${moved.join(", ")}`;
  if (now - stamp.at >= maxAgeMs) return `the last publication is ${Math.round((now - stamp.at) / MS_PER_MINUTE)} minutes old (at most ${Math.round(maxAgeMs / MS_PER_MINUTE)})`;
  return null;
}

/** @param {{ generatedAt: number, reason: string, heads: Record<string, string>, pages: { file: string, label: string }[], failed: string[] }} input */
export function indexPage({ generatedAt, reason, heads, pages, failed }) {
  const item = ({ file, label }) => `<li><a href="${esc(file)}">${esc(label)}</a></li>`;
  const head = ([repo, sha]) => `<li>${esc(repo)} <code>${esc(sha.slice(0, 9))}</code></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trace pages</title></head>
<body><h1>Trace pages</h1>
<p>Regenerated ${esc(new Date(generatedAt).toISOString())} because ${esc(reason)}.</p>
<ul>${pages.map(item).join("")}</ul>
${failed.length > 0 ? `<h2>Not regenerated</h2><ul>${failed.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
<h2>Read at</h2><ul>${Object.entries(heads).map(head).join("")}</ul>
</body></html>
`;
}

/** A page that is on disk and not empty: a renderer that exits 0 having written nothing is the empty directory this module exists to refuse. @param {string} path */
const written = (path) => existsSync(path) && statSync(path).size > 0;

/** @typedef {{ row: number, input: string | null }} WantedRow a row page to draw, and what it is drawn from; `null` is "unknown", which is always drawn again */

/**
 * Whether the page already in `out` still says what a fresh render would: the SAME input as when it was drawn, drawn under a day ago, and on disk and not empty. Every doubt is a render.
 * @param {{ wanted: WantedRow, stamp: Stamp | null, out: string, now: number }} input
 */
export function pageStillHolds({ wanted: { row, input }, stamp, out, now }) {
  const drawn = stamp?.rows[row];
  return input !== null && drawn !== undefined && drawn.input === input && now - drawn.at >= 0 && now - drawn.at < ROW_PAGE_MAX_AGE_MS && written(join(out, `row-${row}.html`));
}

/**
 * Render every page into `staging`; what succeeded is returned, what failed is returned apart, and NOTHING is thrown here so one broken row does not hold back the others. A row in `held` is not
 * rendered: its page is already in place, and it is listed as `held` so it is neither moved nor retired.
 * @param {{ staging: string, rows: number[], held: Set<number>, render: (page: { kind: "map" | "row", row?: number, out: string }) => void }} input
 */
function renderAll({ staging, rows, held, render }) {
  const wanted = [{ file: MAP_PAGE, label: "Process map: merged rows, last seven days", page: { kind: /** @type {const} */ ("map"), out: join(staging, MAP_PAGE) } },
    ...rows.map((row) => ({ file: `row-${row}.html`, label: `Swimlane: #${row}`, page: { kind: /** @type {const} */ ("row"), row, out: join(staging, `row-${row}.html`) } }))];
  /** @type {{ file: string, label: string, held: boolean }[]} */
  const pages = [];
  const failed = [];
  for (const { file, label, page } of wanted) {
    if (page.row !== undefined && held.has(page.row)) {
      pages.push({ file, label, held: true });
      continue;
    }
    try {
      render(page);
      if (!written(page.out)) throw new Error("the renderer returned without writing the page");
      pages.push({ file, label, held: false });
    } catch (cause) {
      failed.push(`${file}: ${String(/** @type {Error} */ (cause).message).split("\n")[0]}`);
    }
  }
  return { pages, failed };
}

/** Row pages in `out` that this publication no longer draws, so the directory does not grow without bound. @param {string} out @param {string[]} keep */
function retire(out, keep) {
  for (const name of readdirSync(out)) if (ROW_PAGE.test(name) && !keep.includes(name)) rmSync(join(out, name));
}

/**
 * The rows a stamp remembers: each row page that is in place and has an input, with the time it was DRAWN (a held page keeps its old time, so the day's bound is on the drawing and not on the last look).
 * @param {{ wanted: WantedRow[], pages: { file: string, held: boolean }[], stamp: Stamp | null, now: number }} input
 * @returns {Record<string, DrawnRow>}
 */
function rowsToStamp({ wanted, pages, stamp, now }) {
  const placed = new Map(pages.map(({ file, held }) => [file, held]));
  const kept = wanted.filter(({ row, input }) => input !== null && placed.has(`row-${row}.html`));
  return Object.fromEntries(kept.map(({ row, input }) => [row, { input: /** @type {string} */ (input), at: placed.get(`row-${row}.html`) ? /** @type {DrawnRow} */ (stamp?.rows[row]).at : now }]));
}

/**
 * One run: decide, render, move into place, stamp. Returns `{ ran: false }` when nothing moved and the stamp is fresh; THROWS when a head cannot be read, a write fails, or any page failed.
 * @param {{ out: string, repos: string[], rows: () => WantedRow[], readHead: (repo: string) => string, render: (page: { kind: "map" | "row", row?: number, out: string }) => void, now: number, maxAgeMs: number }} input
 * @returns {{ ran: boolean, reason: string | null, pages: string[], held: string[] }}
 */
export function publish({ out, repos, rows, readHead, render, now, maxAgeMs }) {
  const heads = Object.fromEntries(repos.map((repo) => [repo, readHead(repo)]));
  const stamp = readStamp(out);
  const reason = whyRun({ heads, stamp, now, maxAgeMs });
  if (reason === null) return { ran: false, reason, pages: [], held: [] };
  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(out, ".staging-"));
  try {
    const wanted = rows();
    const held = new Set(wanted.filter((one) => pageStillHolds({ wanted: one, stamp, out, now })).map(({ row }) => row));
    const { pages, failed } = renderAll({ staging, rows: wanted.map(({ row }) => row), held, render });
    for (const { file, held: inPlace } of pages) if (!inPlace) renameSync(join(staging, file), join(out, file));
    retire(out, pages.map(({ file }) => file));
    const index = join(staging, "index.html");
    writeFileSync(index, indexPage({ generatedAt: now, reason, heads, pages, failed }));
    renameSync(index, join(out, "index.html"));
    if (failed.length > 0) throw new Error(`${failed.length} of ${failed.length + pages.length} pages were not regenerated (the others are published, no stamp is written so the next run retries):\n${failed.join("\n")}`);
    writeFileSync(join(staging, STAMP_FILE), JSON.stringify({ at: now, heads, rows: rowsToStamp({ wanted, pages, stamp, now }) }));
    renameSync(join(staging, STAMP_FILE), join(out, STAMP_FILE));
    return { ran: true, reason, pages: pages.map(({ file }) => file), held: pages.filter(({ held: inPlace }) => inPlace).map(({ file }) => file) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** @typedef {{ etag: string, value: any, used: number }} Validated the reduced answer GitHub gave, the ETag it came with, and when it was last used */
/** @typedef {{ status: number, etag: string | null, body: any }} Reply */
/** @typedef {(path: string, etag: string | null) => Reply} Ask one GET of `path`, conditional when an ETag is given. A 304 has `body` null; a failure THROWS. */

/**
 * What a `gh api -i` reply says: its status, its ETag, its parsed body. The status line is what is read and the exit code is not, because `gh` exits 1 on a 304 (`gh: HTTP 304`) and on a failure alike. A 304 returns the ETag
 * that was sent (`sent`), which is the one still true. A failure THROWS, naming `path` and the last line `gh` said.
 * @param {{ stdout: string, stderr: string, path: string, sent: string | null }} input
 * @returns {Reply}
 */
export function parseReply({ stdout, stderr, path, sent }) {
  const [head, ...rest] = stdout.split(/\r?\n\r?\n/);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(head)?.[1] ?? Number.NaN);
  if (Number.isNaN(status) || status >= HTTP_ERROR_FROM) throw new Error(`gh api ${path}: ${(stderr || head || "no reply").trim().split("\n").pop()}`);
  if (status === HTTP_NOT_MODIFIED) return { status, etag: sent, body: null };
  return { status, etag: /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null, body: JSON.parse(rest.join("\n\n")) };
}

/**
 * `gh api -i <path>`, with `If-None-Match` when `etag` is given. THE `-H` COMES FIRST on a conditional call because the `gh` ledger keeps the first two words of a command (`api -H`), which is what lets the trace store
 * count the conditional reads apart from the unconditional ones (`api -i`, and the ledger's `script` says `publish.mjs`).
 * @type {Ask}
 */
export function ghAsk(path, etag) {
  const ran = spawnSync("gh", ["api", ...(etag === null ? [] : ["-H", `If-None-Match: ${etag}`]), "-i", path], { encoding: "utf8", maxBuffer: GH_MAX_BUFFER });
  if (ran.error) throw new Error(`gh api ${path}: ${ran.error.message}`);
  return parseReply({ stdout: ran.stdout, stderr: ran.stderr, path, sent: etag });
}

/**
 * The kept validators. Absent, unreadable or ill-shaped is NONE, on purpose and said on stderr when it was there: a request that carries no validator is an ordinary request, so the worst a bad store does is cost the calls it would have saved.
 * @param {string} out @returns {Record<string, Validated>}
 */
export function readValidators(out) {
  const path = join(out, VALIDATORS_FILE);
  if (!existsSync(path)) return {};
  try {
    const held = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(Object.entries(held).filter(([, one]) => typeof one?.etag === "string" && one.value !== undefined && Number.isFinite(one.used)));
  } catch (cause) {
    console.error(`publish: ${path} is unreadable (${/** @type {Error} */ (cause).message}); asking GitHub without validators`);
    return {};
  }
}

/**
 * GETs that send the ETag they were last given and answer a 304 from the value kept with it. `read` takes the path and `reduce`, which turns a body into the small thing worth keeping (a head's sha, a list page's four fields), so the
 * store is not a copy of GitHub.
 * @param {{ held: Record<string, Validated>, ask: Ask, now: number }} input
 */
export function conditionalReader({ held, ask, now }) {
  const reads = { asked: 0, notModified: 0 };
  const read = (/** @type {string} */ path, /** @type {(body: any) => any} */ reduce) => {
    const kept = held[path];
    const reply = ask(path, kept ? kept.etag : null);
    reads.asked += 1;
    if (reply.status === HTTP_NOT_MODIFIED) {
      if (!kept) throw new Error(`gh api ${path}: HTTP 304 to a request that carried no validator, so there is no kept answer to return`);
      reads.notModified += 1;
      kept.used = now;
      return kept.value;
    }
    const value = reduce(reply.body);
    if (reply.etag === null) delete held[path];
    else held[path] = { etag: reply.etag, value, used: now };
    return value;
  };
  /** A read that sends no validator and keeps none, counted with the rest: the list, whose ETag does not hold. */
  const readFresh = (/** @type {string} */ path, /** @type {(body: any) => any} */ reduce) => {
    reads.asked += 1;
    return reduce(ask(path, null).body);
  };
  return { read, readFresh, reads };
}

/**
 * Write the validators beside the pages: a temporary file and a rename, so a run killed mid-write leaves the old store and not half of one. Entries unused for two days are left out.
 * @param {{ out: string, held: Record<string, Validated>, now: number }} input
 */
export function saveValidators({ out, held, now }) {
  const kept = Object.fromEntries(Object.entries(held).filter(([, one]) => now - one.used < VALIDATOR_KEEP_MS));
  const path = join(out, VALIDATORS_FILE);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(kept));
  renameSync(`${path}.tmp`, path);
}

/** @typedef {ReturnType<typeof conditionalReader>["read"]} Read */

/** The head of `main` in `repo`, kept as its sha. @param {Read} read @returns {(repo: string) => string} */
export const headReader = (read) => (repo) => read(`repos/${repo}/branches/main`, (branch) => branch.commit.sha);

/** What of an issue the closed-rows list needs, and so what is kept: a page of 100 issues is not. @param {any} reply @param {string} path */
function listedIssues(reply, path) {
  if (!Array.isArray(reply)) throw new Error(`gh api ${path}: the reply carried no list where one was expected`);
  return reply.map((issue) => ({ number: issue.number, closed_at: issue.closed_at, updated_at: issue.updated_at, pull_request: issue.pull_request !== undefined }));
}

/**
 * The rows CLOSED most recently in `repo`, newest closing first, each with the `updated_at` its page is drawn from: closed issues that are not pull requests, closed on or after `since`. This is the REST issues list on the `core` pool; the
 * search API it replaces (30 calls a minute per user) is not used (a11ign/a11ign#3695).
 *
 * THE LIST IS READ NEWEST-UPDATED FIRST AND STOPPED EARLY (#4077). An issue closed at T was updated at or after T, so `closed_at <= updated_at`; once `count` qualifying rows are in hand and the page just read ends on an issue updated
 * BEFORE the `count`-th newest closing, every issue not yet read was updated earlier still and so closed earlier still, and cannot displace one. MEASURED 2026-10-08 against the tracker repository: one page of 100, where creation order
 * (the order this read in before, for the reason that a comment cannot move an issue between two pages) needed 13, and the same six rows. The record issue (#928, closed 2026-09-12) is commented on all day and so heads this list; `closed_at` keeps it
 * out of the answer and it costs only its place on a page. A list not finished, or not provably finished, in CLOSED_ROWS_MAX_PAGES is REFUSED, not cut short, because a swimlane missing its newest row prints as a quieter week.
 * @param {string} repo @param {number} count @param {number} since ms @param {ReturnType<typeof conditionalReader>["readFresh"]} readFresh
 * @returns {WantedRow[]}
 */
export function recentClosedRows(repo, count, since, readFresh) {
  if (count === 0) return [];
  const closed = [];
  for (let page = 1; page <= CLOSED_ROWS_MAX_PAGES; page += 1) {
    const path = `repos/${repo}/issues?state=closed&since=${new Date(since).toISOString()}&sort=updated&direction=desc&per_page=${CLOSED_ROWS_PAGE}&page=${page}`;
    const listed = readFresh(path, (reply) => listedIssues(reply, path));
    closed.push(...closedSince(listed, since));
    if (listed.length < CLOSED_ROWS_PAGE || nothingUnreadCanDisplace({ closed, count, lastUpdated: listed[listed.length - 1].updated_at })) {
      return newestFirst(closed).slice(0, count).map((issue) => ({ row: issue.number, input: issue.updated_at ?? null }));
    }
  }
  throw new Error(`${repo} has more than ${CLOSED_ROWS_MAX_PAGES * CLOSED_ROWS_PAGE} issues closed and updated since ${new Date(since).toISOString()}; a list cut short could miss the newest rows, so narrow the window`);
}

/** Whether the `count`-th newest closing in `closed` is later than the last issue read was updated, so that nothing further down a newest-updated list can be closed later than it. @param {{ closed: any[], count: number, lastUpdated: string }} input */
function nothingUnreadCanDisplace({ closed, count, lastUpdated }) {
  return closed.length >= count && Date.parse(lastUpdated) < Date.parse(newestFirst(closed)[count - 1].closed_at);
}

/** Issues (not pull requests, which the issues endpoint also lists) closed on or after `since`. @param {any[]} issues @param {number} since ms */
const closedSince = (issues, since) => issues.filter((issue) => !issue.pull_request && Date.parse(issue.closed_at) >= since);

/** @param {any[]} issues */
const newestFirst = (issues) => [...issues].sort((one, other) => Date.parse(other.closed_at) - Date.parse(one.closed_at));

/** Run `trace` for one page, as a child process: it is a command with its own ingest state, and a crash in it must not take the others down. @param {{ calls: number, now: number }} budget */
export const traceRenderer = ({ calls, now }) => (/** @type {{ kind: "map" | "row", row?: number, out: string }} */ { kind, row, out }) => {
  const since = new Date(now - MAP_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const args = kind === "map" ? ["--", "--map", "--out", out, "--since", since, "--calls", String(calls)] : ["--", String(row), "--html", "--out", out, "--since", since];
  const ran = spawnSync(process.execPath, [TRACE, ...args], { encoding: "utf8", timeout: RENDER_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER });
  if (ran.status !== 0) throw new Error(`trace ${args.slice(1, 2).join("")} exited ${ran.status ?? ran.signal}: ${(ran.stderr || ran.error?.message || "").trim().split("\n").pop()}`);
};

/**
 * Everything a run does, with GitHub behind `ask` and the renderer behind `render`: read the validators, publish, and write the validators back WHETHER OR NOT the publication succeeded (what GitHub said is true either way,
 * and a failed render should not also cost the next run its 304s). `reads` is what the journal prints, so the share of 304s is on the unit's log and not only in the ledger.
 * @param {{ out: string, repos: string[], trackerRepo: string, recent: number, rows: number[], ask: Ask, render: Parameters<typeof publish>[0]["render"], now: number, maxAgeMs: number }} input
 */
export function runPublisher({ out, repos, trackerRepo, recent, rows, ask, render, now, maxAgeMs }) {
  const held = readValidators(out);
  const { read, readFresh, reads } = conditionalReader({ held, ask, now });
  const since = now - MAP_WINDOW_DAYS * MS_PER_DAY;
  // asked only once a run is decided, so an idle tick spends no call on it; a row named by `--row` that the list also holds is drawn from the list's input, one that it does not is drawn always (`null`)
  const drawn = () => {
    const listed = recentClosedRows(trackerRepo, recent, since, readFresh);
    return [...listed, ...rows.filter((row) => !listed.some((one) => one.row === row)).map((row) => ({ row, input: null }))];
  };
  try {
    return { ...publish({ out, repos, rows: drawn, readHead: headReader(read), render, now, maxAgeMs }), reads };
  } finally {
    saveValidators({ out, held, now });
  }
}

async function main() {
  const { out, maxAgeMs, recent, rows, calls } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.ts");
  const declaration = homeProjectDeclaration();
  const repos = [...new Set(declaration.code.map((/** @type {{ repo: string }} */ entry) => entry.repo))];
  const now = Date.now();
  const result = runPublisher({ out, repos, trackerRepo: declaration.tracker[0].repo, recent, rows, ask: ghAsk, render: traceRenderer({ calls, now }), now, maxAgeMs });
  const asked = `GitHub reads: ${result.reads.asked}, answered 304: ${result.reads.notModified}`;
  console.log(result.ran
    ? `published ${result.pages.join(", ")} into ${out}: ${result.reason}; kept as they were: ${result.held.join(", ") || "none"}; ${asked}`
    : `nothing to do: no head moved and the last publication is under ${Math.round(maxAgeMs / MS_PER_MINUTE)} minutes old; ${asked}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
