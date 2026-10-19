/**
 * The due-index (a11ign/a11ign#5043, design item 4): THE INSTANTS A DATED WAIT COMES DUE, KEPT WHERE A TICK CAN READ THEM WITHOUT GITHUB.
 *
 * `Not-before:`, `Fleet-hold-until:` and the aged-backlog order are date comparisons on a row body already parsed. Today each is seen because the
 * tick re-reads the row lists; once a repository with no event is served from the cache, a row whose date passed at 16:20Z must still be seen at
 * 16:20Z, not at the next reconcile. The gate writes each repository's instants here and the tick asks which repositories had one pass since it
 * last looked. NOTHING CALLS THIS YET: the wiring is a later row, so this module is pure apart from the one file it is handed.
 *
 * THE CLOCK IS AN ARGUMENT, never read here, so a test injects it and a caller cannot be given a different "now" than the one it measured.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DUE_KINDS = ["not-before", "fleet-hold-until", "aged-backlog"] as const;
export type DueKind = (typeof DUE_KINDS)[number];
export type DueEntry = { number: number, dueAtMs: number, kind: DueKind };
/** Entries by repository (`owner/name`). */
export type DueIndex = Record<string, DueEntry[]>;

/**
 * `missing` is an empty index (nothing was ever written, so nothing is due). `corrupt` carries `index: null` and the reason: the caller MUST treat
 * it as "everything may be due", never as nothing, because a half-written file says nothing about what passed.
 */
export type DueIndexRead =
  | { status: "ok", index: DueIndex }
  | { status: "missing", index: DueIndex }
  | { status: "corrupt", index: null, reason: string };

const VERSION = 1;

const isEntry = (e: unknown): e is DueEntry => {
  if (typeof e !== "object" || e === null) return false;
  const { number, dueAtMs, kind } = e as Record<string, unknown>;
  return Number.isInteger(number) && typeof dueAtMs === "number" && Number.isFinite(dueAtMs) && (DUE_KINDS as readonly unknown[]).includes(kind);
};

/** Never throws: a missing file is an empty index, anything unreadable or malformed is `corrupt` with the reason. */
export const readDueIndex = (path: string): DueIndexRead => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", index: {} };
    return { status: "corrupt", index: null, reason: `unreadable: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { status: "corrupt", index: null, reason: `not JSON: ${(error as Error).message}` };
  }
  const repos = (parsed as { version?: unknown, repos?: unknown } | null)?.repos;
  const isMalformedIndex = (parsed as { version?: unknown } | null)?.version !== VERSION || typeof repos !== "object" || repos === null || Array.isArray(repos);
  if (isMalformedIndex) {
    return { status: "corrupt", index: null, reason: `not a version ${VERSION} due-index` };
  }
  const index: DueIndex = {};
  for (const [repo, entries] of Object.entries(repos)) {
    if (!Array.isArray(entries) || !entries.every(isEntry)) return { status: "corrupt", index: null, reason: `malformed entries for ${repo}` };
    index[repo] = entries.map(({ number, dueAtMs, kind }) => ({ number, dueAtMs, kind }));
  }
  return { status: "ok", index };
};

/**
 * REPLACES `repo`'s entries (a row that left the lists leaves the index) and keeps every other repository's. The file is written whole to a
 * sibling and renamed over, so a reader sees the old index or the new one, never half of either. A corrupt file is started afresh: the other
 * repositories' entries in it were unreadable, and each is rewritten by its own next gate pass.
 */
export const writeDueIndex = ({ path, repo, entries }: { path: string, repo: string, entries: DueEntry[] }): void => {
  const bad = entries.find((e) => !isEntry(e));
  if (bad !== undefined) throw new TypeError(`writeDueIndex: not a due entry: ${JSON.stringify(bad)}`);
  const { index } = readDueIndex(path);
  const repos: DueIndex = { ...(index ?? {}) };
  if (entries.length === 0) delete repos[repo];
  else repos[repo] = entries.map(({ number, dueAtMs, kind }) => ({ number, dueAtMs, kind }));
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify({ version: VERSION, repos })}\n`);
  renameSync(partial, path);
};

/**
 * The repositories with an instant in (`afterMs`, `nowMs`]: after the previous tick looked and not after now. An instant exactly at `afterMs` was
 * seen by that tick; one exactly at `nowMs` is due. With no `afterMs` (the first tick) every instant not after now counts, once. Distinct, sorted.
 */
export const dueRepos = ({ index, afterMs, nowMs }: { index: DueIndex, afterMs?: number | null, nowMs: number }): string[] =>
  Object.entries(index)
    .filter(([, entries]) => entries.some((e) => e.dueAtMs <= nowMs && (afterMs === undefined || afterMs === null || e.dueAtMs > afterMs)))
    .map(([repo]) => repo)
    .sort();
