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
// A FAILURE IS AN ERROR, NEVER AN EMPTY DIRECTORY. Every page is rendered into a staging directory first and checked to exist and to be non-empty; what succeeded is moved into
// place, what failed is listed, the stamp is NOT written (so the next tick retries), and the process exits non-zero, so the unit shows FAILED. Nothing here catches a write error
// and carries on: the one `catch` that does carry on collects a renderer's failure so the other pages still publish, and it rethrows them all at the end.
import { execFileSync, spawnSync } from "node:child_process";
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
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 30 * MS_PER_MINUTE;
export const STAMP_FILE = ".published.json";
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

/** @typedef {{ at: number, heads: Record<string, string> }} Stamp */

/** The stamp of the last COMPLETE publication. Absent is `null`; unreadable is also `null`, on purpose: the safe direction of "I cannot tell" is to regenerate. @param {string} out @returns {Stamp | null} */
export function readStamp(out) {
  const path = join(out, STAMP_FILE);
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    return Number.isFinite(stamp.at) && typeof stamp.heads === "object" && stamp.heads !== null ? stamp : null;
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

/**
 * Render every page into `staging`; what succeeded is returned, what failed is returned apart, and NOTHING is thrown here so one broken row does not hold back the others.
 * @param {{ staging: string, rows: number[], render: (page: { kind: "map" | "row", row?: number, out: string }) => void }} input
 */
function renderAll({ staging, rows, render }) {
  const wanted = [{ file: MAP_PAGE, label: "Process map: merged rows, last seven days", page: { kind: /** @type {const} */ ("map"), out: join(staging, MAP_PAGE) } },
    ...rows.map((row) => ({ file: `row-${row}.html`, label: `Swimlane: #${row}`, page: { kind: /** @type {const} */ ("row"), row, out: join(staging, `row-${row}.html`) } }))];
  const pages = [];
  const failed = [];
  for (const { file, label, page } of wanted) {
    try {
      render(page);
      if (!written(page.out)) throw new Error("the renderer returned without writing the page");
      pages.push({ file, label });
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
 * One run: decide, render, move into place, stamp. Returns `{ ran: false }` when nothing moved and the stamp is fresh; THROWS when a head cannot be read, a write fails, or any page failed.
 * @param {{ out: string, repos: string[], rows: () => number[], readHead: (repo: string) => string, render: (page: { kind: "map" | "row", row?: number, out: string }) => void, now: number, maxAgeMs: number }} input
 * @returns {{ ran: boolean, reason: string | null, pages: string[] }}
 */
export function publish({ out, repos, rows, readHead, render, now, maxAgeMs }) {
  const heads = Object.fromEntries(repos.map((repo) => [repo, readHead(repo)]));
  const reason = whyRun({ heads, stamp: readStamp(out), now, maxAgeMs });
  if (reason === null) return { ran: false, reason, pages: [] };
  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(out, ".staging-"));
  try {
    const { pages, failed } = renderAll({ staging, rows: rows(), render });
    for (const { file } of pages) renameSync(join(staging, file), join(out, file));
    retire(out, pages.map(({ file }) => file));
    const index = join(staging, "index.html");
    writeFileSync(index, indexPage({ generatedAt: now, reason, heads, pages, failed }));
    renameSync(index, join(out, "index.html"));
    if (failed.length > 0) throw new Error(`${failed.length} of ${failed.length + pages.length} pages were not regenerated (the others are published, no stamp is written so the next run retries):\n${failed.join("\n")}`);
    writeFileSync(join(staging, STAMP_FILE), JSON.stringify({ at: now, heads }));
    renameSync(join(staging, STAMP_FILE), join(out, STAMP_FILE));
    return { ran: true, reason, pages: pages.map(({ file }) => file) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** @param {string[]} args @returns {any} `gh api <args>`, parsed: a failure THROWS, because a head that could not be read must not read as "unchanged". */
const ghApi = (args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: GH_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }));

/** @param {string} repo */
export const readHead = (repo) => ghApi([`repos/${repo}/branches/main`]).commit.sha;

/**
 * The rows CLOSED most recently in `repo`, newest closing first: closed issues that are not pull requests, closed on or after `since`. The search is by closing date and not by `sort=updated`
 * of the issues listing, which MEASURED 2026-10-05 returned the record issue (#928, closed 2026-09-12) first because it is commented on all day, and a swimlane of it is a 100 kB page of nothing a
 * chairman asked to see.
 * @param {string} repo @param {number} count @param {number} since ms @param {(args: string[]) => any} [gh]
 */
export function recentClosedRows(repo, count, since, gh = ghApi) {
  if (count === 0) return [];
  const day = new Date(since).toISOString().slice(0, "YYYY-MM-DD".length);
  const found = gh(["-X", "GET", "search/issues", "-f", `q=repo:${repo} is:issue is:closed closed:>=${day}`, "-f", "sort=updated", "-f", `per_page=${CLOSED_ROWS_PAGE}`]);
  return (found.items ?? []).filter((issue) => !issue.pull_request && Date.parse(issue.closed_at) >= since)
    .sort((one, other) => Date.parse(other.closed_at) - Date.parse(one.closed_at)).slice(0, count).map((issue) => issue.number);
}

/** Run `trace` for one page, as a child process: it is a command with its own ingest state, and a crash in it must not take the others down. @param {{ calls: number, now: number }} budget */
export const traceRenderer = ({ calls, now }) => (/** @type {{ kind: "map" | "row", row?: number, out: string }} */ { kind, row, out }) => {
  const since = new Date(now - MAP_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const args = kind === "map" ? ["--", "--map", "--out", out, "--since", since, "--calls", String(calls)] : ["--", String(row), "--html", "--out", out, "--since", since];
  const ran = spawnSync(process.execPath, [TRACE, ...args], { encoding: "utf8", timeout: RENDER_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER });
  if (ran.status !== 0) throw new Error(`trace ${args.slice(1, 2).join("")} exited ${ran.status ?? ran.signal}: ${(ran.stderr || ran.error?.message || "").trim().split("\n").pop()}`);
};

async function main() {
  const { out, maxAgeMs, recent, rows, calls } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.mjs");
  const declaration = homeProjectDeclaration();
  const repos = [...new Set(declaration.code.map((/** @type {{ repo: string }} */ entry) => entry.repo))];
  const now = Date.now();
  const drawn = () => [...new Set([...recentClosedRows(declaration.tracker[0].repo, recent, now - MAP_WINDOW_DAYS * MS_PER_DAY), ...rows])]; // asked only once a run is decided, so an idle tick spends no call on it
  const result = publish({ out, repos, rows: drawn, readHead, render: traceRenderer({ calls, now }), now, maxAgeMs });
  console.log(result.ran ? `published ${result.pages.join(", ")} into ${out}: ${result.reason}` : `nothing to do: no head moved and the last publication is under ${Math.round(maxAgeMs / MS_PER_MINUTE)} minutes old`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
