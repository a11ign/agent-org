/**
 * #4601: HOW MUCH OF THE TREE A NEW ROW'S REGION RESERVES, MEASURED AT FILING (lock-gridlock fix 1 of 4, epic #4437).
 *
 * A row whose Region is a whole tree files as an ordinary row, so one claim shelves every row that touches that tree and nothing at
 * filing says so. On 2026-10-09 a11ign#4389 (a 110-file rename, Region `agent-org:src/`) held most of `src/`: 28 ready rows were blocked
 * and 8 of 11 engineers were idle. For a repo-wide rename B4 is right -- concurrent edits would conflict. The defect is that a repo-wide
 * mechanical change ran as an ordinary long ticket at peak time, and `row-file` never measured it.
 *
 * TWO NUMBERS, EACH REFUSED ABOVE ITS THRESHOLD: the files the Region expands to, and the open rows and pull requests that share a file
 * with it. The way out is to split the row, or to declare a `Sweep:` line ({@link declaresSweep}), which files it with the numbers printed.
 *
 * KEPT OUT OF `row-file.ts` ON PURPOSE: a test that imports `row-file.ts` reaches the `corpus` closure, and this logic is pure over three
 * injected reads ({@link BlastReads}), so its tests need no network.
 */
import { declaredRegionFiles, regionCovers, regionCoversIn, splitRegionEntry } from "./region-paths.ts";
import { claimedRegionsOf, lookupOpenPrFiles, NO_CODE_LEFT_LABEL } from "./row-claim/file-overlap-rule.ts";
import { BACKLOG_LABEL } from "./project-vocabulary.ts";
import { CLAIM_LABEL, READY_LABEL } from "./claim-labels.ts";

/** The most files a Region may expand to before the row must be split or declared a sweep. */
export const BLAST_MAX_FILES = 20;
/** The most open rows and pull requests a Region may share a file with before the row must be split or declared a sweep. */
export const BLAST_MAX_OVERLAP = 5;

/** The open rows that count as competitors: any of these states, as B4 will see them once one is claimed. */
const COMPETING_STATES: readonly string[] = [READY_LABEL, CLAIM_LABEL, BACKLOG_LABEL];

/** The most open rows one tracker read asks for; a full page is read as cut short, never as everything there is. */
const OPEN_ROWS_LIMIT = 500;

/** How many names a refusal lists before it says "and n more": the first rows are the message, a hundred are a wall. */
const NAMED_OVERLAPS = 8;

const SWEEP_LINE = /^[ \t]*(?:\*\*)?Sweep:(?:\*\*)?(?=\s|$)/;
const FENCE_LINE = /^\s*(?:```|~~~)/;

/**
 * Does the body declare itself a SWEEP: a `Sweep:` line (optionally bold), at the start of a line and OUTSIDE any fenced block, so a row
 * that quotes the grammar in a code sample does not declare one. The next row (the sweep protocol, fix 2) reads this same parser.
 * @param {string} body
 * @returns {boolean}
 */
export function declaresSweep(body: string): boolean {
  let inFence = false;
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    else if (!inFence && SWEEP_LINE.test(line)) return true;
  }
  return false;
}

/** An open row, as `gh issue list --json number,labels,body` returns it. */
export type OpenRow = { number: number; labels?: { name: string; }[]; body?: string | null; repo?: string; };
/** An open pull request in the shape `lookupOpenPrFiles` returns, narrowed to what the count reads. */
export type OpenPr = { number: number; files: string[]; closes?: number[]; repo?: string; repoKey?: string; };

/**
 * THE THREE READS, each `null` when it could not be made -- INCONCLUSIVE, never "nothing there".
 * `treeFiles` is every tracked file of the code repository a Region key names (`""` is the first's).
 */
export type BlastReads = {
  treeFiles: (key: string) => string[] | null;
  openRows: () => OpenRow[] | null;
  openPrs: () => OpenPr[] | null;
};

export type BlastRadius = {
  /** Files the Region expands to: the count of what could be listed, which is a FLOOR when `filesComplete` is false (a directory's tree failed to read). */
  files: number;
  filesComplete: boolean;
  /** The open rows (`#n`) and pull requests (`PR #n`) that share a file with it: what could be read, a FLOOR when `overlapsComplete` is false. */
  overlaps: string[];
  overlapsComplete: boolean;
};

/**
 * What the filing does with a reading: refuse, or go on. `note` is the sweep's line, printed after the row is filed; `warning` says the
 * measurement could not be completed, printed before.
 */
export type BlastVerdict = { refusal: string | null; note: string | null; warning: string | null };

const entryKey = (key: string, path: string) => `${key}:${path}`;

