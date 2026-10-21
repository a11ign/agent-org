// command: gate-snapshot-read -- what the gate last stored of the open pull requests, the open rows and the board, with the age of each
/**
 * (agent-org#1517) A MANAGER READS THE GATE'S SNAPSHOT FOR A LIST, NOT THE API. The gate reads the open pull requests, the open rows and the board
 * once a tick and stores them on this host (`open-prs-memory.json` and `gate-conditional/kept-reads.json` in the state directory, the newest file of
 * `runs/board-snapshots`). A manager's `pr list` or `issue list` re-reads the same lists through the API, and `plugins/github/wrapper/gh` refuses it for that reason.
 * This reader is the answer that refusal names: it prints what is stored and how old it is, and it makes NO `gh` call (control f).
 *
 *   gate-snapshot-read prs   --repo <owner/name>           the open pull requests the gate last read whole, with their titles
 *   gate-snapshot-read rows  --repo <owner/name>           the open rows the gate last read, with their titles
 *   gate-snapshot-read rows  --repo <owner/name> --json    the same rows as ONE JSON object: each row's number, title, labels and body as stored, and the read's instant and age
 *   gate-snapshot-read board                                the newest board snapshot's path
 *
 * A SNAPSHOT THAT CANNOT BE READ IS SAID, NEVER A LIST: a missing, unreadable or unnamed store prints its reason and exits 1, because an empty list
 * would read as "nothing is open". The age is the time since the gate's read, not since this command ran; a snapshot the gate has not refreshed
 * for a while still prints its age, and the caller decides whether that is too old for its question.
 *
 * `--state <dir>` and `--root <dir>` name the state directory and the checkout whose `runs/board-snapshots` is read, for a test or an operator; by
 * default the state directory is the host's (`stateEntryPath`) and the checkout is the working directory's.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotDirFor } from "./board-snapshot-scope.ts";
import { GATE_VALIDATORS_DIR } from "./gh-conditional.ts";
import { stateEntryPath } from "./host-config.ts";
import { readPrList } from "./pr-list-memory.ts";

/** The open pull requests' store: `pr-list-memory.ts`, written whole by the gate's read (`work-gate/reads.ts`'s `OPEN_PRS_MEMORY`). */
export const OPEN_PRS_STORE = "open-prs-memory.json";
/** The gate's kept reads: `rows` per repository, `{ signature, readAt, rows }`, written by the conditional open-rows read (`work-gate/reads.ts`). */
export const KEPT_READS_STORE = "kept-reads.json";

/** A stored open row whole, as `rows --json` prints it. `labels` is the names in stored order, `null` when the store has no list; `body` is the stored text, `null` (never "") when it has none. */
export type StoredRow = { number: unknown; title: string; labels: string[] | null; body: string | null; };

export type SnapshotRead =
  | { ok: true; source: string; readAtMs: number; items: string[]; stored?: StoredRow[]; }
  | { ok: false; source: string; reason: string; };

const titled = (item: { number?: unknown; title?: unknown; }) => `#${String(item.number)} ${typeof item.title === "string" ? item.title : ""}`.trimEnd();

const stored = (row: { number?: unknown; title?: unknown; labels?: unknown; body?: unknown; }): StoredRow => ({
  number: row.number,
  title: typeof row.title === "string" ? row.title : "",
  labels: Array.isArray(row.labels) ? row.labels.map((label) => String(label?.name ?? label)) : null,
  body: typeof row.body === "string" ? row.body : null,
});

/** The open pull requests the gate last read whole for `repo`, or why there are none. A remembered list is kept whole, so its instant is the read's. */
export function readOpenPrs({ path, repo, nowMs }: { path: string; repo: string; nowMs: number; }): SnapshotRead {
  const read = readPrList({ path, repo, nowMs, maxAgeMs: Number.POSITIVE_INFINITY });
  if (!read.ok) return { ok: false, source: path, reason: `${read.reason}: ${read.detail}` };
  return { ok: true, source: path, readAtMs: read.readAtMs, items: read.prs.map(titled) };
}

