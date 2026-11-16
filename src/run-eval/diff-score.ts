// @ts-check
// module: how close a worker's diff is to the merged one (A11-431) -- the files and changed lines of a unified diff, their similarity, and the files a worker touched outside it
//
// SIMILARITY IS A WEAK SIGNAL (the plan: tests and the reviewer's verdict weigh more), so it is kept simple and deterministic: the share of changed lines the two diffs have in
// common, as a multiset Jaccard over `file + sign + trimmed line`. Blank lines and whitespace-only changes count for nothing, and a line moved within its file still matches.
//
// A FILE WHOSE NAME IS THE BRANCH'S OWN is compared by its folder: a changeset (`.changeset/<name>.md`) and an acceptance file (`.acceptance/<branch>.md`) are named by whoever
// wrote them (a `.md` file directly in the folder; `.changeset/config.json` is compared as itself), so the worker's and the merged pull request's are the same file under two names. Every other path is compared as it is.

/** The folders whose files are named by their author, compared by folder. */
const AUTHOR_NAMED = [".changeset/", ".acceptance/"];

/** The path a file is compared under: its folder, for a file its author names. PURE. */
export function comparedPath(path: string): string {
  const folder = AUTHOR_NAMED.find((prefix) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.endsWith(".md"));
  return folder === undefined ? path : `${folder}*`;
}

/** A diff, read: each file it changes (as compared, see `comparedPath`) with its changed lines, `+text` or `-text`, trimmed. */
export type ReadDiff = ReadonlyMap<string, readonly string[]>;

/**
 * The path a `diff --git a/x b/y` header names: the new side, which a rename moves to and a deletion keeps. A path git quotes (`"b/with space"`) is read inside its quotes. The
 * diffs read here are written with the default `a/` and `b/` prefixes (`workerDiff` and GitHub's compare both are). PURE.
 */
const headerPath = (line: string): string | null => / "b\/(.+)"$/.exec(line)?.[1] ?? / b\/(.+)$/.exec(line)?.[1] ?? null;

/** Whether a line of a hunk adds or removes a line. PURE. */
const isChangedLine = (line: string): boolean => line.startsWith("+") || line.startsWith("-");

/** The files and changed lines of a unified diff, as `git diff` writes it. A line outside a hunk (headers, `index`, `+++`) is no changed line. PURE. */
export function readDiff(diff: string): ReadDiff {
  const files = new Map<string, string[]>();
  let lines: string[] | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = headerPath(line);
      lines = path === null ? null : (files.get(comparedPath(path)) ?? []);
      if (path !== null) files.set(comparedPath(path), lines as string[]);
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && lines !== null && isChangedLine(line)) {
      const text = line.slice(1).trim();
      if (text !== "") lines.push(`${line[0]}${text}`);
    }
  }
  return files;
}

/** The changed lines of a read diff as counts of `file \t +text`. PURE. */
function lineCounts(read: ReadDiff): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [file, lines] of read) {
    for (const line of lines) counts.set(`${file}\t${line}`, (counts.get(`${file}\t${line}`) ?? 0) + 1);
  }
  return counts;
}

/**
 * The share of changed lines the two diffs have in common, from 0 to 1: the multiset intersection over the union. `null` when neither changes a line, which has nothing to
 * compare; a worker that changed nothing against a merged diff that changed something scores 0. PURE.
 */
export function similarity(worker: ReadDiff, merged: ReadDiff): number | null {
  const a = lineCounts(worker);
  const b = lineCounts(merged);
  let shared = 0;
  let either = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    shared += Math.min(a.get(key) ?? 0, b.get(key) ?? 0);
    either += Math.max(a.get(key) ?? 0, b.get(key) ?? 0);
  }
  return either === 0 ? null : shared / either;
}

/** The files the worker changed that the merged diff did not, sorted: its scope beyond the ticket's merged work. PURE. */
export function filesOutside(worker: ReadDiff, merged: ReadDiff): string[] {
  return [...worker.keys()].filter((file) => !merged.has(file)).sort();
}
