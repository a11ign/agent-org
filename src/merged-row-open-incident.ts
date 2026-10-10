// @ts-check
// module: a row left open after its deliverable merged is a LEDGER INCIDENT, class `row-not-finishable` (a11ign/a11ign#4769, chairman via #4437)
//
// CHAIRMAN, 2026-10-10 (#4437): "tickets should be one deliverable. If follow-up changes are needed, it should be another ticket." He found 13 rows open after the pull request
// that was their deliverable had merged (each kept for a live reading, a decision or a watch), and `worker-4669` held a claim with nothing left to build. `idle-claim-incident.ts`
// sees a CLAIM with no pull request; it cannot see an UNCLAIMED row left open, and it does not read the merge. This leaf is that record.
//
// PURE: rows, pull requests and the clock in, incidents and ledger events out. Which pull request names which row is `acceptance-commands.ts`'s `extractClosesDeclaration` (the
// parser CI and `pr:open` use), so a body is read once and one way; the live read, with its `null` for a population nobody could read, is `org-retro.ts`'s.
import { closesReferences, extractClosesDeclaration } from "./acceptance-commands.ts";
import type { FailureEvent } from "./failure-ledger.ts";
import { ROW_NOT_FINISHABLE } from "./idle-claim-incident.ts";

const MINUTE_MS = 60_000;
const EPIC_LABEL = "epic";

/**
 * M: how long a row may stay open after its deliverable merged before that is an INCIDENT. THE ROW'S FIGURE (#4769), not a derived one: it covers the closer that runs after a
 * bot merge (`close-rows-for-merged-pr.ts`) and the tick that follows it, so what is left open past it is open on purpose or by neglect, and both are the class.
 */
export const MERGED_ROW_OPEN_MINUTES = 30;
export const MERGED_ROW_OPEN_MS = MERGED_ROW_OPEN_MINUTES * MINUTE_MS;

/**
 * One open row. `repo` is the tracker repository it lives in, so `#7` in two trackers are two rows. `claimedBranch` is the claim record's `Claimed-branch:` (`null` for a
 * row nobody claimed, or whose record could not be read).
 */
export type OpenRow = { repo: string, number: number, labels: string[], claimedBranch?: string | null };

/** A pull request, open or merged, in the repository `repo`: a bare `#7` in its body is THAT repository's row 7. `mergedAt` is absent for an open one. */
export type NamingPr = { repo: string, number: number, body?: string | null, headRefName?: string | null, mergedAt?: string | null };

export type MergedRowOpenIncident = { row: OpenRow, pr: NamingPr, openMinutes: number, ref: string };

type RowRef = { repo: string | null, number: number };

const keyOf = ({ repo, number }: { repo: string, number: number }): string => `${repo}#${number}`;

/** `owner/repo#7` or a bare `#7`: the shapes a `Closes: none` reason can name a row in. */
const NAMED_IN_REASON = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g;

function referencesInReason(reason: string): RowRef[] {
  return [...reason.matchAll(NAMED_IN_REASON)].map((match) => ({ repo: match[1] ?? null, number: Number(match[2]) }));
}

/**
 * THE ROWS A PULL REQUEST NAMES AS ITS DELIVERABLE: the `Closes` list, or a `Closes: none` line that names a row in its reason. Nothing else is read: `Refs #7`, `Part of #7`,
 * a row mentioned in prose and a branch are not a declaration, which is the reference-only case that is no incident. A malformed or missing `Closes` names nothing.
 * A bare number is the pull request's own repository's, as GitHub reads it.
 */
function deliverableKeys(pr: NamingPr): Set<string> {
  const declaration = extractClosesDeclaration(pr.body);
  const references: RowRef[] = declaration.kind === "closes" ? closesReferences(declaration) : declaration.kind === "none" ? referencesInReason(declaration.reason) : [];
  return new Set(references.map((reference) => keyOf({ repo: reference.repo ?? pr.repo, number: reference.number })));
}