/** The open rows the gate last read for `repo` from its kept reads. Written only while the conditional read is on, so a missing entry says so. */
export function readOpenRows({ path, repo }: { path: string; repo: string; }): SnapshotRead {
  let kept: any;
  try {
    kept = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, source: path, reason: code === "ENOENT" ? "missing: no kept reads" : `unreadable: ${(error as Error).message.split("\n")[0]}` };
  }
  const rows = kept?.[repo]?.rows;
  if (rows === undefined) return { ok: false, source: path, reason: `missing: no open rows kept for ${repo}` };
  if (!Array.isArray(rows?.rows) || !Number.isFinite(rows.readAt)) return { ok: false, source: path, reason: `unreadable: the open rows kept for ${repo} are not a list with an instant` };
  return { ok: true, source: path, readAtMs: rows.readAt, items: rows.rows.map(titled), stored: rows.rows.map(stored) };
}

/** The newest board snapshot under `dir` (by its file's time), named by path: its age is the file's, and the board is read from it by the caller. */
export function readBoard({ dir }: { dir: string; }): SnapshotRead {
  if (!existsSync(dir)) return { ok: false, source: dir, reason: "missing: no board snapshot directory" };
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (files.length === 0) return { ok: false, source: dir, reason: "missing: no board snapshot in it" };
  return { ok: true, source: files[0].path, readAtMs: files[0].at, items: [files[0].path] };
}

/** `4 min 12 s` for an age, never a negative one: a snapshot read after this instant (a clock that moved) is said to be read `0 s` ago. */
export function ageText(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The lines the command prints for one read: a header that says the age, then one line per item; or the reason, which is the whole answer when there is none. */
export function renderRead(what: string, read: SnapshotRead, nowMs: number): string[] {
  if (!read.ok) return [`gate-snapshot-read ${what}: no snapshot (${read.reason}) in ${read.source}`];
  const at = new Date(read.readAtMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [`${what} from the gate's snapshot in ${read.source}: read ${at}, ${ageText(nowMs - read.readAtMs)} ago, ${read.items.length} item(s)`, ...read.items];
}

/** `rows --json`: one object with the instant the store was read at and its age (never negative, as the header's), and each stored row whole. */
export function renderRowsJson(read: Extract<SnapshotRead, { ok: true; }>, nowMs: number): string {
  return JSON.stringify({ source: read.source, readAt: new Date(read.readAtMs).toISOString(), ageMs: Math.max(0, nowMs - read.readAtMs), rows: read.stored ?? [] });
}

const USAGE = "usage: agent-org gate-snapshot-read <prs|rows|board> [--repo <owner/name>] [--state <dir>] [--root <dir>] [--json]";

/**
 * The command. Returns the exit status; prints to stdout and stderr only. Nothing here calls `gh`: the stores are files the gate wrote.
 * @param {string[]} argv @returns {number}
 */
export function main(argv: readonly string[], { nowMs = Date.now(), env = process.env, root = process.cwd() }: { nowMs?: number; env?: NodeJS.ProcessEnv; root?: string; } = {}): number {
  const [what, ...rest] = argv;
  const flag = (name: string) => {
    const at = rest.indexOf(name);
    return at === -1 ? undefined : rest[at + 1];
  };
  if (what !== "prs" && what !== "rows" && what !== "board") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // `--json` is for rows only: `prs` and `board` refuse it rather than ignore it, so a caller that asks them for JSON is told so.
  const json = rest.includes("--json");
  if (json && what !== "rows") {
    process.stderr.write(`gate-snapshot-read ${what}: --json is for rows only\n${USAGE}\n`);
    return 2;
  }
  const repo = flag("--repo") ?? env.GH_REPO;
  if (what !== "board" && (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo))) {
    process.stderr.write(`gate-snapshot-read ${what}: name the repository with --repo <owner/name>\n${USAGE}\n`);
    return 2;
  }
  let read: SnapshotRead;
  if (what === "board") read = readBoard({ dir: snapshotDirFor(flag("--root") ?? root) });
  else {
    let stateDir: string;
    try {
      stateDir = flag("--state") ?? stateEntryPath("");
    } catch (error) {
      process.stderr.write(`gate-snapshot-read: the state directory is not known here: ${(error as Error).message.split("\n")[0]}\n`);
      return 1;
    }
    read = what === "prs" ? readOpenPrs({ path: join(stateDir, OPEN_PRS_STORE), repo: repo!, nowMs })
      : readOpenRows({ path: join(stateDir, GATE_VALIDATORS_DIR, KEPT_READS_STORE), repo: repo! });
  }
  const lines = renderRead(what, read, nowMs);
  if (!read.ok) {
    process.stderr.write(`${lines.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(json ? `${renderRowsJson(read, nowMs)}\n` : `${lines.join("\n")}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) process.exitCode = main(process.argv.slice(2));