/** Every file the entries expand to, de-duplicated across overlapping entries; `complete` is false when a directory's tree could not be read. */
function expandedFiles(entries: string[], treeFiles: BlastReads["treeFiles"]): { files: Set<string>; complete: boolean; } {
  const files = new Set<string>();
  let complete = true;
  for (const entry of entries) {
    const { key, path } = splitRegionEntry(entry);
    if (!path.endsWith("/")) {
      files.add(entryKey(key, path));
      continue;
    }
    const tree = treeFiles(key);
    if (tree === null) complete = false;
    else for (const file of tree.filter((f) => regionCovers(path, f))) files.add(entryKey(key, file));
  }
  return { files, complete };
}

/** Do two declared entries meet: the same repository key, and one path equal to or covering the other (B4's `sharedRegionEntries` rule). */
function entriesMeet(mine: string, theirs: string): boolean {
  const [x, y] = [splitRegionEntry(mine), splitRegionEntry(theirs)];
  return x.key === y.key && (regionCovers(x.path, y.path) || regionCovers(y.path, x.path));
}

/**
 * The open rows whose Region meets `mine`, read as B4 reads a CLAIMED row (`claimedRegionsOf`): every competing state is relabelled as a
 * claim for the read, so the fence-is-the-declaration rule and the `no-code-left` exclusion apply to a ready or backlog row as they will
 * the moment it is claimed.
 */
function overlappingRows(mine: string[], rows: OpenRow[]): OpenRow[] {
  return rows
    .filter((row) => (row.labels ?? []).some((l) => COMPETING_STATES.includes(l.name)))
    .filter((row) => {
      const labels = (row.labels ?? []).filter((l) => l.name === NO_CODE_LEFT_LABEL).concat({ name: CLAIM_LABEL });
      const held = claimedRegionsOf([{ ...row, labels }]) ?? [];
      return held.some((region) => region.files.some((theirs) => mine.some((entry) => entriesMeet(entry, theirs))));
    });
}

/** The open pull requests with a changed file the Region covers, leaving out one that closes a row already counted (one piece of work, once). */
function overlappingPrs(mine: string[], prs: OpenPr[], countedRows: ReadonlySet<number>): OpenPr[] {
  return prs
    .filter((pr) => pr.files.some((file) => mine.some((entry) => regionCoversIn(entry, pr.repoKey ?? "", file))))
    .filter((pr) => !(pr.closes ?? []).some((row) => countedRows.has(row)));
}

const rowName = (row: OpenRow) => (row.repo === undefined ? `#${row.number}` : `#${row.number} in ${row.repo}`);
const prName = (pr: OpenPr) => (pr.repo === undefined ? `PR #${pr.number}` : `PR #${pr.number} in ${pr.repo}`);

/**
 * THE MEASUREMENT: both numbers for a body's Region. A Region that declares no file measures as nothing and reads nothing, so a row
 * with no Region paths (`Not a commit.`) costs no `gh` call.
 * @param {string} body @param {BlastReads} reads
 * @returns {BlastRadius}
 */
export function measureBlastRadius(body: string, reads: BlastReads): BlastRadius {
  const entries = declaredRegionFiles(body) ?? [];
  if (entries.length === 0) return { files: 0, filesComplete: true, overlaps: [], overlapsComplete: true };
  const rows = reads.openRows();
  const prs = reads.openPrs();
  const { files, complete } = expandedFiles(entries, reads.treeFiles);
  const countedRows = overlappingRows(entries, rows ?? []);
  const countedNumbers = new Set(countedRows.filter((r) => r.repo === undefined).map((r) => r.number));
  const overlaps = [...countedRows.map(rowName), ...overlappingPrs(entries, prs ?? [], countedNumbers).map(prName)];
  return { files: files.size, filesComplete: complete, overlaps, overlapsComplete: rows !== null && prs !== null };
}

const listed = (names: string[]) => (names.length <= NAMED_OVERLAPS ? names : [...names.slice(0, NAMED_OVERLAPS), `and ${names.length - NAMED_OVERLAPS} more`]).join(", ");

/** The numbers, in the words both the refusal and the sweep's success line use. An incomplete one says "at least": it is a floor, not the count. */
function readingIn({ files, filesComplete, overlaps, overlapsComplete }: BlastRadius): string {
  const fileWords = `${filesComplete ? "" : "at least "}${files} file(s) (limit ${BLAST_MAX_FILES})${filesComplete ? "" : ", a directory in it UNREADABLE"}`;
  const listing = overlaps.length > 0 ? `: ${listed(overlaps)}` : "";
  const overlapWords = `${overlapsComplete ? "" : "at least "}${overlaps.length} open row(s) and pull request(s) (limit ${BLAST_MAX_OVERLAP})${listing}`
    + (overlapsComplete ? "" : ", the open rows or pull requests UNREADABLE");
  return `the Region expands to ${fileWords} and overlaps ${overlapWords}`;
}

