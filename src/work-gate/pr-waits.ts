// module: the head a pull request's row began WAITING at -- the memory behind `isWaitingRed` (#4606)
//
// A wait carried as DATA (an open native `blockedBy` edge on the row a PR closes) excuses a red PR only at the head it was in force at, and
// "the head it was in force at" is a fact about the past that no read of GitHub gives back: the edge has no time on it in `blockedBy.nodes`.
// So the first tick that finds the edge open beside a head writes that head down, and `isWaitingRed` (`red-pr.ts`) compares against it.
//
// A LEAF OF THE GATE'S BOUNDARY: it reads and writes ONE small JSON file in the state directory it is handed and nothing else, no `gh`. With no
// directory it stamps nothing, so a caller that names none (every test but this module's own) is exactly what it was before.
import { openBlockersOf } from "../arm-pr.ts";
import { readJsonObject, writeJsonObject } from "../claim-stall.ts";
import { subjectRef } from "../review-attribution.ts";
import { rowsNamedBy } from "./pr-owners.ts";

/** The file, beside the wake ledger: `{ "<subjectRef>": "<head sha the wait was first seen at>" }`. */
export const PR_WAITS_FILE = "pr-waits.json";

/** Newest entries kept. A closed PR's entry is never read again and nothing lists closed PRs, so the file is bounded by count rather than swept. */
export const PR_WAITS_KEPT = 200;

/**
 * THE OPEN EDGES OF THE ROWS A PULL REQUEST NAMES, once each. A row not among `openRows` contributes nothing: absent is not "no edge", but it
 * is not an open one either, and the failure it can have is one more order, never a hidden red. An unreadable edge list (`null`) is the same.
 */
function openEdgesOf(pr: any, openRows: any[], rowsRepo?: string): number[] {
  const byNumber = new Map(openRows.map((row) => [Number(row?.number), row]));
  const edges = rowsNamedBy(pr, rowsRepo).flatMap(({ row }) => openBlockersOf(byNumber.get(row) ?? null) ?? []);
  return [...new Set(edges)].sort((a, b) => a - b);
}

/**
 * Stamp `waitingOn: { edges, head }` on each pull request whose owning row has an open native `blockedBy` edge, `head` being the head sha the wait was
 * FIRST SEEN at: remembered across ticks, kept while the edge stays open (a push does not move it, which is what makes the push end the exemption), and
 * forgotten the tick the edge is gone, so a later wait starts afresh at the head it meets. A pull request with no open edge is returned untouched.
 *
 * NEVER THROWS, for `recordEngineerStarts`'s reason: an unwritable memory costs the exemption (the stamp is still made from this tick's reading, and
 * the head is then the current one), never the orders behind it.
 *
 * @param [dir] where the memory lives; absent means NOT ASKED, and nothing is stamped
 * @param [rowsRepo] the repository `openRows` are rows of, as `withClosingRowOwners` takes it
 */
export function withWaitingEdges(prs: any[], openRows: any[], { dir, rowsRepo }: { dir?: string; rowsRepo?: string; } = {}): any[] {
  if (dir === undefined) return prs;
  const path = `${dir}/${PR_WAITS_FILE}`;
  const before = readJsonObject(path);
  const after: Record<string, string> = { ...before };
  const stamped = prs.map((pr) => {
    const ref = subjectRef(pr.repoKey, pr.number);
    const edges = openEdgesOf(pr, openRows, rowsRepo);
    const head = String(pr.headRefOid ?? "");
    if (edges.length === 0 || head === "") {
      if (edges.length === 0) delete after[ref];
      return pr;
    }
    after[ref] ??= head;
    return { ...pr, waitingOn: { edges, head: String(after[ref]) } };
  });
  remember(path, before, after);
  return stamped;
}

function remember(path: string, before: Record<string, any>, after: Record<string, string>) {
  const kept = Object.fromEntries(Object.entries(after).slice(-PR_WAITS_KEPT));
  if (JSON.stringify(kept) === JSON.stringify(before)) return;
  try {
    writeJsonObject(path, kept);
  } catch (err: any) {
    process.stderr.write(`pr-waits: could not write ${path} (${String(err?.message ?? err).split("\n")[0]}) -- a wait is remembered for this tick only.\n`);
  }
}