type ReadPr = { pr: NamingPr, keys: Set<string> };

const readPr = (pr: NamingPr): ReadPr => ({ pr, keys: deliverableKeys(pr) });

/** The pull request is the row's deliverable: it declares the row, or it is the branch the row's claim record names. */
function namesRow({ pr, keys }: ReadPr, row: OpenRow): boolean {
  if (keys.has(keyOf(row))) return true;
  return typeof row.claimedBranch === "string" && row.claimedBranch !== "" && pr.headRefName === row.claimedBranch;
}

/**
 * The newest merge among the pull requests that name `row`, with when it merged. A `mergedAt` that is absent or does not parse is NOT a merge time: absence is not proof, so
 * such a pull request is never the one that decides (it neither makes an incident nor hides one).
 */
function latestMerge({ merged, row }: { merged: ReadPr[], row: OpenRow }): { pr: NamingPr, at: number } | null {
  const named = merged.filter((candidate) => namesRow(candidate, row))
    .map(({ pr }) => ({ pr, at: Date.parse(pr.mergedAt ?? "") }))
    .filter(({ at }) => Number.isFinite(at));
  if (named.length === 0) return null;
  return named.reduce((newest, next) => (next.at > newest.at || (next.at === newest.at && next.pr.number > newest.pr.number) ? next : newest));
}

/**
 * THE INCIDENTS OF ONE READING: one per open row (claimed or not) whose deliverable pull request MERGED more than `MERGED_ROW_OPEN_MINUTES` ago.
 * THE NEWEST NAMING MERGE DECIDES, so a row a second pull request merged for 10 minutes ago is still inside the closer's grace, and its ref names that pull request: a later
 * merge on the same row is a second episode, a standing one is not.
 * NOT AN INCIDENT: an epic (it stays open on purpose, for its children); a row a still-open pull request also names (a second pull request is in flight); a row a merged pull
 * request only REFERS to; a merge at exactly M minutes or inside it.
 * `openPrs` defaults to none, which is a population nobody read as far as this function can tell, so the CALLER owns refusing to ask when it could not read them (`org-retro.ts`).
 */
export function mergedRowOpenIncidents({ rows, mergedPrs, openPrs = [], now }: { rows: OpenRow[], mergedPrs: NamingPr[], openPrs?: NamingPr[], now: number }): MergedRowOpenIncident[] {
  const merged = mergedPrs.map(readPr);
  const open = openPrs.map(readPr);
  return rows.flatMap((row): MergedRowOpenIncident[] => {
    if (row.labels.includes(EPIC_LABEL)) return [];
    if (open.some((candidate) => namesRow(candidate, row))) return [];
    const landed = latestMerge({ merged, row });
    if (landed === null || now - landed.at <= MERGED_ROW_OPEN_MS) return [];
    return [{ row, pr: landed.pr, openMinutes: Math.floor((now - landed.at) / MINUTE_MS), ref: `${keyOf(row)}@${keyOf(landed.pr)}` }];
  });
}

/** The ledger events: one per incident (`recordFailures` skips a (key, ref) already logged, and the ref names the row AND the merge, so one episode is one line). */
export function mergedRowOpenEvents(incidents: MergedRowOpenIncident[]): FailureEvent[] {
  return incidents.map(({ ref }) => ({ classKey: ROW_NOT_FINISHABLE, ref }));
}

const FIRST_REFS = 3;

/** What the daily pass prints: the count and the first three refs (`null` is a read nobody could make, which says `unknown` and never 0). */
export function mergedRowOpenSummary(incidents: MergedRowOpenIncident[] | null | undefined): { count: number, first: string[] } | null {
  if (incidents === null || incidents === undefined) return null;
  return { count: incidents.length, first: incidents.slice(0, FIRST_REFS).map(({ ref }) => ref) };
}