/** Is a number over its threshold. A floor that is already over IS over: a read that failed cannot lower it. */
const isOver = ({ files, overlaps }: BlastRadius) => files > BLAST_MAX_FILES || overlaps.length > BLAST_MAX_OVERLAP;
const isUnread = ({ filesComplete, overlapsComplete }: BlastRadius) => !filesComplete || !overlapsComplete;

/**
 * THE VERDICT, PURE. A declared sweep files, with the reading in the note. Over a threshold refuses otherwise -- a number that was
 * read counts even when the other was not. A reading that could not be completed and is over nothing FILES WITH A WARNING that says the
 * check did not run: the milestone read does the same (#1011), the filing needs `gh` regardless, and a refusal there would make every
 * outage a reason not to file. The warning states the check is unknown, so it is never read as "checked and small".
 * @param {BlastRadius} radius @param {boolean} sweep whether the body carries a `Sweep:` line
 * @returns {BlastVerdict}
 */
export function blastRadiusVerdict(radius: BlastRadius, sweep: boolean): BlastVerdict {
  const none = { refusal: null, note: null, warning: null };
  if (sweep) return { ...none, note: `row-file: SWEEP declared -- ${readingIn(radius)}.` };
  if (isOver(radius)) {
    return { ...none, refusal: `row-file: REFUSING to file -- ${readingIn(radius)}. One claim on a Region this wide shelves every row that `
      + "touches it (lock-gridlock, #4437). Nothing was filed. Either SPLIT the row into bounded rows, one folder each, or DECLARE A SWEEP: add a "
      + "line `Sweep: <why this change must land as one row>` to the body (#4601)." };
  }
  if (isUnread(radius)) {
    return { ...none, warning: `row-file: WARNING -- the blast-radius check did NOT complete: ${readingIn(radius)}. Whether this Region is wider than `
      + `${BLAST_MAX_FILES} files or ${BLAST_MAX_OVERLAP} open rows is UNKNOWN, not small (#4601).` };
  }
  return none;
}

/**
 * THE GATE `row-file` CALLS: measure, then judge. Reads are skipped for a body that declares no Region file.
 * @param {string} body @param {BlastReads} reads
 * @returns {BlastVerdict}
 */
export function blastRadiusGate(body: string, reads: BlastReads): BlastVerdict {
  return blastRadiusVerdict(measureBlastRadius(body, reads), declaresSweep(body));
}

/** Parse `json` as an array, or `null` -- a read that came back as anything else is a failed read. */
function jsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * THE REAL READS over `gh`, each `null` on failure. The tree is the code repository's default branch, which is what a claim's Region is
 * cut against; GitHub's own `truncated` flag fails the read rather than undercounting a tree it cut short.
 * @param {(cmd: string, args: string[]) => string} run
 * @param {{ code: readonly { key: string; repo: string }[]; tracker: readonly { repo: string }[] }} declaration
 * @returns {BlastReads}
 */
export function ghBlastReads(run: (cmd: string, args: string[]) => string,
  declaration: { code: readonly { key: string; repo: string; }[]; tracker: readonly { repo: string; }[]; }): BlastReads {
  const gh = (args: string[]) => run("gh", args);
  return {
    treeFiles: (key) => {
      const repo = declaration.code.find((r) => r.key === key)?.repo;
      if (repo === undefined) return null;
      try {
        const jq = 'if .truncated then error("tree truncated") else .tree[] | select(.type == "blob") | .path end';
        return gh(["api", `repos/${repo}/git/trees/HEAD?recursive=1`, "--jq", jq]).split("\n").filter(Boolean);
      } catch {
        return null;
      }
    },
    openRows: () => {
      const all: OpenRow[] = [];
      for (const { repo } of declaration.tracker) {
        try {
          const rows = jsonArray(gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(OPEN_ROWS_LIMIT), "--json", "number,labels,body"]));
          if (rows === null || rows.length >= OPEN_ROWS_LIMIT) return null; // a full page may be a truncated one
          all.push(...(rows as OpenRow[]).map((row) => (repo === declaration.tracker[0].repo ? row : { ...row, repo })));
        } catch {
          return null;
        }
      }
      return all;
    },
    openPrs: () => lookupOpenPrFiles({ run: gh, repos: declaration.code, log: () => {} }),
  };
}
